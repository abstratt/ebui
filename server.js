#!/bin/env node

var express = require('express');
var fs = require('fs');
var bodyParser = require('body-parser');

var mongo = require('mongodb');
var monk = require('monk');

var https = require("https");

var EBUIApp = function() {

    //  Scope.
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
        self.dbcreds = self.dbusername ? (self.dbusername + ':' + self.dbpassword + '@') : '';
        self.mandrillkey = process.env.MANDRILL_API_KEY || '';
        self.fromEmail = process.env.FROM_EMAIL || '';  
        self.fromName = process.env.FROM_NAME || '';
        console.log("fromEmail: \"" + self.fromEmail + '"');
        console.log("fromName: \"" + self.fromName + '"');
        if (self.fromEmail === '') throw new Error("No email address set");
        if (self.fromName === '') throw new Error("No email name set");
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

        var dbString = self.dbcreds + self.dbhost + ':' + self.dbport + '/' + self.dbname;
        self.db = monk(dbString);

        self.app.use(function(req, res, next) {
            req.db = self.db;
            next();
        });
        self.app.get("/", function(req, res) {
            res.json({
                messages: '/messages/'
            });
        });

        self.app.post("/events/", function(req, res) {
            console.log("Event batch received:");
            console.log("==========================================================");
            console.log(req.body);
            console.log("==========================================================");
            var events = req.body.mandrill_events || [];
            if (typeof events === "string") {
                events = JSON.parse(events);
            }
            events.forEach(function (event) {
                var newMessage = self.parseEventAsMessage(event);
                console.log("New message: ");
                console.log(newMessage);
                req.db.get('messages').insert(newMessage);
                self.replyToSender(event, "Thanks for your message, but we don't really know how to handle it right now.");
            });
            res.send(204);
        });

        self.app.get("/events/", function(req, res) {
            res.send(204);
        });


        self.app.get("/messages/", function(req, res) {
            req.db.get('messages').find({}, function(error, docs) {
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
            self.processPendingMessages();
        }, 10000);
    };

    self.replyToSender = function(event, body) {
        var message = {
            key : self.mandrillkey,
            message: {
                text: "This is an automated response to your message to "+ event.msg.email + "\n\n" + body,
                from_email: self.fromEmail,
                from_name: self.fromName,
                subject: (event.msg.subject && event.msg.subject.indexOf("Re:") === -1) ? ("Re: "+ event.msg.subject) : event.msg.subject,
                to: [{
                    email: event.msg.from_email,     
                    name: event.msg.from_name,
                    type: "to"
                },
                {
                    email: self.fromEmail,     
                    type: "bcc"
                }],
                headers: { 
                    'References': (event.msg.headers['References'] || '') + event.msg.headers['Message-Id'],
                    'In-Reply-To': event.msg.headers['Message-Id']
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
              console.log("statusCode: ", res.statusCode);
              console.log("headers: ", res.headers);
              res.on('data', function(d) {
                  process.stdout.write(d);
              });
        });
        req.write(JSON.stringify(message)); 
        req.end();
	req.on('error', function(e) {
	  console.error(e);
	});
    };

    self.parseEventAsMessage = function(event) {
        var text = event.msg.text;
        var comment = '';
        var commands;
        text.split("\n").forEach(function (current) {        
            if (commands) {
                // after the command section separator, everything is a command
                commands.push(current);
            } else {
                if (current.indexOf('--') === 0) {
                    commands = [];
                } else {
                    comment += current + '\\n';
                }
            }
        });
        var account = event.msg.email;
        var newMessage = {
            received: new Date(),
            account: account,
            fromEmail: event.msg.from_email,
            fromName: event.msg.from_name,
            toEmail: event.msg.to,
            subject: event.msg.subject,
            comment: comment,
            commands: commands,
            status: 'Pending'
        };
        // (entity)(-instanceid)?.(application)@<domain>
        //  Examples: issue.my-application@foo.bar.com and issue-43234cc221ad.my-application@foo.bar.com
        var elements = /^([a-zA-Z]+)(?:-([^.]+))?.([^@^.]+)@.*$/.exec(account);
        if (elements !== null) {
            newMessage.entity = elements[1];
            newMessage.instanceId = elements[2];
            newMessage.application = elements[3];
        }
        return newMessage;
    };

    self.processPendingMessages = function () {
        console.log('Processing pending messages');
        self.db.get('messages').find({ 
            $or: [ 
                { status: { $exists: false } }, 
                { status: 'Pending' } 
            ] 
        }).each(function (message) {
            self.processPendingMessage(message);
        });
        console.log('Done');
    };

    self.processPendingMessage = function (message) {
        console.log("Processing...");
        console.log(message);
        message.status = 'Processed';
        self.db.get('messages').updatebyId(message._id, { status: 'Processed'});
    };

};



/**
 *  main():  Main code.
 */
var ebuiApp = new EBUIApp();

ebuiApp.initialize();
ebuiApp.start();

