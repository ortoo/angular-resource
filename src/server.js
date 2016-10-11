import events from 'events';

import uniq from 'lodash.uniq';

import angular from 'angular';

import * as utils from './utils';

export default function($q, $injector) {
  'ngInject';

  function ServerResourceFactory(url, rootKey, rootKeyPlural) {
    var socket = $injector.get('socket');
    var sock = socket(url, rootKey, rootKeyPlural);

    // Object holding the resources (keys are the object ids)
    var _resources = {};
    var _internalRes = {};

    function toObject() {
      return utils.toObject(this);
    }

    // Returns the object or a list of objects (depending on ids passed in)
    // The array or object will have the $promise attribute to use.
    function get(ids, force, transform) {

      if (angular.isFunction(force)) {
        transform = force;
        force = false;
      }

      if (!transform) {
        transform = function(val) { return val; };
      }

      var singleId = false;
      var results = [];

      function transformResults() {
        if (singleId) {
          return results[0];
        } else {
          return results;
        }
      }

      // If we've been passed
      if (angular.isString(ids)) {
        singleId = true;
        ids = [ids];
      }

      // Make sure we have no repeated items in the array
      ids = uniq(ids);

      // Go and load in the results, compiling a list of resources we need to go and fetch
      var unknownIds = [];
      ids.forEach(function(id) {
        var res = _resources[id];
        if (res) {
          results.push(transform(res, id));

          // If we are forcing then we want to go and refetch assuming we've already resolved
          // If we haven't resolved then we are going to refresh the data anyway so don't do
          // anything here. If we aren't resolved and we aren't fetching then we want to
          // go and refresh the data because we could have been created from somewhere that
          // isn't the server
          if ((force && res.$resolved) || !(res.$resolved || res.$fetching)) {
            unknownIds.push(id);
            res.$fetching = true;

            // If we've already resolved then create a new promise object on the resource
            if (res.$resolved) {
              res.$deferred = $q.defer();
              res.$promise = res.$deferred.promise;
              res.$resolved = false;
            }
          }
        } else {
          // Haven't seen this id yet. Create a new resource and store it off
          res = _resources[id] = new ServerResource();
          res.$fetching = true;
          results.push(transform(res, id));
          unknownIds.push(id);
        }
      });

      // Do we have any ids to fetch. If so go and get them
      if (unknownIds.length > 0) {
        var req = sock.get(unknownIds);
        req.then(function(response) {

          // We might not get a response (say if the app is offline). In this case
          // we just resolve everything as is.
          if (angular.isUndefined(response)) {
            unknownIds.forEach(function(id) {
              var res = _resources[id];
              res.$fetching = false;

              if (!res.$resolved) {
                res.$resolved = true;
                res.$deferred.resolve(res);
              }
            });
          } else {
            response.forEach(function(resdata) {
              if (resdata._id) {
                var id = resdata._id;
                var res = _resources[id];
                res.$fetching = false;
                updateVal(res, resdata);

                // We've got the data for the first time - resolve the deferred
                if (!res.$resolved) {
                  res.$deferred.resolve(res);
                  res.$resolved = true;
                }
              }
            });

            // If any of our unknown ids hasn't been resolved then we assume its deleted...
            unknownIds.forEach(function(id) {
              var res = _resources[id];
              if (!res) {
                return;
              }

              res.$fetching = false;
              if (!res.$resolved) {
                res.$deleted = true;
                res.$emitter.emit('update', null, res.$toObject());
              }
            });
          }
        }, function(reason) {
          // Handle an error...
          // Clean up any of our unknown ids - we don't know about them
          unknownIds.forEach(function(id) {
            var res = _resources[id];
            res.$fetching = false;
            res.$deferred.reject(reason);
            delete _resources[id];
          });
        });
      }

      if (!singleId) {
        // Wait for all the promises to be resolved before resolving
        var promises = [];
        results.forEach(function(res) {
          promises.push(res.$promise);
        });

        var tmpProm = $q.all(promises);
        results.$promise = tmpProm.then(function() {
          // Return the results array as we resolve
          return results;
        });
      }

      return transformResults();
    }

    // Perform a save
    function save(patch) {
      utils.applyPatch(this, patch);

      // We update if we have an _id - otherwise we create.
      if (this._id) {
        return updateResource(this, patch);
      } else {
        // This is an initial create
        return createResource(this);
      }
    }

    function updateResource(res, patch) {
      var deferred = $q.defer();
      var req = sock.patch(res._id, patch);
      req.then(function(response) {
        updateVal(res, response);
        // Resolve the deferred
        deferred.resolve(res);
        _resources[res._id] = res;
        if (!res.$resolved) {
          res.$deferred.resolve(res);
          res.$resolved = true;
        }

      }, function(reason) {

        // Something went wrong - go and fetch the object again so we are up to date
        if (res._id) {
          res.$refresh();
        }

        deferred.reject(reason);
      });

      return deferred.promise;
    }

    function createResource(res) {
      var data = res.$toObject();

      var req = sock.create(data);
      return req.then(function(response) {
        // There could be a race condition here where we could end up creating the id map
        // earlier (maybe...?)
        updateVal(res, response);
        _resources[res._id] = res;

        if (!res.$resolved) {
          res.$deferred.resolve(res);
          res.$resolved = true;
        }
      });
    }

    function remove() {

      var res = this;
      res.$deleted = true;


      var req = sock.remove(res._id);
      return req.then(function(response) {
        if (response) {
          delete _resources[res._id];
        } else {
          res.$deleted = false;
        }

        return response;
      });
    }

    // Updates the value from the server
    function updateVal(res, val) {

      // Do we have a null value (indicating the resource has been deleted?)
      if (val) {
        // Convert any JSON dates into dates
        val = utils.convertJsonDates(val);

        var oldData = res.$toObject();
        utils.removeResValues(res);
        utils.setResValues(res, val);

        // Make sure we have store this resource off
        _resources[res._id] = res;
        res.$emitter.emit('update', res.$toObject(), oldData);
      } else {
        // Deleted - clean me up scotty
        delete _resources[res._id];
        res.$emitter.emit('update', null, res.$toObject());
      }
    }

    function _updateVal(val) {
      return updateVal(this, val);
    }

    function refresh() {
      if (this._id) {
        get(this._id, true);
      }
    }

    // The main constructor for theServerResource class
    function ServerResource(val, id) {
      var res = this;
      this.$emitter = new events.EventEmitter();

      this.$deferred = $q.defer();
      this.$promise = this.$deferred.promise; // An initial promise for our initial
                                              // fetch or create of data
      this.$resolved = false; // Have we had an initial resolution of the promise
      this.$deleted = false; // Has the resource been deleted
      this.$fetching = false; // Are we currently fetching data for this resource

      this.$id = id ? id : utils.uuid();

      _internalRes[this.$id] = this;

      for (var key in val) {
        res[key] = val[key];
      }

      // If we have an id then add us to the store
      if (this._id) {
        _resources[this._id] = this;
      }

      return this;
    }

    ServerResource.get = get;

    ServerResource.prototype.$save = save;
    ServerResource.prototype.$remove = remove;
    ServerResource.prototype.$delete = remove;
    ServerResource.prototype.$refresh = refresh;
    ServerResource.prototype.$toObject = toObject;
    ServerResource.prototype.$updateVal = _updateVal;

    return ServerResource;
  }

  return ServerResourceFactory;
}
