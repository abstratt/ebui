require('array.prototype.find');
var q = require('q');
var util = require('util');

var yaml = require("js-yaml");
var url = require("url");

var Kirra = require("./kirra-client.js");
var Conversation = require("./conversation.js");
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
            if (isNaN(elements[2])) {
                if (elements[2] === 'report') {
                    message.query = message.subject;
                }
            } else {
                message.objectId = elements[2];            
            }
            message.application = elements[3];
        }
        return message;

    };
    
    self.processPendingMessage = function (message) {
        self.parseMessage(message);
        if (!message.application) {
            message.status = 'Invalid';
            self.replyToSender(message, "Unfortunately, your message could not be processed. " + message.error);
            return messageStore.saveMessage(message).then(function() { return message; });    
        }
        var kirraApp = new Kirra(kirraApiUrl, message.application, message.fromEmail);
        
        return new Conversation(message, messageStore, emailGateway, kirraApp).start();
    };
    

    self.replyToSender = function(message, body, senderEmail) {
        emailGateway.replyToSender(message, body, senderEmail);
    };
    
    return self;
};


var exports = module.exports = MessageProcessor;
