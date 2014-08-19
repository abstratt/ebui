#!/bin/env node
//  OpenShift sample Node application
var express = require('express');
var fs      = require('fs');
var bodyParser  = require('body-parser');

var mongo = require('mongodb');
var monk = require('monk');

/**
 *  Define the sample application.
 */
var SampleApp = function() {

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
        self.port      = process.env.OPENSHIFT_NODEJS_PORT || 8080;
        self.dbhost      = process.env.OPENSHIFT_MONGODB_DB_HOST || self.ipaddress;
        self.dbport      = process.env.OPENSHIFT_MONGODB_DB_PORT || 27017;
        self.dbname      = process.env.OPENSHIFT_MONGODB_DB_NAME || 'mailflowjs';
    };



    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig){
        if (typeof sig === "string") {
           console.log('%s: Received %s - terminating sample app ...',
                       Date(Date.now()), sig);
           process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()) );
    };


    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function(){
        //  Process on exit and signals.
        process.on('exit', function() { self.terminator(); });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
         'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() { self.terminator(element); });
        });
    };


    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.app = express();
self.app.use(bodyParser.urlencoded({ extended: true }));
self.app.use(bodyParser.json());

        self.db = monk(self.dbhost + ':' + self.dbport + '/'+ self.dbname);

self.app.use(function(req,res,next){
    req.db = self.db;
    next();
});
	    self.app.get("/", function(req, res) {
		res.json({ messages: '//messages/' });	
	    });

	    self.app.post("/events/", function(req, res) {
                var events = req.body.mandrill_events || [];
                console.log(typeof events);
                if (typeof events === "string") {
                    events = JSON.parse(events);
                }
                console.log(events);
                var newMessage;
                var event;
                var collection = req.db.get('messages');
                for (var i in events) {
                    event = events[i];
                    newMessage = {
                        received: new Date(),
                        fromEmail: event.msg.from_email,
                        fromName: event.msg.from_name,
                        toEmail: event.msg.email,
                        body: event.msg.text,
                        subject: event.msg.subject
                   };
                   console.log(newMessage);
                   collection.insert(newMessage);
                }
		res.send(204);	
	    });

	    self.app.get("/events/", function(req, res) {
		res.send(204);	
	    });


	    self.app.get("/messages/", function(req, res) {
		    var collection = req.db.get('messages');
		    collection.find({},{},function(e,docs){
                        docs = docs || [];
 		        res.json(docs);
		    });
	    });
    };


    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.setupTerminationHandlers();

        // Create the express server and routes.
        self.initializeServer();
    };


    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.app.listen(self.port, self.ipaddress, function() {
            console.log('%s: Node server started on %s:%d ...',
                        Date(Date.now() ), self.ipaddress, self.port);
        });
    };

};   /*  Sample Application.  */



/**
 *  main():  Main code.
 */
var zapp = new SampleApp();

zapp.initialize();
zapp.start();



