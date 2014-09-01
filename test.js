var server = require("./server.js");
var util = require("util");
var kirraClient = require("./kirra-client.js");

server.kirraBaseUrl = "http://localhost/services/api-v2/";
var assert = require("assert");
var kirraApplicationId = 'demo-cloudfier-examples-expenses';
var kirraEntity = 'expenses.Employee';
suite('Server', function() {
    var collectedUserNotifications = [];
    server.replyToSender = function(message, errorMessage) { 
        collectedUserNotifications.push({ errorMessage: errorMessage, message: message });
    }; 
    var suite = this; 
    suite.kirra = kirraClient.build("http://localhost/services/api-v2/", kirraApplicationId)
     
    test('makeEmailForInstance', function(){
        assert.equal("expenses_Employee-2.myapp@inbox.cloudfier.com", server.makeEmailForInstance({entity: 'expenses.Employee', application: 'myapp', instanceId: 2}));
    });
    
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
    
    test('processPendingMessage - invalid', function(done) {
        server.messageStore.saveMessage({ }).then(function (m) {
            return server.processPendingMessage(m);
        }).then(function(m) {
            assert.equal("Invalid", m.status);
        }).then(done, done);
    });
    
    test('processPendingMessage - valid', function(done) {
        server.messageStore.saveMessage({ application : kirraApplicationId, entity : kirraEntity, values: { name: "John Bonham"} }).then(function (m) {
            return server.processPendingMessage(m);
        }).then(function(m) {
            assert.equal("Processed", m.status);
        }).then(done, done);
    });

});

