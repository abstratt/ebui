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
            console.error("Could not parse string as YAML: "+ processingRules.join('\n') + "- reason: " + e.message);
            return message;
        }
        message.comment = comment.trim();
        message.subject = message.subject ? message.subject.trim() : '';
        message.values = merge(merge({}, values), message.values);
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
            emailGateway.replyToSender(message, "Unfortunately, your message could not be processed.");
            return messageStore.saveMessage(message).then(function() { return message; });    
        }
        var kirraApp = new Kirra(kirraApiUrl, message.application);
        message.status = 'Processing';
        message.error = {};
        return messageStore.saveMessage(message).then(function () {
            return kirraApp.getApplication();
        }).then(function () {
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
                            var operationArguments = message.values[key];
                            invocations.push({ operation: operation, arguments: operationArguments });
                            for (var a in operationArguments) {
                                var parameter = operation.parameters.find(function (p) { return p.name === a });
                                if (parameter && parameter.typeRef.kind === 'Entity') {
                                    argumentResolvers.push(self.resolveLooseReference(
                                        kirraApp,
                                        parameter.typeRef.fullName,
                                        operationArguments[a],
                                        // context needs two coordinates - the invocation, and the argument name
                                        { invocationIndex: invocations.length - 1, argumentName: a }
                                    ));
                                    promise = promise.then(function () {
                                        return argumentResolvers.shift();
                                    }).then(function(result) {
                                        invocations[result.context.invocationIndex].arguments[result.context.argumentName] = { uri: result.matching[0].uri };
                                    });
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
            if (!nextToInvoke) {
                return self.messageStore.getById(messageId);
            }
            return kirraApp.invokeOperation(
                objectId, nextToInvoke.operation, nextToInvoke.arguments
            ).then(function() {
                return self.messageStore.getById(messageId);
            }).then(function(message) {
                message.invocationsCompleted.push(nextToInvoke);                            
    	        kirraApp.getInstance(message).then(function(instance) {
    	            self.sendMessageWithLink(message, instance, "Message successfully processed. Action " + justInvoked.operation.label + " was invoked.");
	            });
                return self.messageStore.saveMessage(message);
            }).then(invocationConsumer, self.onError(message, "Error processing your message, action " + nextToInvoke.operation.label + " not performed"));
        };
        message.invocationsCompleted = [];            
        return self.messageStore.saveMessage(message).then(invocationConsumer);
    };
    
    self.processCreationMessage = function(kirraApp, message) {
        return kirraApp.createInstance(message).then(function (instance) {
            createdInstance = instance;
            message.objectId = instance.objectId;	
            message.values = instance.values;
            message.links = instance.links;
            message.status = "Created";
	        self.sendMessageWithLink(message, instance, "Message successfully processed. Object was created.");
            return self.messageStore.saveMessage(message).then(function(savedMessage) { return savedMessage; });
        }, self.onError(message, "Error processing your message, object not created."));
    };

    self.processUpdateMessage = function(kirraApp, message) {
        return kirraApp.updateInstance(message).then(function (instance) {
	        self.sendMessageWithLink(message, instance, "Message successfully processed. Object was updated.");
	        message.status = "Updated";
            message.values = instance.values;
            message.links = instance.links;
	        return self.messageStore.saveMessage(message);
        }, self.onError(message, "Error processing your message, object not updated."));
    };
    
    self.replyToSender = function(message, body, senderEmail) {
        emailGateway.replyToSender(message, body, senderEmail);
    };
    
    self.sendMessageWithLink = function(message, instance, userMessage) {
        self.replyToSender(message, userMessage + "\n" + yaml.safeDump(instance.values, { skipInvalid: true }) +
            "Use the URL below to access this object:\n\n" +
            kirraBaseUrl + '/kirra-api/kirra_qooxdoo/build/?app-path=/services/api-v2/' + 
            message.application + '#' + encodeURIComponent('/entities/' + message.entity + '/instances/' + message.objectId), self.makeEmailForInstance(message));
    };
    
    self.onError = function(message, errorMessage) {
	    return function (e) {
	        console.error(e);
		    message.status = "Failure";
		    message.error = e;
		    message = messageStore.saveMessage(message);
	        self.replyToSender(message, errorMessage + " Reason: " + e.message);
	        return message;
	    };
    };  
    
    return self;
};


var exports = module.exports = MessageProcessor;
