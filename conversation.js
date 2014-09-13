var http = require("http");
var url = require("url");
var q = require('q');
require('array.prototype.find');
var ebuiUtil = require("./util.js");
var yaml = require("js-yaml");
var assert = ebuiUtil.assert;
var merge = ebuiUtil.merge;
var util = require('util');

var Conversation = function (contextMessage, messageStore, emailGateway, kirra) {

    var self = this;
    
    assert(contextMessage);
    assert(kirra);
    assert(emailGateway, "emailGateway missing");
    assert(messageStore, "messageStore missing");
    
    self.start = function() {
        var message = contextMessage;
        message.status = 'Processing';
        message.error = {};
        return messageStore.saveMessage(message).then(function () {
            return kirra.getApplication();
        }).then(function (application) {
            return kirra.getEntity(message.entity);
        }).then(function (entity) {
            var deferred = q.defer();
            var promise = deferred.promise;
            // it is possible the entity was loosely named, force a precise entity name
            message.entity = entity.fullName;
            // it is possible the fields were loosely named, replace with precisely named fields
            var properName = undefined;
            if (message.values) {
                var values = {};
                var links = {};
                var invocations = [];
                var linkResolvers = [];
                var argumentResolvers = [];                
                message_values: for (var key in message.values) {
                    entity_properties: for (var property in entity.properties) {
                        if (ebutil.similarString(key, entity.properties[property], ["name", "label"])) {
                            values[entity.properties[property].name] = message.values[key];
                            continue message_values;
                        }
                    }
                    entity_relationships: for (var r in entity.relationships) {
                        if (ebutil.similarString(key, entity.relationships[r], ["name", "label"])) {
                            linkResolvers.push(self.resolveLooseReference(
                                    entity.relationships[r].typeRef.fullName,
                                    message.values[key],
                                    entity.relationships[r]
                                ));
                            promise = promise.then(function () {
                                return linkResolvers.shift();
                            }).then(function(result) {
                                if (result.matching.length === 0) {
                                    throw new Error("Could not resolve reference: " + result.context.label + " = " + result.value); 
                                }
                                links[result.context.name] = [{ uri: result.matching[0].uri }];
                            });
                            continue message_values;
                        }
                    }
                    entity_actions: for (var o in entity.operations) {
                        var operation = entity.operations[o];
                        if (ebutil.similarString(key, operation, ["name", "label"])) {
                            var invocation = { operation: operation, arguments: message.values[key] };
                            invocations.push(invocation);
                            if (operation.parameters && operation.parameters.length) {
                                if (typeof(invocation.arguments) !== 'object') {
                                    // argument is a single value, convert it to a single-slot object matching the first parameter
                                    var singleArgument = invocation.arguments; 
                                    invocation.arguments = {};
                                    invocation.arguments[operation.parameters[0].name] = singleArgument;
                                }
                                for (var a in invocation.arguments) {
                                    var parameter = operation.parameters.find(function (p) { return p.name === a });
                                    if (parameter && parameter.typeRef.kind === 'Entity') {
                                        // we allow users to refer to other objects based on a string identifying the instance,
                                        // need to resolve to a reference
                                        argumentResolvers.push(self.resolveLooseReference(
                                            parameter.typeRef.fullName,
                                            invocation.arguments[a],
                                            // context needs two coordinates - the invocation, and the argument name
                                            { invocationIndex: invocations.length - 1, argumentName: a }
                                        ));
                                        promise = promise.then(function () {
                                            return argumentResolvers.shift();
                                        }).then(function(result) {
                                            // finally resolve the reference
                                            if (result.matching.length === 0) {
                                                throw new Error("Could not resolve argument: " + result.context.argumentName + " = " + result.value);
                                            }
                                            invocations[result.context.invocationIndex].arguments[result.context.argumentName] = { uri: result.matching[0].uri };
                                        });
                                    }
                                }
                            }
                            continue message_values;
                        }
                    }
                }
                message.values = values;                
                message.links = links;
                message.invocations = invocations;
            }
            deferred.resolve(message);
            return promise.then(function () {
                return messageStore.saveMessage(message); 
            });
        }).then(function(message) {
            return message.objectId ? self.processUpdateMessage(message) : (
                message.query ? self.processQueryMessage(message) : self.processCreationMessage(message)
            );
        }).then(function () { 
            return self.invokePendingActions(message); 
        }, self.onError(message, "Error processing message."));
    };

    
    self.makeEmailForInstance = function(message) {
        return message.entity.replace('.', '_') + '-' + message.objectId + '.' + message.application + '@inbox.cloudfier.com';
    };
    
    self.invokePendingActions = function(message) {
        var invocationConsumer;
        var invocationsAttempted = message.invocations.slice(0);        
        var messageId = message._id;
        var objectId = message.objectId;
        invocationConsumer = function() {
            var nextToInvoke = invocationsAttempted.shift();
            var entity;
            if (!nextToInvoke) {
                return messageStore.getById(messageId);
            }
            var freshInstance;
            return kirra.invokeOperation(
                objectId, nextToInvoke.operation, nextToInvoke.arguments
            ).then(function() {
                return kirra.getInstance(message);
            }).then(function(i) {
                freshInstance = i;
                return kirra.getExactEntity(freshInstance.typeRef.fullName);
            }).then(function(e) {
                entity = e;
                return messageStore.getById(messageId);
            }).then(function(freshMessage) {
                freshMessage.invocationsCompleted.push(nextToInvoke);
                freshMessage.values = freshInstance.values;
                freshMessage.links = freshInstance.links;                
                return messageStore.saveMessage(freshMessage);
            }).then(function(savedMessage) {
                self.sendMessageWithLink(savedMessage, entity, freshInstance, "Message successfully processed. Action " + nextToInvoke.operation.label + " was invoked.");
                return savedMessage;
            }).then(invocationConsumer, self.onError(message, "Error processing your message, action " + nextToInvoke.operation.label + " not performed."));
        };
        message.invocationsCompleted = [];            
        return messageStore.saveMessage(message).then(invocationConsumer);
    };
    
    self.processCreationMessage = function(message) {
        var createdInstance;
        return self.createInstance(message).then(function (instance) {
            createdInstance = instance;
            return kirra.getExactEntity(message.entity);
        }).then(function(entity) {
            message.objectId = createdInstance.objectId;    
            message.values = createdInstance.values;
            message.links = createdInstance.links;
            message.status = "Created";
            return messageStore.saveMessage(message).then(function(savedMessage) {
                self.sendMessageWithLink(savedMessage, entity, createdInstance, "Message successfully processed. Object was created.");
                return savedMessage;
            });
        }, self.onError(message, "Error processing your message, object not created."));
    };

    self.processUpdateMessage = function(message) {
        var updatedInstance;
        return self.updateInstance(message).then(function (instance) {
            updatedInstance = instance;
            return kirra.getExactEntity(message.entity);
        }).then(function (entity) {
            self.sendMessageWithLink(message, entity, updatedInstance, "Message successfully processed. Object was updated.");
            message.status = "Updated";
            message.values = updatedInstance.values;
            message.links = updatedInstance.links;
            return messageStore.saveMessage(message);
        }, self.onError(message, "Error processing your message, object not updated."));
    };
    
    self.processQueryMessage = function(message) {
        var query;
        var entity;
        return kirra.getExactEntity(message.entity).then(function (found) {
            entity = found;
            query = Object.keys(entity.operations).map(function(k) { return entity.operations[k]; }).find(function(op) {
                return !op.instanceOperation && op.kind === "Finder" && ebutil.similarString(message.query, op, ["name", "label"]);
            });
            if (!query) {
                throw new Error("No query '"+ message.query + " in entity '" + entity.label + "'");
            }
            return kirra.findInstances(message.entity, message.query, merge(merge({}, message.values), message.links));
        }).then(function (found) {
            var subject = query.label;
            var userFriendlyData = found.contents.map(function(it) {
                return self.printUserFriendlyInstance(entity, it) + "\n\n" + "Use this link to view it:\n\n" + self.makeLinkForInstance(message, it);
            });
            var dataString = userFriendlyData.join("\n\n--------------------------\n\n");
            var body = "Record(s) found: " + found.length + "\n" + dataString;
            self.replyToSender(message, body, self.makeEmailForInstance(message), subject);
            message.status = "Processed";
            return messageStore.saveMessage(message);
        }, self.onError(message, "Error processing your message, query could not be performed."));
    };
    
    self.makeLinkForInstance = function(message, instance) {
        return kirra.baseUrl + '/kirra-api/kirra_qooxdoo/build/?app-path=/services/api-v2/' + 
            message.application + '#' + encodeURIComponent('/entities/' + message.entity + '/instances/' + instance.objectId);
    };

    
    self.replyToSender = function(message, body, senderEmail, subject) {
        emailGateway.replyToSender(message, body, senderEmail, subject);
    };
    
    self.sendMessageWithLink = function(message, entity, instance, userMessage) {
        self.replyToSender(message, userMessage + "\n" + self.printUserFriendlyInstance(entity, instance) +
            "\n\n-------------------------------\n\n" + "Use this link to view it:\n\n" + self.makeLinkForInstance(entity, instance), self.makeEmailForInstance(message));
    };
    
    self.onError = function(message, errorMessage) {
        return function (e) {
            message.status = "Failure";
            message.error = e;
            console.error(e);
            if (e.stack) {
                console.error(e.stack);
            }
            return messageStore.saveMessage(message).then(function(savedMessage) {
                var reason = typeof(e.message) !== 'object' ? e.message : yaml.safeDump(e.message);
                self.replyToSender(savedMessage, errorMessage + " Reason: " + reason);
                return savedMessage;
            });
        };
    };
    
    self.printUserFriendlyInstance = function(entity, instance) {
        var displayValues = {};
        var properties = entity.properties;
        Object.keys(properties).forEach(function(p) {
            if (properties[p].userVisible && (instance.values[p] !== undefined)) {
                var displayValue = instance.values[p];
                if (properties[p].typeRef.typeName === "Memo") {
                    displayValue = "\n" + displayValue;
                }
                displayValues[properties[p].label] = displayValue;
            }
        });
        var relationships = entity.relationships;
        Object.keys(relationships).forEach(function(r) {
            if (relationships[r].visible && !relationships[r].multiple && instance.links[r] && instance.links[r].length && instance.links[r][0].shorthand) {
                displayValues[relationships[r].label] = instance.links[r][0].shorthand;
            }
        });
        var lines = [];
        Object.keys(displayValues).forEach(function(v) {
            lines.push(v + ": " + displayValues[v]);
        });
        return lines.join("\n");
    };    

    self.resolveLooseReference = function(entityName, value, context) {
        return kirra.getExactEntity(entityName).then(function (entity) {
            var filter = {};
            filter[entity.properties[Object.keys(entity.properties)[0]].name] = value; 
            return kirra.getInstances(entityName, filter).then(function(instances) { 
                return { matching: instances.contents, context: context, value: value }; 
            });
        });
    };
        
    self.createInstance = function(message) {
        var template;
        var entity;
        return kirra.getInstanceTemplate(message.entity).then(function (t) { 
            template = t;
            return kirra.getExactEntity(t.typeRef.fullName);
        }).then(function(e) {
            entity = e;
            for (var p in entity.properties) {
                // fill in an unfulfilled required string property with the subject line if needed
                if (message.subject && !message.values[p] && !template.values[p] && entity.properties[p].typeRef.typeName === "String" && entity.properties[p].required && !entity.properties[p].hasDefault && entity.properties[p].editable) {
                    message.values[p] = message.subject;
                    break;
                }
            }
            for (var p in entity.properties) {
                // fill in an unfulfilled required memo property with the email comment if needed
                if (message.comment && !message.values[p] && !template.values[p] && entity.properties[p].typeRef.typeName === "Memo" && entity.properties[p].required && !entity.properties[p].hasDefault && entity.properties[p].editable) {
                    message.values[p] = message.comment;
                    break;
                }
            }
            return message;
        }).then(function (message) {
		    var mergedValues = merge(merge({}, message.values), template.values);
		    var mergedLinks = merge(merge({}, message.links), template.links);
            return kirra.createInstance(message.entity, mergedValues, mergedLinks);
	    });
    };

    self.updateInstance = function(message) {
        var instance;
        var commentTargetRelationship;
        return self.getInstance(message).then(function (i) {
            instance = i;
            return message.comment ? self.findCommentTargetChildRelationship(message.entity) : undefined;
        }).then(function (childRelationship) {
            commentTargetRelationship = childRelationship;
            return message;
        }).then(function (message) {
		    var mergedValues = merge(merge({}, message.values), instance.values);
		    var mergedLinks = merge(merge({}, message.links), instance.links);
		    return kirra.updateInstance(message.entity, message.objectId, mergedValues, mergedLinks);
	    }).then(function(parentInstance) {
	        if (commentTargetRelationship) {
	            var commentTargetEntityName = commentTargetRelationship.relationship.typeRef.fullName;
	            var links = {};
	            links[commentTargetRelationship.relationship.opposite] = [{uri: parentInstance.uri}];
	            var values = {};
	            values[commentTargetRelationship.commentProperty.name] = message.comment;
	            return kirra.getInstanceTemplate(commentTargetEntityName).then(function (template) {
	                var mergedValues = merge(merge({}, values), template.values);
        		    var mergedLinks = merge(merge({}, links), template.links);
                    return kirra.createInstance(commentTargetEntityName, mergedValues, mergedLinks);
                });    
	        }
            return parentInstance;
	    });
    };
    
    self.findCommentTargetChildRelationship = function (parentEntityName) {
        return kirra.getExactEntity(parentEntityName).then(function (e) {
            var childRelationships = Object.keys(e.relationships).map(function (k) { 
                return e.relationships[k]; 
            }).filter(function (r) {
                return r.style === "CHILD"
            });
            // now find the first child relationship that has a comment-like entity 
            // (only required field is a Memo field or there are no required fields and there is at least one Memo field)
            var finder = function () {
                var currentRelationship = childRelationships.shift();
                if (!currentRelationship) {
                    return q.thenResolve(undefined);
                }
                return kirra.getExactEntity(currentRelationship.typeRef.fullName).then(function(childEntity) {
                    var properties = Object.keys(childEntity.properties).map(function (k) { 
                        return childEntity.properties[k]; 
                    });
                    var memoProperties = properties.filter(function (p) { 
                        return p.typeRef.typeName === 'Memo' && p.userVisible && (p.initializable || p.editable); 
                    });
                    // TODO valid concern, but needs more work 
                    /*
                    var requiredProperties = properties.filter(function (p) { 
                        return p.required && !p.hasDefault; 
                    });
                    var hasRequiredRelationships = Object.keys(childEntity.relationships).find(function (k) { 
                        return childEntity.relationships[k].required && !(childEntity.relationships[k].typeRef.fullName === parentEntityName); 
                    });
                    if (hasRequiredRelationships) {
                        return finder();
                    }
                    if (requiredProperties.length > 1) {
                        return finder();
                    }
                    if (requiredProperties.length === 1 && requiredProperties[0].typeRef.typeName !== 'Memo') {
                        return finder();
                    }
                    */
                    if (memoProperties.length === 0) {
                        return finder();
                    }
                    return { relationship: currentRelationship, commentProperty: memoProperties[0]};          
                });
            };
            return finder();
        });
    };


    self.getInstance = function(message) {
        return kirra.getInstance(message.entity, message.objectId);
    };

    self.getInstanceTemplate = function(message) {
        return kirra.getInstanceTemplate(message.entity);
    };

    return self;
};

var exports = module.exports = Conversation;
