var yaml = require("js-yaml");
var url = require("url");

var Kirra = require("./kirra-client.js");
var ebuiUtil = require("./util.js");

var assert = ebuiUtil.assert;
var merge = ebuiUtil.merge;

var MessageProcessor = function (emailGateway, messageStore, kirraBaseUrl) {
    var self = this;
    
    assert(emailGateway, "emailGateway missing");
    assert(messageStore, "messageStore missing");
    assert(kirraBaseUrl, "kirraBaseUrl missing");
    
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
        var values = yaml.safeLoad(processingRules.join('\n'));
        message.comment = comment;
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

    self.processPendingMessage = function (message) {
        self.parseMessage(message);
        if (!message.application) {
            message.status = 'Invalid';
            emailGateway.replyToSender(message, "Unfortunately, your message could not be processed.");
            return messageStore.saveMessage(message).then(function() { return message; });    
        }
        var kirraApp = new Kirra(kirraBaseUrl, message.application);
        message.status = 'Processing';
        return messageStore.saveMessage(message).then(function () {
            return kirraApp.getApplication();
        }).then(function () {
            return kirraApp.getEntity(message.entity);
        }).then(function (entity) {
            // it is possible the entity was losely named, force a precise entity name
            message.entity = entity.fullName;
            if (message.objectId) {
                return self.processUpdateMessage(kirraApp, message);
            } else {
                return self.processCreationMessage(kirraApp, message);
            }
        }, self.onError(message, "Invalid application")).then(
            function() { return message; }
        );
    };
    
    self.makeEmailForInstance = function(message) {
        return message.entity.replace('.', '_') + '-' + message.objectId + '.' + message.application + '@inbox.cloudfier.com';
    };

    self.processCreationMessage = function(kirraApp, message) {
        return kirraApp.createInstance(message).then(function (d) {
            message.objectId = d.objectId;	
            message.status = "Created";
            self.replyToSender(message, "Message successfully processed. Object was created.\n" + yaml.safeDump(d.values, { skipInvalid: true }), self.makeEmailForInstance(message));
            self.messageStore.saveMessage(message).then(function() { return d; });
        }, self.onError(message, "Error processing your message, object not created."));
    };

    self.processUpdateMessage = function(kirraApp, message) {
        return kirraApp.updateInstance(message).then(function (d) {
	        self.replyToSender(message, "Message successfully processed. Object was updated.\n" + yaml.safeDump(d.values, { skipInvalid: true }), self.makeEmailForInstance(message));
	        message.status = "Updated";
	        return self.messageStore.saveMessage(message).then(function() { return d; });
        }, self.onError(message, "Error processing your message, object not updated."));
    };
    
    self.replyToSender = function(message, body, senderEmail) {
        emailGateway.replyToSender(message, body, senderEmail);
    };
    
    self.onError = function(message, errorMessage) {
	    return function (e) {
		    message.status = "Failure";
		    message.error = e;
		    messageStore.saveMessage(message);
	        self.replyToSender(message, errorMessage + " Reason: " + e.message);
	        return message;
	    };
    };  
    
    return self;
};


var exports = module.exports = MessageProcessor;
