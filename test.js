var Kirra = require("./kirra-client.js");
var MessageProcessor = require("./message-processor.js");
var MessageStore = require("./message-store.js");
var MandrillGateway = require("./mandrill-gateway.js");
var util = require('util');

var assert = require("assert");
var kirraApplicationId = 'test-cloudfier-examples-expenses';
var kirraEntity = 'expenses.Employee';

suite('EBUI', function() {
    var kirraBaseUrl = process.env.KIRRA_BASE_URL || "http://develop.cloudfier.com/";
    var kirraApiUrl = process.env.KIRRA_API_URL || (kirraBaseUrl + "services/api-v2/");
    var kirra = new Kirra(kirraApiUrl, kirraApplicationId);
    this.timeout(30000);
    var messageStore = new MessageStore('localhost', 27017, 'testdb', '', '');
    var collectedUserNotifications = [];
    var emailGateway = { replyToSender : function(message, errorMessage) { 
        collectedUserNotifications.push({ errorMessage: errorMessage, message: message });
    } }; 

    suite('Kirra Client', function() {

        test('getApplication', function(done) {
            kirra.getApplication().then(function(application) {
                assert.equal("Expenses Application", application.applicationName); 
            }).then(done, done);
        });

        var created;
        test('createInstance', function(done) {
            kirra.createInstance({
                entity: 'expenses.Employee', 
                values: { name: "John Doe" }
            }).then(function(instance) {
                created = instance; 
                assert.equal(instance.values.name, "John Doe"); 
            }).then(done, done);
        });
        
        
        test('getInstance', function(done) {
            assert.ok(created);
            kirra.getInstance({
                entity: 'expenses.Employee', 
                objectId: created.objectId
            }).then(function(instance) {
                assert.equal(instance.values.name, "John Doe"); 
            }).then(done, done);
        });
        
        test('updateInstance', function(done) {
            assert.ok(created);
            kirra.updateInstance({
                entity: 'expenses.Employee', 
                objectId: created.objectId,
                values: { name: "John Moe" }
            }).then(function(instance) {
                assert.equal(instance.values.name, "John Moe"); 
            }).then(done, done);
        });
        

        test('getInstances', function(done) {
            var suffix = Math.random();
            kirra.createInstance({
                entity: 'expenses.Employee', 
                values: { name: "John Doe" + suffix }
            }).then(function(instance) {
                created = instance;
                return kirra.getInstances('expenses.Employee', { name: created.values.name });
            }).then(function(instances) {
                assert.equal(instances.contents.length, 1);
                assert.equal(instances.contents[0].uri, created.uri); 
            }).then(done, done);
        });
        
        
        test('createComplexInstance', function(done) {
            var category, employee, expense;
            kirra.createInstance({
                entity: 'expenses.Category', 
                values: { name: "Totally different category" }
            }).then(function(instance) {
                category = instance;
                return kirra.createInstance({
                    entity: 'expenses.Employee', 
                    values: { name: "A new employee" }
                });
            }).then(function(instance) {
                employee = instance;
                var values = {
                    description: "Trip to Timbuktu", 
                    amount: 205.45, 
                    date: "2014/09/21", 
                };
                var links = {
                    category: [{ uri: category.uri }],
                    employee: [{ uri: employee.uri }], 
                };
                return kirra.createInstance({
                    entity: 'expenses.Expense', 
                    values: values,
                    links: links
                });
            }).then(function(instance) {
                expense = instance; 
                assert.equal(instance.values.description, "Trip to Timbuktu"); 
                assert.ok(instance.links.category);
                assert.equal(instance.links.category.length, 1);
                assert.equal(instance.links.category[0].uri, category.uri);
                assert.ok(instance.links.employee);
                assert.equal(instance.links.employee.length, 1);                
                assert.equal(instance.links.employee[0].uri, employee.uri);
            }).then(done, done);
        });
        
        test('invokeOperation', function(done) {
            var employeeEntity;
            var category, employee, expense;
            kirra.createInstance({
                entity: 'expenses.Category', 
                values: { name: "Totally different category" }
            }).then(function(instance) {
                category = instance;
                return kirra.createInstance({
                    entity: 'expenses.Employee', 
                    values: { name: "A new employee" }
                });
            }).then(function(instance) {
                employee = instance;
                return kirra.getExactEntity('expenses.Employee');
            }).then(function(entity) {
                employeeEntity = entity;                
            }).then(function() {
                var arguments = {
                    description: "Trip to Timbuktu", 
                    amount: 205.45, 
                    date: "2014/09/21", 
                    category: { uri: category.uri }
                };
                return kirra.invokeOperation(employee.objectId, employeeEntity.operations.declareExpense, arguments);
            }).then(function(instance) {
                return kirra.getRelatedInstances("expenses.Employee", employee.objectId, "recordedExpenses");
            }).then(function(instances) {
                assert.equal(instances.length, 1);                
            }).then(done, done);
        });
    });
    
    

    suite('MandrillGateway', function() {
        var mandrillGateway = new MandrillGateway();
        test('handleInboundEmail', function() {
            var events = [
                {
                    msg: {
                        email: "inbox@domain.com",
                        from_email: "fromEmail@domain.com",
                        from_name: "From Name",
                        from_email: "fromEmail@domain.com",                        
                        to: "toEmail@domain.com",                        
                        subject: "This is the subject",                                                
                        text: "Line 1\nLine 2\nLine 3",
                        headers: {
                            "Message-Id" : "message-id"
                        }   
                    }
                }
            ];
            var req = { body: { mandrill_events: JSON.stringify(events) } };
            var res = { send: function(status) { this.status = status; } };
            var messageStore = { messages : [], saveMessage : function (message) { this.messages.push(message); } };
            mandrillGateway.handleInboundEmail(req, res, messageStore);
            assert.equal(1, messageStore.messages.length);
            var message = messageStore.messages[0];
            assert.equal("Pending", message.status);                                                                                    
            assert.equal("fromEmail@domain.com", message.fromEmail);            
            assert.equal("From Name", message.fromName);            
            assert.equal("inbox@domain.com", message.account);            
            assert.equal("toEmail@domain.com", message.toEmail);            
            assert.equal("This is the subject", message.subject);                                                            
            assert.equal("Line 1\nLine 2\nLine 3", message.text);                                                                        
            assert.equal("message-id", message._contextMessageId);                                                                                    
            assert.equal(204, res.status);            
        });
    
    });
    
    suite('MessageStore', function() {
        var messageDocumentId;
        test('simple creation', function(done){
            messageStore.saveMessage({ }).then(
                function (m) { 
                    assert.ok(m._id);
                    messageDocumentId = m._id;
                }
            ).then(done, done);
        });
        test('lookUp', function(done){
            messageStore.getById(messageDocumentId).then(
                function (m) { 
                    assert.ok(m);
                    assert.equal(messageDocumentId.toString(), m._id.toString());                    
                }
            ).then(done, done);
        });

    });

    suite('MessageProcessor', function() {
    
        var messageProcessor = new MessageProcessor(emailGateway, messageStore, kirraBaseUrl, kirraApiUrl);
        
        test('makeEmailForInstance', function(){
            assert.equal("expenses_Employee-2.myapp@inbox.cloudfier.com", messageProcessor.makeEmailForInstance({entity: 'expenses.Employee', application: 'myapp', objectId: 2}));
        });
        
        test('processPendingMessage - invalid', function(done) {
            messageStore.saveMessage({ }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Invalid");
            }).then(done, done);
        });
        
        test('processPendingMessage - simple creation', function(done) {
            messageStore.saveMessage({ application : kirraApplicationId, entity : kirraEntity, values: { name: "John Bonham"} }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Created");
                assert.equal(m.values.totalSubmitted, 0);
            }).then(done, done);
        });
        
        test('processPendingMessage - using subject', function(done) {
            messageStore.saveMessage({ application : kirraApplicationId, entity : kirraEntity, subject: "John Bonham" }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Created");
                assert.equal(m.values.name, "John Bonham");
            }).then(done, done);
        });
        
        test('processPendingMessage - creation of complex instance', function(done) {
            var category, employee;
            kirra.createInstance({
                entity: 'expenses.Category', 
                values: { name: "Totally different category" + Math.random() }
            }).then(function(instance) {
                category = instance;
                return kirra.createInstance({
                    entity: 'expenses.Employee', 
                    values: { name: "A new employee" + Math.random() }
                });
            }).then(function(instance) {
                employee = instance;
                var values = {
                    description: "Trip to Timbuktu", 
                    amount: 205.45, 
                    date: "2014/09/21", 
                    category: category.values.name,
                    employee: employee.values.name 
                };
                return messageStore.saveMessage({
                    application : kirraApplicationId,
                    entity: 'expenses.Expense', 
                    values: values
                });                    
            }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Created");
                assert.equal(m.values.description, "Trip to Timbuktu");
                assert.ok(m.links.category);
                assert.equal(m.links.category.length, 1);
                assert.equal(m.links.category[0].uri, category.uri);
                assert.ok(m.links.employee);
                assert.equal(m.links.employee.length, 1);                
                assert.equal(m.links.employee[0].uri, employee.uri);
            }).then(done, done);
        });
        
        test('processPendingMessage - creation with incomplete entity', function(done) {
            messageStore.saveMessage({ application : kirraApplicationId, entity : 'employee', values: { name: "John Bonham"} }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Created");
                assert.equal(m.entity, "expenses.Employee");
            }).then(done, done);
        });
        
        test('processPendingMessage - update', function(done) {
            kirra.createInstance({
                entity: 'expenses.Employee', 
                values: { name: "John Doe" }
            }).then(function(instance) {
                var message = { objectId: instance.objectId, application : kirraApplicationId, entity : kirraEntity, values: instance.values };
                return messageStore.saveMessage(message).then(function() { return message; });
            }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Updated");
            }).then(done, done);
        });
        
        test('processPendingMessage - two actions in a row', function(done) {
            var category, employee, expense;
            kirra.createInstance({
                entity: 'expenses.Category', 
                values: { name: "Totally different category" + Math.random() }
            }).then(function(instance) {
                category = instance;
                return kirra.createInstance({
                    entity: 'expenses.Employee', 
                    values: { name: "A new employee" + Math.random() }
                });
            }).then(function(instance) {
                employee = instance;
                var values = {
                    description: "Trip to Timbuktu", 
                    amount: 205.45, 
                    date: "2014/09/21", 
                };
                var links = {
                    category: [{ uri: category.uri }],
                    employee: [{ uri: employee.uri }], 
                };
                return kirra.createInstance({
                    entity: 'expenses.Expense', 
                    values: values,
                    links: links
                });            
            }).then(function (instance) {
                expense = instance;
                assert.equal(expense.values.status, "Draft");    
                var message = { objectId: expense.objectId, application : kirraApplicationId, entity : expense.typeRef.fullName, 
                    values: { submit: undefined, reject: { reason: "expense not allowed" } } };
                return messageStore.saveMessage(message);
            }).then(function(savedMessage) { 
                return messageProcessor.processPendingMessage(savedMessage);
            }).then(function(m) {
                assert.equal(m.invocations.length, 2);
                assert.equal(m.invocationsCompleted.length, 2);                                
                assert.ok(m.invocationsCompleted[0].operation);
                assert.equal(m.invocationsCompleted[0].operation.name, "submit");
                assert.ok(m.invocationsCompleted[1].operation);
                assert.equal(m.invocationsCompleted[1].operation.name, "reject");
              
          //      return kirra.getInstance(m);
          //  }).then(function(instance) {
          //      assert.equal(instance.values.status, "Rejected");                
            }).then(done, done);
        });
        
        test('processPendingMessage - action with parameters', function(done) {
            var category, employee;
            kirra.createInstance({
                entity: 'expenses.Category', 
                values: { name: "Totally different category" + Math.random() }
            }).then(function(instance) {
                category = instance;
                return kirra.createInstance({
                    entity: 'expenses.Employee', 
                    values: { name: "Martha Rhodes" }
                });
            }).then(function(instance) {
                employee = instance;
                var values = { declareExpense: { description: "Trip to Timbuktu", amount: 205.45, date: "2014/09/21", category: category.values.name }  };
                var message = { objectId: instance.objectId, application : kirraApplicationId, entity : kirraEntity, values: values };
                return messageStore.saveMessage(message).then(function() { return message; });
            }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(Object.keys(m.error).length, 0, util.inspect(m));            
                assert.equal(m.invocations.length, 1);
                assert.equal(m.invocationsCompleted.length, 1);                                
                assert.ok(m.invocationsCompleted[0].operation);
                assert.equal(m.invocationsCompleted[0].operation.name, "declareExpense");
                assert.equal(m.invocationsCompleted[0].arguments.description, "Trip to Timbuktu");
                return kirra.getRelatedInstances(m.entity, m.objectId, "recordedExpenses");
            }).then(function(instances) {
                assert.equal(instances.length, 1);                
            }).then(done, done);
        });
        
        test('processPendingMessage - update with label as field names', function(done) {
            kirra.createInstance({
                entity: 'expenses.Employee', 
                values: { name: "John Doe" }
            }).then(function(instance) {
                var message = { objectId: instance.objectId, application : kirraApplicationId, entity : kirraEntity, values: { Name : 'John Moe' } };
                return messageStore.saveMessage(message).then(function() { return message; });
            }).then(function (m) {
                assert.equal(m.values.Name, "John Moe");                
                assert.equal(m.values.name, undefined);                                
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Updated");
                assert.equal(m.values.name, "John Moe");                
                assert.equal(m.values.Name, undefined);                
            }).then(done, done);
        });
        
        test('processPendingMessage - unknown application', function(done) {
            messageStore.saveMessage({ application : "unknown-app", entity : "namespace.Entity", values: { } }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function (m) {
                assert.equal(m.status, "Failure");
                assert.ok(m.error);
                assert.equal(m.error.message, "Project not found: unknown-app");
            }).then(done, done);
        });
        
        test('processPendingMessage - unknown entity', function(done) {
            messageStore.saveMessage({ application : kirraApplicationId, entity : "namespace.Entity", values: { } }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function (m) {
                assert.equal(m.status, "Failure");
                assert.ok(m.error);
                assert.equal(m.error.message, "Entity not found: namespace.Entity");
            }).then(done, done);
        });

        test('processPendingMessage - unknown instance', function(done) {
            messageStore.saveMessage({ application : kirraApplicationId, entity : "expenses.Employee", objectId: "-1", values: { name: "Some Name" } }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function (m) {
                assert.equal(m.status, "Failure");
                assert.ok(m.error);
                assert.equal(m.error.message, "Instance not found");
            }).then(done, done);
        });


        test('processPendingMessage - missing required field', function(done) {
            messageStore.saveMessage({ 
                application : kirraApplicationId, 
                entity : kirraEntity, 
                values: {} 
            }).then(function (m) {
                return messageProcessor.processPendingMessage(m);
            }).then(function(m) {
                assert.equal(m.status, "Failure");
                assert.ok(m.error);
                assert.equal(m.error.message, "A value is required for Name");
            }).then(done, done);
        });

        test('parseMessage - entity account', function() {
            var message = { 
                account : 'namespace_Entity.myapplication@domain',
                text: 'This is a message'
            };
            messageProcessor.parseMessage(message);
            assert.equal(message.application, "myapplication");
            assert.equal(message.entity, "namespace.Entity");
            assert.equal(message.objectId, undefined);
        });
        
        test('parseMessage - instance account', function() {
            var message = { 
                account : 'namespace_Entity-1234.myapplication@domain',
                text: 'This is a message'
            };
            messageProcessor.parseMessage(message);
            assert.equal(message.application, "myapplication");
            assert.equal(message.entity, "namespace.Entity");
            assert.equal(message.objectId, '1234');
        });
        
        test('parseMessage - values', function() {
            var message = { 
                account : 'namespace_Entity-myapplication@domain',
                subject: 'subject',
                text: 'Line 1\nLine 2\n--\nField1: value1\nField2: value2\n'
            };
            messageProcessor.parseMessage(message);
            assert.ok(message.values);
            assert.equal(message.values.Field1, "value1");
            assert.equal(message.values.Field2, "value2");
            assert.equal(message.comment, "Line 1\nLine 2");
        });
        
        test('parseMessage - values mixed with comment', function() {
            var message = { 
                account : 'namespace_Entity-myapplication@domain',
                subject: 'subject',
                text: 'Line 1\nLine 2\n--\nField1: value1\nField2: value2\n--\nLine 3\nLine 4'
            };
            messageProcessor.parseMessage(message);
            assert.ok(message.values);
            assert.equal(message.values.Field1, "value1");
            assert.equal(message.values.Field2, "value2");
            assert.equal(message.comment, "Line 1\nLine 2\nLine 3\nLine 4");            
        });
        
        test('parseMessage - nested values', function() {
            var message = { 
                account : 'namespace_Entity-myapplication@domain',
                subject: 'subject',
                text: 'Line 1\nLine 2\n--\ndeclareExpense:\n  param1: value1\n  param2: value2\n'
            };
            messageProcessor.parseMessage(message);
            assert.ok(message.values);
            assert.ok(message.values.declareExpense);
            assert.equal(message.values.declareExpense.param1, 'value1');            
            assert.equal(message.values.declareExpense.param2, 'value2');                        
        });
   
    });
});
