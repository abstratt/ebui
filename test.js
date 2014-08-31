var server = require("./server.js");
var kirraClient = require("./kirra-client.js");

server.kirraBaseUrl = "http://localhost/services/api-v2/";
server.replyToSender = function(message, errorMessage) { console.log("Not replying to sender with: " + errorMessage  + " - "+ JSON.stringify(message)); }; 
var assert = require("assert");
suite('Server', function() {
    var suite = this; 
    suite.kirra = kirraClient.build("http://localhost/services/api-v2/", 'demo-cloudfier-examples-expenses')
    console.log(suite.kirra);
     
    test('makeEmailForInstance', function(){
        assert.equal("expenses_Employee-2.myapp@inbox.cloudfier.com", server.makeEmailForInstance({entity: 'expenses.Employee', application: 'myapp', instanceId: 2}));
    });
    
    var objectId;
    test('createInstance', function(done) {
        suite.kirra.createInstance({
            entity: 'expenses.Employee', 
            values: { name: "John Doe" }
        }).then(function(instance) {
            done(); 
            assert.equal("John Doe", instance.values.name); 
            objectId = instance.objectId; 
        }, done);
    });
    
    test('updateInstance', function(done) {
        suite.kirra.updateInstance({
            entity: 'expenses.Employee', 
            objectId: objectId,
            values: { name: "John Moe" }
        }).then(function(instance) {
            assert.equal("John Moe", instance.values.name); 
            done(); 
        }, done);
    });
});

