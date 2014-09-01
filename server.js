#!/bin/env node

var q = require('q');
var express = require('express');
var fs = require('fs');
var bodyParser = require('body-parser');

var https = require("https");

var url = require("url");

var yaml = require("js-yaml");


var kirra = require("./kirra-client.js");

var messageStore = require("./message-store.js");

var EBUIApp = function() {

    var self = this;


    /*  ================================================================  */
    /*  Helper functions.                                                 */
    /*  ================================================================  */

    /**
     *  Set up server IP address and port # using env variables/defaults.
     */
    self.setupVariables = function() {
        //  Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_NODEJS_IP || "127.0.0.1";
        self.port = process.env.OPENSHIFT_NODEJS_PORT || 8080;
        self.dbhost = process.env.OPENSHIFT_MONGODB_DB_HOST || self.ipaddress;
        self.dbport = process.env.OPENSHIFT_MONGODB_DB_PORT || 27017;
        self.dbname = process.env.OPENSHIFT_MONGODB_DB_NAME || 'mailflowjs';
        self.dbusername = process.env.OPENSHIFT_MONGODB_DB_USERNAME || '';
        self.dbpassword = process.env.OPENSHIFT_MONGODB_DB_PASSWORD || '';
        self.mandrillkey = process.env.MANDRILL_API_KEY || '';
        self.fromEmail = process.env.FROM_EMAIL || 'support@cloudfier.com';  
        self.fromName = process.env.FROM_NAME || 'Cloudfier Support';
        self.baseUrl = process.env.BASE_URL || ("http://" + self.ipaddress + "/");
        self.kirraBaseUrl = process.env.KIRRA_API_URL || "http://develop.cloudfier.com/services/api-v2/";

        console.log("base url: \"" + self.baseUrl + '"');
        console.log("Kirra API url: \"" + self.kirraBaseUrl + '"');
        console.log("fromEmail: \"" + self.fromEmail + '"');
        console.log("fromName: \"" + self.fromName + '"');
    };

    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig) {
        if (typeof sig === "string") {
            console.log('%s: Received %s - terminating the app ...',
                Date(Date.now()), sig);
            process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()));
    };


    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function() {
        //  Process on exit and signals.
        process.on('exit', function() {
            self.terminator();
        });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
            'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() {
                self.terminator(element);
            });
        });
    };


    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.app = express();
        self.app.use(bodyParser.urlencoded({
            extended: true
        }));
        self.app.use(bodyParser.json());

        self.app.use(function(req, res, next) {
            req.messageStore = self.messageStore;
            next();
        });
        self.app.get("/", function(req, res) {
            res.json({
                messages: self.resolveUrl('messages/')
            });
        });

        self.app.post("/events/", function(req, res) {
            var events = req.body.mandrill_events || [];
            if (typeof events === "string") {
                events = JSON.parse(events);
            }
            events.forEach(function (event) {
                var newMessage = self.parseEventAsMessage(event);
                self.messageStore.saveMessage(newMessage);
            });
            res.send(204);
        });

        self.app.get("/events/", function(req, res) {
            res.send(204);
        });


        self.app.get("/messages/", function(req, res) {
            req.messageStore.getAllMessages().then(function(docs) {
                res.json(docs || []);
            });
        });
    };


    /**
     *  Initializes the application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.setupTerminationHandlers();

        self.messageStore = messageStore.build(self.dbhost, self.dbport, self.dbname, self.dbusername, self.dbpassword);        

        // Create the express server and routes.
        self.initializeServer();
    };


    /**
     *  Start the server (starts up the application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.app.listen(self.port, self.ipaddress, function() {
            console.log('%s: Node server started on %s:%d ...',
                Date(Date.now()), self.ipaddress, self.port);
        });
        
        var interval;
        interval = setInterval(function() {
            console.log('Processing pending messages');
            self.processPendingMessages();
            console.log('Done');
        }, 10000);
    };

    self.replyToSender = function(message, body, senderEmail) {
        var payload = {
            key : self.mandrillkey,
            message: {
                text: "This is an automated response to your message to "+ message.account + "\n\n" + body,
                from_email: senderEmail || self.fromEmail,
                from_name: self.fromName,
                subject: (message.subject && message.subject.indexOf("Re:") === -1) ? ("Re: "+ message.subject) : message.subject,
                to: [{
                    email: message.fromEmail,     
                    name: message.fromName,
                    type: "to"
                }],
                headers: { 
                    'In-Reply-To': message._contextMessageId
                }
            }
        };
	    var options = {
	      hostname: 'mandrillapp.com',
	      path: '/api/1.0/messages/send.json',
	      method: 'POST',
              headers: { 'content-type': 'application/json' }
	    };
        var req = https.request(options, function(res) {
              res.on('data', function(d) {
                  process.stdout.write(d);
              });
        });
        req.write(JSON.stringify(payload)); 
        req.end();
	    req.on('error', function(e) {
	      console.error(e);
	    });
    };

    self.parseEventAsMessage = function(event) {
        var text = event.msg.text;
        var comment = '';
        var processingRules;
        var ignoring = false;
        if (text) {
		    text.split("\n").forEach(function (current) {        
		        if (processingRules) {
                    if (current.indexOf('--') === 0) {
                        ignoring = true;
                    } else if (!ignoring) {
	                    // after the command section separator, everything is a command
	                    processingRules.push(current);
                    }
		        } else {
		            if (current.indexOf('--') === 0) {
		                processingRules = [];
		            } else {
		                comment += current + '\\n';
		            }
		        }
		    });
        }
        var values = processingRules ? yaml.safeLoad(processingRules.join('\\n')) : undefined;
        var account = event.msg.email;
        var newMessage = {
            received: new Date(),
            account: account,
            fromEmail: event.msg.from_email,
            fromName: event.msg.from_name,
            toEmail: event.msg.to,
            subject: event.msg.subject,
            comment: comment,
            values: values,
            status: 'Pending',
            // so we can reply in context later
            _contextMessageId: event.msg.headers['Message-Id']
        };
        // (entity)(-instanceid)?.(application)@<domain>
        //  Examples: issue.my-application@foo.bar.com and issue-43234cc221ad.my-application@foo.bar.com
        var elements = /^([a-z_A-Z]+)(?:-([^.]+))?\.([^@^.]+)@.*$/.exec(account);
        if (elements !== null) {
            newMessage.entity = elements[1].replace("_", ".");
            newMessage.instanceId = elements[2];
            newMessage.application = elements[3];
        }
        return newMessage;
    };

    self.processPendingMessages = function () {
        return self.messageStore.getPendingMessages('messages').each(function (message) {
            self.processPendingMessage(message);
        });
    };

    self.processPendingMessage = function (message) {
        console.log("Processing " + message._id + "...");

        if (!message.application) {
            message.status = 'Invalid';
            self.replyToSender(message, "Unfortunately, your message could not be processed.");
            return self.messageStore.saveMessage(message).then(function() { return message; });    
        }
        message.status = 'Processing';
        return self.messageStore.saveMessage(message).then(function () {
            if (message.instanceId) {
                return self.processUpdateMessage(message);
            } else {
                return self.processCreationMessage(message);
            }
        }).then(function() { return message; });
    };

    self.onError = function(message, errorMessage) {
	    return function (e) {
	        console.log("Error: " + errorMessage);
	        console.log(JSON.stringify(e));
		    message.status = "Failure";
		    message.error = e;
		    self.messageStore.saveMessage(message);
		    self.replyToSender(message, errorMessage + " Reason: " + e.message);
		    return new Error(e.message); 
	    };
    };  

    self.makeEmailForInstance = function(message) {
        return message.entity.replace('.', '_') + '-' + message.instanceId + '.' + message.application + '@inbox.cloudfier.com';
    };

    self.processCreationMessage = function(message) {
        var kirraApp = kirra.build(self.kirraBaseUrl, message.application);
        console.log("kirraApp: "+ JSON.stringify(kirraApp));
        return kirraApp.createInstance(message).then(function (d) {
            message.instanceId = d.objectId;	
            message.status = "Processed";
            self.messageStore.saveMessage(message);
            self.replyToSender(message, "Message successfully processed. Object was created.\n" + yaml.safeDump(d.values, { skipInvalid: true }), self.makeEmailForInstance(message));
            return d;             
        }, self.onError(message, "Error processing your message, object not created."));
    };

    self.processUpdateMessage = function(message) {
        var kirraApp = kirra.build(self.kirraBaseUrl, message.application);
        return kirraApp.updateInstance(message).then(function (d) {
	        self.replyToSender(message, "Message successfully processed. Object was updated.\n" + yaml.safeDump(d.values, { skipInvalid: true }), self.makeEmailForInstance(message));
	        message.status = "Processed";
	        self.messageStore.saveMessage(message);
	        return d;
        }, self.onError(message, "Error processing your message, object not updated."));
    };

    self.resolveUrl = function(relative) {
        return self.baseUrl + relative;
    };
};


var ebuiApp = new EBUIApp();
ebuiApp.initialize();
ebuiApp.start();

var app = exports = module.exports = ebuiApp;
