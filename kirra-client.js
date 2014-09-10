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
    
    self.cachedEntities = undefined;

    self.performRequestOnURL = function(requestUrl, method, expectedStatus, body) {
        var parsedUrl = url.parse(requestUrl);
        var options = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname,
          method: method || 'GET',
          headers: { 'content-type': 'application/json' }
        };
        var deferred = q.defer();
        console.error(options.method + " " + options.path + " " + JSON.stringify(body || {}));
        var start = new Date().getTime()
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
                    var end = new Date().getTime()
                    console.error("Time: ", (end - start) + "ms");                    
                    console.error("Success response: ", util.inspect(parsed));
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
    }
    
    self.performRequest = function(path, method, expectedStatus, body) {
        var requestUrl = self.baseUrl + self.application + path;	        
        return self.performRequestOnURL(requestUrl, method, expectedStatus, body);
    };
    
    self.createInstance = function(message) {
        var template;
        var entity;
        return self.getInstanceTemplate(message).then(function (t) { 
            template = t;
            return self.getEntity(message.entity);
        }).then(function(e) {
            entity = e;
            for (var p in entity.properties) {
                // fill in an unfulfilled required string property with the subject line if needed
                if (message.subject && !message.values[p] && !template.values[p] && entity.properties[p].typeRef.typeName === "String" && entity.properties[p].required && !entity.properties[p].hasDefault && entity.properties[p].editable) {
                    message.values[p] = message.subject;
                    break;
                }
            }
            for (var p in entity.properties) {
                // fill in an unfulfilled required memo property with the email comment if needed
                if (message.comment && !message.values[p] && !template.values[p] && entity.properties[p].typeRef.typeName === "Memo" && entity.properties[p].required && !entity.properties[p].hasDefault && entity.properties[p].editable) {
                    message.values[p] = message.comment;
                    break;
                }
            }
            return message;
        }).then(function (message) {
		    var mergedValues = merge(merge({}, message.values), template.values);
		    var mergedLinks = merge(merge({}, message.links), template.links);
            return self.performRequest('/entities/' + message.entity + '/instances/', 'POST', [201, 200], 
                { values: mergedValues, links: mergedLinks }
            );
	    });
    };

    self.updateInstance = function(message) {
        var instance;
        var commentTargetRelationship;
        return self.getInstance(message).then(function (i) {
            instance = i;
            return message.comment ? self.findCommentTargetChildRelationship(message.entity) : undefined;
        }).then(function (childRelationship) {
            commentTargetRelationship = childRelationship;
            return message;
        }).then(function (message) {
		    var mergedValues = merge(merge({}, message.values), instance.values);
		    var mergedLinks = merge(merge({}, message.links), instance.links);
		    return self.performRequest('/entities/' + message.entity + '/instances/' + message.objectId, 'PUT', 200, 
		        { values: mergedValues, links: mergedLinks }
	        );
	    }).then(function(parentInstance) {
	        if (commentTargetRelationship) {
	            var links = {};
	            links[commentTargetRelationship.relationship.opposite] = [{uri: parentInstance.uri}];
	            var values = {};
	            values[commentTargetRelationship.commentProperty.name] = message.comment;
	            return self.performRequest('/entities/' + commentTargetRelationship.relationship.typeRef.fullName + '/instances/', 'POST', [201, 200], 
                    { values: values, links: links }
                );    
	        }
            return parentInstance;
	    });
    };
    
    self.findCommentTargetChildRelationship = function (parentEntityName) {
        return self.getEntity(parentEntityName).then(function (e) {
            var childRelationships = Object.keys(e.relationships).map(function (k) { 
                return e.relationships[k]; 
            }).filter(function (r) {
                return r.style === "CHILD"
            });
            // now find the first child relationship that has a comment-like entity 
            // (only required field is a Memo field or there are no required fields and there is at least one Memo field)
            var finder = function () {
                var currentRelationship = childRelationships.shift();
                if (!currentRelationship) {
                    return q.thenResolve(undefined);
                }
                return self.getEntity(currentRelationship.typeRef.fullName).then(function(childEntity) {
                    var properties = Object.keys(childEntity.properties).map(function (k) { 
                        return childEntity.properties[k]; 
                    });
                    var requiredProperties = properties.filter(function (p) { 
                        return p.required && !p.hasDefault; 
                    });
                    var memoProperties = properties.filter(function (p) { 
                        return p.typeRef.typeName === 'Memo' && p.userVisible && (p.initializable || p.editable); 
                    });
                    var hasRequiredRelationships = Object.keys(childEntity.relationships).find(function (k) { 
                        return childEntity.relationships[k].required && !(childEntity.relationships[k].typeRef.fullName === parentEntityName); 
                    });
                    if (hasRequiredRelationships) {
                        return finder();
                    }
                    if (memoProperties.length === 0) {
                        return finder();
                    }
                    if (requiredProperties.length > 1) {
                        return finder();
                    }
                    if (requiredProperties.length === 1 && requiredProperties[0].typeRef.typeName !== 'Memo') {
                        return finder();
                    }
                    return { relationship: currentRelationship, commentProperty: memoProperties[0]};          
                });
            };
            return finder();
        });
    };

    self.getApplication = function() {
        return self.performRequest('', undefined, 200);
    };
    
    self.getExactEntity = function(entityName) {
        return self.performRequest('/entities/' + entityName, undefined, 200);
    };
    
    self.getEntityFromCache = function(entityName) {
        var found = self.cachedEntities.find(function (it) { 
            return it.fullName.toUpperCase() === entityName.toUpperCase() || it.label.toUpperCase() === entityName.toUpperCase(); 
        });
        if (found) {
            return found;
        }
        throw new Error("Entity not found: " + entityName);
    };
    
    self.getEntity = function(entity) {
        return self.getEntities().then(function() {
            return self.getEntityFromCache(entity);
        });
    };
    
    self.getEntities = function() {
        if (self.cachedEntities) {
            return q.thenResolve(self.cachedEntities);
        }
        return self.performRequest('/entities/', undefined, 200).then(function (entities) {
            self.cachedEntities = entities;
            return entities;
        });
    };

    self.getInstance = function(message) {
        return self.performRequest('/entities/' + message.entity + '/instances/' + message.objectId, undefined, 200);
    };
    
    self.invokeOperation = function(objectId, operation, arguments) {
        return self.performRequest('/entities/' + operation.owner.fullName + '/instances/' + objectId + '/actions/' + operation.name, 'POST', 200, arguments);
    };

    self.getInstances = function(entity, filter) {
        var filterQuery = "?";
        if (filter) {
            var terms = [];
            for (var p in filter) {
                terms.push(p + "=" + encodeURIComponent(filter[p]));    
            }
            filterQuery += terms.join("&");
        }
        return self.performRequest('/entities/' + entity + '/instances/' + filterQuery, undefined, 200);
    };
    
    self.getRelatedInstances = function(entity, objectId, relationshipName) {
        return self.performRequest('/entities/' + entity + '/instances/' + objectId + '/relationships/' + relationshipName + '/', undefined, 200);
    };

    self.getInstanceTemplate = function(message) {
        return self.performRequest('/entities/' + message.entity + '/instances/_template', undefined, 200);
    };
    
    return self;
};

var exports = module.exports = Kirra;
