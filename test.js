var util = require("util");
var Kirra = require("./kirra-client.js");
var MessageProcessor = require("./message-processor.js");
var MessageStore = require("./message-store.js");

var kirraBaseUrl = "http://localhost/services/api-v2/";
var assert = require("assert");
var kirraApplicationId = 'demo-cloudfier-examples-expenses';
var kirraEntity = 'expenses.Employee';

suite('EBUI', function() {
    var messageStore = new MessageStore('localhost', 27017, 'testdb', '', '');
    var collectedUserNotifications = [];
    var emailGateway = { replyToSender : function(message, errorMessage) { 
        collectedUserNotifications.push({ errorMessage: errorMessage, message: message });
    } }; 

    suite('Kirra Client', function() {
        var suite = this;
        suite.kirra = new Kirra("http://localhost/services/api-v2/", kirraApplicationId)
        
        var objectId;
        test('createInstance', function(done) {
            suite.kirra.createInstance({
                entity: 'expenses.Employee', 
                values: { name: "John Doe" }
            }).then(function(instance) {
                objectId = instance.objectId; 
                assert.equal("John Doe", instance.values.name); 
            }).then(done, done);
        });
        
        test('updateInstance', function(done) {
            suite.kirra.updateInstance({
                entity: 'expenses.Employee', 
                objectId: objectId,
                values: { name: "John Moe" }
            }).then(function(instance) {
                assert.equal("John Moe", instance.values.name); 
            }).then(done, done);
        });
    });

    suite('MessageProcessor', function() {
    
        var messageProcessor = new MessageProcessor(emailGateway, messageStore, kirraBaseUrl);
        
        test('makeEmailForInstance', function(){
            assert.equal("expenses_Employee-2.myapp@inbox.cloudfier.com", messageProcessor.makeEmailForInstance({entity: 'expenses.Employee', application: 'myapp', instanceId: 2}));
        });
        
        test('processPendingMessage - invalid', function(done) {
            messageStore.saveMessage({ }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal("Invalid", m.status);
            }).then(done, done);
        });
        
        test('processPendingMessage - valid', function(done) {
            messageStore.saveMessage({ application : kirraApplicationId, entity : kirraEntity, values: { name: "John Bonham"} }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal("Processed", m.status);
            }).then(done, done);
        });

        test('parseMessage - entity account', function() {
            var message = { 
                account : 'namespace_Entity.myapplication@domain',
                text: 'This is a message'
            };
            messageProcessor.parseMessage(message);
            assert.equal("myapplication", message.application);
            assert.equal("namespace.Entity", message.entity);
            assert.equal(undefined, message.instanceId);
        });
        
        test('parseMessage - instance account', function() {
            var message = { 
                account : 'namespace_Entity-1234.myapplication@domain',
                text: 'This is a message'
            };
            messageProcessor.parseMessage(message);
            assert.equal("myapplication", message.application);
            assert.equal("namespace.Entity", message.entity);
            assert.equal('1234', message.instanceId);
        });
        
        test('parseMessage - values', function() {
            var message = { 
                account : 'namespace_Entity-myapplication@domain',
                subject: 'subject',
                text: 'Line 1\nLine 2\n--\nField1: value1\nField2: value2\n'
            };
            messageProcessor.parseMessage(message);
            assert.ok(message.values);
            assert.equal("value1", message.values.Field1);
            assert.equal("value2", message.values.Field2);
            assert.equal("Line 1\nLine 2\n", message.comment);
        });
        
        test('parseMessage - values mixed with comment', function() {
            var message = { 
                account : 'namespace_Entity-myapplication@domain',
                subject: 'subject',
                text: 'Line 1\nLine 2\n--\nField1: value1\nField2: value2\n--\nLine 3\nLine 4'
            };
            messageProcessor.parseMessage(message);
            assert.ok(message.values);
            assert.equal("value1", message.values.Field1);
            assert.equal("value2", message.values.Field2);
            assert.equal("Line 1\nLine 2\nLine 3\nLine 4\n", message.comment);            
        });
    });
});
