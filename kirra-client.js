var http = require("http");
var url = require("url");
var q = require('q');
require('array.prototype.find');
var ebuiUtil = require("./util.js");

var assert = ebuiUtil.assert;
var merge = ebuiUtil.merge;
var util = require('util');
var Kirra = function (baseUrl, application) {
    var self = this;
    
    assert(baseUrl, "baseUrl missing");
    assert(application, "application missing");
    
    self.baseUrl = baseUrl;
    
    self.application = application;    
    
    self.performRequest = function(path, method, expectedStatus, body) {
        var parsedKirraBaseUrl = url.parse(self.baseUrl);	        
        var options = {
          hostname: parsedKirraBaseUrl.hostname,
          path: parsedKirraBaseUrl.pathname + self.application + path,
          method: method || 'GET',
          headers: { 'content-type': 'application/json' }
        };
        var deferred = q.defer();
        var req = http.request(options, function(res) {
            var data = "";
            res.on('data', function(chunk) {
                data += chunk.toString();
            }).on('end', function() {
                var parsed = JSON.parse(data);
                if ((typeof expectedStatus === 'number' && expectedStatus !== res.statusCode) || 
                    (typeof expectedStatus === 'object' && expectedStatus.indexOf(res.statusCode) === -1)) {
                    console.error("Error response: ", util.inspect(parsed));
                    deferred.reject(parsed);
                } else {
                    deferred.resolve(parsed);
                }
            });
        });
        if (body) {
            req.write(JSON.stringify(body)); 
        }
        req.end();
        req.on('error', function(e) {
            deferred.reject(e);
        });
        return deferred.promise;
    };
    
    self.createInstance = function(message) {
        return self.getInstanceTemplate(message).then(function (template) {
		    var mergedValues = merge(merge({}, message.values), template.values);
		    var mergedLinks = merge(merge({}, message.links), template.links);
            return self.performRequest('/entities/' + message.entity + '/instances/', 'POST', [201, 200], 
                { values: mergedValues, links: mergedLinks }
            );
	    });
    };

    self.updateInstance = function(message) {
        return self.getInstance(message).then(function (existing) {
		    var mergedValues = merge(merge({}, message.values), existing.values);
		    var mergedLinks = merge(merge({}, message.links), existing.links);
		    return self.performRequest('/entities/' + message.entity + '/instances/' + message.objectId, 'PUT', 200, 
		        { values: mergedValues, links: mergedLinks }
	        );
	    });
    };

    self.getApplication = function() {
        return self.performRequest('', undefined, 200);
    };
    
    self.getEntity = function(entity) {
        return self.performRequest('/entities/', undefined, 200).then(function (entities) {
            var found = entities.find(function (it) { 
                return it.fullName.toUpperCase() === entity.toUpperCase() || it.label.toUpperCase() === entity.toUpperCase(); 
            });
            if (found) {
                return found;
            }
            throw new Error("Entity not found: " + entity);
        });
    };

    self.getInstance = function(message) {
        return self.performRequest('/entities/' + message.entity + '/instances/' + message.objectId, undefined, 200);
    };

    self.getInstanceTemplate = function(message) {
        return self.performRequest('/entities/' + message.entity + '/instances/_template', undefined, 200);
    };
    
    return self;
};

var exports = module.exports = Kirra;
