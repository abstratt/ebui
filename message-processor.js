require('array.prototype.find');
var q = require('q');
var util = require('util');

var yaml = require("js-yaml");
var url = require("url");

var Kirra = require("./kirra-client.js");
var ebuiUtil = require("./util.js");

var assert = ebuiUtil.assert;
var merge = ebuiUtil.merge;

var MessageProcessor = function (emailGateway, messageStore, kirraBaseUrl, kirraApiUrl) {
    var self = this;
    
    assert(emailGateway, "emailGateway missing");
    assert(messageStore, "messageStore missing");
    assert(kirraBaseUrl, "kirraBaseUrl missing");
    assert(kirraApiUrl, "kirraApiUrl missing");
    
    self.messageStore = messageStore;
    self.emailGateway = emailGateway;
    
    self.parseMessage = function (message) {
        var text = message.text;
        var comment = '';
        var processingRules = [];
        var isProcessing = false;
        if (text) {
            text.split("\n").forEach(function (current) {        
                if (isProcessing) {
                    if (current.indexOf('--') === 0) {
                        isProcessing = false;
                    } else {
                        processingRules.push(current);
                    }
                } else {
                    if (current.indexOf('--') === 0) {
                        isProcessing = true;
                    } else {
                        comment += current + '\n';
                    }
                }
            });
        }
        var values;
        try {
            values = yaml.safeLoad(processingRules.join('\n'));
        } catch(e) {
            var errorMessage = "Could not parse string as YAML: "+ processingRules.join('\n') + "- reason: " + e.message;
            console.error(errorMessage);
            message.error = { message: errorMessage };
            return message;
        }
        message.comment = comment.trim();
        message.subject = message.subject ? message.subject.trim() : '';
        message.values = merge(merge({}, values), message.values);
        message.invocations = [];
        // (entity)(-objectId)?.(application)@<domain>
        //  Examples: issue.my-application@foo.bar.com and issue-43234cc221ad.my-application@foo.bar.com
        var elements = /^([a-z_A-Z]+)(?:-([^.]+))?\.([^@^.]+)@.*$/.exec(message.account);
        if (elements !== null) {
            message.entity = elements[1].replace("_", ".");
            message.objectId = elements[2];
            message.application = elements[3];
        }
        return message;

    };
    
    self.resolveLooseReference = function(kirraApp, entityName, value, context) {
        return kirraApp.getExactEntity(entityName).then(function (entity) {
            var filter = {};
            filter[entity.properties[Object.keys(entity.properties)[0]].name] = value; 
            return kirraApp.getInstances(entityName, filter).then(function(instances) { 
                return { matching: instances.contents, context: context }; 
            });
        });
    };

    self.processPendingMessage = function (message) {
        self.parseMessage(message);
        if (!message.application) {
            message.status = 'Invalid';
            self.replyToSender(message, "Unfortunately, your message could not be processed. " + message.error);
            return messageStore.saveMessage(message).then(function() { return message; });    
        }
        var kirraApp = new Kirra(kirraApiUrl, message.application, message.fromEmail);
        message.status = 'Processing';
        message.error = {};
        return messageStore.saveMessage(message).then(function () {
            return kirraApp.getApplication();
        }).then(function (application) {
            return kirraApp.getEntity(message.entity);
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
                        if (entity.properties[property].name.toUpperCase() === key.toUpperCase() || entity.properties[property].label.toUpperCase() === key.toUpperCase()) {
                            values[entity.properties[property].name] = message.values[key];
                            continue message_values;
                        }
                    }
                    entity_relationships: for (var r in entity.relationships) {
                        if (entity.relationships[r].name.toUpperCase() === key.toUpperCase() || entity.relationships[r].label.toUpperCase() === key.toUpperCase()) {
                            linkResolvers.push(self.resolveLooseReference(
                                    kirraApp,
                                    entity.relationships[r].typeRef.fullName,
                                    message.values[key],
                                    entity.relationships[r]
                                ));
                            promise = promise.then(function () {
                                return linkResolvers.shift();
                            }).then(function(result) {
                                links[result.context.name] = [{ uri: result.matching[0].uri }];
                            });
                            continue message_values;
                        }
                    }
                    entity_actions: for (var o in entity.operations) {
                        var operation = entity.operations[o];
                        if (operation.name.toUpperCase() === key.toUpperCase() || operation.label.toUpperCase() === key.toUpperCase()) {
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
                                            kirraApp,
                                            parameter.typeRef.fullName,
                                            invocation.arguments[a],
                                            // context needs two coordinates - the invocation, and the argument name
                                            { invocationIndex: invocations.length - 1, argumentName: a }
                                        ));
                                        promise = promise.then(function () {
                                            return argumentResolvers.shift();
                                        }).then(function(result) {
                                            // finally resolve the reference
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
            return (message.objectId ? 
                self.processUpdateMessage(kirraApp, message) :
                self.processCreationMessage(kirraApp, message)
            );
        }).then(function () { 
            return self.invokePendingActions(kirraApp, message); 
        }, self.onError(message, "Invalid application."));
    };
    
    self.makeEmailForInstance = function(message) {
        return message.entity.replace('.', '_') + '-' + message.objectId + '.' + message.application + '@inbox.cloudfier.com';
    };
    
    self.invokePendingActions = function(kirraApp, message) {
        var invocationConsumer;
        var invocationsAttempted = message.invocations.slice(0);        
        var messageId = message._id;
        var objectId = message.objectId;
        invocationConsumer = function() {
            var nextToInvoke = invocationsAttempted.shift();
            var entity;
            if (!nextToInvoke) {
                return self.messageStore.getById(messageId);
            }
            var freshInstance;
            return kirraApp.invokeOperation(
                objectId, nextToInvoke.operation, nextToInvoke.arguments
            ).then(function() {
                return kirraApp.getInstance(message);
            }).then(function(i) {
                freshInstance = i;
                return kirraApp.getExactEntity(freshInstance.typeRef.fullName);
            }).then(function(e) {
                entity = e;
                return self.messageStore.getById(messageId);
            }).then(function(freshMessage) {
                freshMessage.invocationsCompleted.push(nextToInvoke);
                freshMessage.values = freshInstance.values;
                freshMessage.links = freshInstance.links;                
                return self.messageStore.saveMessage(freshMessage);
            }).then(function(savedMessage) {
                self.sendMessageWithLink(savedMessage, entity, freshInstance, "Message successfully processed. Action " + nextToInvoke.operation.label + " was invoked.");
                return savedMessage;
            }).then(invocationConsumer, self.onError(message, "Error processing your message, action " + nextToInvoke.operation.label + " not performed."));
        };
        message.invocationsCompleted = [];            
        return self.messageStore.saveMessage(message).then(invocationConsumer);
    };
    
    self.processCreationMessage = function(kirraApp, message) {
        var createdInstance;
        return kirraApp.createInstance(message).then(function (instance) {
            createdInstance = instance;
            return kirraApp.getExactEntity(instance.typeRef.fullName);
        }).then(function(entity) {
            message.objectId = createdInstance.objectId;    
            message.values = createdInstance.values;
            message.links = createdInstance.links;
            message.status = "Created";
            return self.messageStore.saveMessage(message).then(function(savedMessage) {
                self.sendMessageWithLink(savedMessage, entity, createdInstance, "Message successfully processed. Object was created.");
                return savedMessage;
            });
        }, self.onError(message, "Error processing your message, object not created."));
    };

    self.processUpdateMessage = function(kirraApp, message) {
        var updatedInstance;
        return kirraApp.updateInstance(message).then(function (instance) {
            updatedInstance = instance;
            return kirraApp.getExactEntity(instance.typeRef.fullName);
        }).then(function (entity) {
            self.sendMessageWithLink(message, entity, updatedInstance, "Message successfully processed. Object was updated.");
            message.status = "Updated";
            message.values = updatedInstance.values;
            message.links = updatedInstance.links;
            return self.messageStore.saveMessage(message);
        }, self.onError(message, "Error processing your message, object not updated."));
    };
    
    self.replyToSender = function(message, body, senderEmail) {
        emailGateway.replyToSender(message, body, senderEmail);
    };
    
    self.sendMessageWithLink = function(message, entity, instance, userMessage) {
        self.replyToSender(message, userMessage + "\n" + self.printUserFriendlyInstance(entity, instance) +
            "\n\n-------------------------------\n\nUse this link to edit it:\n\n" +
            kirraBaseUrl + '/kirra-api/kirra_qooxdoo/build/?app-path=/services/api-v2/' + 
            message.application + '#' + encodeURIComponent('/entities/' + message.entity + '/instances/' + message.objectId), self.makeEmailForInstance(message));
    };
    
    self.onError = function(message, errorMessage) {
        return function (e) {
            console.error(e);
            message.status = "Failure";
            message.error = e;
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
    
    return self;
};


var exports = module.exports = MessageProcessor;
