'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _events = require('events');

var _events2 = _interopRequireDefault(_events);

var _lodashKeys = require('lodash.keys');

var _lodashKeys2 = _interopRequireDefault(_lodashKeys);

var _lodashUniq = require('lodash.uniq');

var _lodashUniq2 = _interopRequireDefault(_lodashUniq);

var _angular = require('angular');

var _angular2 = _interopRequireDefault(_angular);

var _utils = require('./utils');

var _utils2 = _interopRequireDefault(_utils);

exports['default'] = function ($q, $injector) {
  'ngInject';

  function ServerResourceFactory(url, rootKey, rootKeyPlural) {
    var socket = $injector.get('socket');
    var sock = socket(url, rootKey, rootKeyPlural);

    // Object holding the resources (keys are the object ids)
    var _resources = {};
    var _internalRes = {};

    // If the socket resets or connects then refetch everything
    sock.on('reset', function () {
      refreshResources();
    });
    sock.on('connected', function () {
      refreshResources();
    });

    // Listen for modified gets
    sock.on('modified get', function (id) {
      if (id) {
        var res = _resources[id];
        if (res) {
          res.$refresh();
        }
      }
    });

    function toObject() {
      return _utils2['default'].toObject(this);
    }

    function refreshResources() {
      ServerResource.get((0, _lodashKeys2['default'])(_resources), true);
    }

    // Returns the object or a list of objects (depending on ids passed in)
    // The array or object will have the $promise attribute to use.
    function get(ids, force, transform) {

      if (_angular2['default'].isFunction(force)) {
        transform = force;
        force = false;
      }

      if (!transform) {
        transform = function (val) {
          return val;
        };
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
      if (_angular2['default'].isString(ids)) {
        singleId = true;
        ids = [ids];
      }

      // Make sure we have no repeated items in the array
      ids = (0, _lodashUniq2['default'])(ids);

      // Go and load in the results, compiling a list of resources we need to go and fetch
      var unknownIds = [];
      ids.forEach(function (id) {
        var res = _resources[id];
        if (res) {
          results.push(transform(res, id));

          // If we are forcing then we want to go and refetch assuming we've already resolved
          // If we haven't resolved then we are going to refresh the data anyway so don't do
          // anything here. If we aren't resolved and we aren't fetching then we want to
          // go and refresh the data because we could have been created from somewhere that
          // isn't the server
          if (force && res.$resolved || !(res.$resolved || res.$fetching)) {
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
        req.then(function (response) {

          // We might not get a response (say if the app is offline). In this case
          // we just resolve everything as is.
          if (_angular2['default'].isUndefined(response)) {
            unknownIds.forEach(function (id) {
              var res = _resources[id];
              res.$fetching = false;

              if (!res.$resolved) {
                res.$resolved = true;
                res.$deferred.resolve(res);
              }
            });
          } else {
            response.forEach(function (resdata) {
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
            unknownIds.forEach(function (id) {
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
        }, function (reason) {
          // Handle an error...
          // Clean up any of our unknown ids - we don't know about them
          unknownIds.forEach(function (id) {
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
        results.forEach(function (res) {
          promises.push(res.$promise);
        });

        var tmpProm = $q.all(promises);
        results.$promise = tmpProm.then(function () {
          // Return the results array as we resolve
          return results;
        });
      }

      return transformResults();
    }

    // Perform a save
    function save(patch) {
      _utils2['default'].applyPatch(this, patch);

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
      req.then(function (response) {
        updateVal(res, response);
        // Resolve the deferred
        deferred.resolve(res);
        _resources[res._id] = res;
        if (!res.$resolved) {
          res.$deferred.resolve(res);
          res.$resolved = true;
        }
      }, function (reason) {

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
      return req.then(function (response) {
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
      return req.then(function (response) {
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
        val = _utils2['default'].convertJsonDates(val);

        var oldData = res.$toObject();
        _utils2['default'].removeResValues(res);
        _utils2['default'].setResValues(res, val);

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
      this.$emitter = new _events2['default'].EventEmitter();

      this.$deferred = $q.defer();
      this.$promise = this.$deferred.promise; // An initial promise for our initial
      // fetch or create of data
      this.$resolved = false; // Have we had an initial resolution of the promise
      this.$deleted = false; // Has the resource been deleted
      this.$fetching = false; // Are we currently fetching data for this resource

      this.$id = id ? id : _utils2['default'].uuid();

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
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,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QUksQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUM7T0FDN0I7O0FBRUQsYUFBTyxJQUFJLENBQUM7S0FDYjs7QUFFRCxrQkFBYyxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7O0FBRXpCLGtCQUFjLENBQUMsU0FBUyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7QUFDdEMsa0JBQWMsQ0FBQyxTQUFTLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUMxQyxrQkFBYyxDQUFDLFNBQVMsQ0FBQyxPQUFPLEdBQUcsTUFBTSxDQUFDO0FBQzFDLGtCQUFjLENBQUMsU0FBUyxDQUFDLFFBQVEsR0FBRyxPQUFPLENBQUM7QUFDNUMsa0JBQWMsQ0FBQyxTQUFTLENBQUMsU0FBUyxHQUFHLFFBQVEsQ0FBQztBQUM5QyxrQkFBYyxDQUFDLFNBQVMsQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDOztBQUVqRCxXQUFPLGNBQWMsQ0FBQztHQUN2Qjs7QUFFRCxTQUFPLHFCQUFxQixDQUFDO0NBQzlCIiwiZmlsZSI6InNlcnZlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBldmVudHMgZnJvbSAnZXZlbnRzJztcblxuaW1wb3J0IGtleXMgZnJvbSAnbG9kYXNoLmtleXMnO1xuaW1wb3J0IHVuaXEgZnJvbSAnbG9kYXNoLnVuaXEnO1xuXG5pbXBvcnQgYW5ndWxhciBmcm9tICdhbmd1bGFyJztcblxuaW1wb3J0IHV0aWxzIGZyb20gJy4vdXRpbHMnO1xuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbigkcSwgJGluamVjdG9yKSB7XG4gICduZ0luamVjdCc7XG5cbiAgZnVuY3Rpb24gU2VydmVyUmVzb3VyY2VGYWN0b3J5KHVybCwgcm9vdEtleSwgcm9vdEtleVBsdXJhbCkge1xuICAgIHZhciBzb2NrZXQgPSAkaW5qZWN0b3IuZ2V0KCdzb2NrZXQnKTtcbiAgICB2YXIgc29jayA9IHNvY2tldCh1cmwsIHJvb3RLZXksIHJvb3RLZXlQbHVyYWwpO1xuXG4gICAgLy8gT2JqZWN0IGhvbGRpbmcgdGhlIHJlc291cmNlcyAoa2V5cyBhcmUgdGhlIG9iamVjdCBpZHMpXG4gICAgdmFyIF9yZXNvdXJjZXMgPSB7fTtcbiAgICB2YXIgX2ludGVybmFsUmVzID0ge307XG5cbiAgICAvLyBJZiB0aGUgc29ja2V0IHJlc2V0cyBvciBjb25uZWN0cyB0aGVuIHJlZmV0Y2ggZXZlcnl0aGluZ1xuICAgIHNvY2sub24oJ3Jlc2V0JywgZnVuY3Rpb24oKSB7XG4gICAgICByZWZyZXNoUmVzb3VyY2VzKCk7XG4gICAgfSk7XG4gICAgc29jay5vbignY29ubmVjdGVkJywgZnVuY3Rpb24oKSB7XG4gICAgICByZWZyZXNoUmVzb3VyY2VzKCk7XG4gICAgfSk7XG5cbiAgICAvLyBMaXN0ZW4gZm9yIG1vZGlmaWVkIGdldHNcbiAgICBzb2NrLm9uKCdtb2RpZmllZCBnZXQnLCBmdW5jdGlvbihpZCkge1xuICAgICAgaWYgKGlkKSB7XG4gICAgICAgIHZhciByZXMgPSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgaWYgKHJlcykge1xuICAgICAgICAgIHJlcy4kcmVmcmVzaCgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBmdW5jdGlvbiB0b09iamVjdCgpIHtcbiAgICAgIHJldHVybiB1dGlscy50b09iamVjdCh0aGlzKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWZyZXNoUmVzb3VyY2VzKCkge1xuICAgICAgU2VydmVyUmVzb3VyY2UuZ2V0KGtleXMoX3Jlc291cmNlcyksIHRydWUpO1xuICAgIH1cblxuICAgIC8vIFJldHVybnMgdGhlIG9iamVjdCBvciBhIGxpc3Qgb2Ygb2JqZWN0cyAoZGVwZW5kaW5nIG9uIGlkcyBwYXNzZWQgaW4pXG4gICAgLy8gVGhlIGFycmF5IG9yIG9iamVjdCB3aWxsIGhhdmUgdGhlICRwcm9taXNlIGF0dHJpYnV0ZSB0byB1c2UuXG4gICAgZnVuY3Rpb24gZ2V0KGlkcywgZm9yY2UsIHRyYW5zZm9ybSkge1xuXG4gICAgICBpZiAoYW5ndWxhci5pc0Z1bmN0aW9uKGZvcmNlKSkge1xuICAgICAgICB0cmFuc2Zvcm0gPSBmb3JjZTtcbiAgICAgICAgZm9yY2UgPSBmYWxzZTtcbiAgICAgIH1cblxuICAgICAgaWYgKCF0cmFuc2Zvcm0pIHtcbiAgICAgICAgdHJhbnNmb3JtID0gZnVuY3Rpb24odmFsKSB7IHJldHVybiB2YWw7IH07XG4gICAgICB9XG5cbiAgICAgIHZhciBzaW5nbGVJZCA9IGZhbHNlO1xuICAgICAgdmFyIHJlc3VsdHMgPSBbXTtcblxuICAgICAgZnVuY3Rpb24gdHJhbnNmb3JtUmVzdWx0cygpIHtcbiAgICAgICAgaWYgKHNpbmdsZUlkKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHNbMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSWYgd2UndmUgYmVlbiBwYXNzZWRcbiAgICAgIGlmIChhbmd1bGFyLmlzU3RyaW5nKGlkcykpIHtcbiAgICAgICAgc2luZ2xlSWQgPSB0cnVlO1xuICAgICAgICBpZHMgPSBbaWRzXTtcbiAgICAgIH1cblxuICAgICAgLy8gTWFrZSBzdXJlIHdlIGhhdmUgbm8gcmVwZWF0ZWQgaXRlbXMgaW4gdGhlIGFycmF5XG4gICAgICBpZHMgPSB1bmlxKGlkcyk7XG5cbiAgICAgIC8vIEdvIGFuZCBsb2FkIGluIHRoZSByZXN1bHRzLCBjb21waWxpbmcgYSBsaXN0IG9mIHJlc291cmNlcyB3ZSBuZWVkIHRvIGdvIGFuZCBmZXRjaFxuICAgICAgdmFyIHVua25vd25JZHMgPSBbXTtcbiAgICAgIGlkcy5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICAgIHZhciByZXMgPSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgaWYgKHJlcykge1xuICAgICAgICAgIHJlc3VsdHMucHVzaCh0cmFuc2Zvcm0ocmVzLCBpZCkpO1xuXG4gICAgICAgICAgLy8gSWYgd2UgYXJlIGZvcmNpbmcgdGhlbiB3ZSB3YW50IHRvIGdvIGFuZCByZWZldGNoIGFzc3VtaW5nIHdlJ3ZlIGFscmVhZHkgcmVzb2x2ZWRcbiAgICAgICAgICAvLyBJZiB3ZSBoYXZlbid0IHJlc29sdmVkIHRoZW4gd2UgYXJlIGdvaW5nIHRvIHJlZnJlc2ggdGhlIGRhdGEgYW55d2F5IHNvIGRvbid0IGRvXG4gICAgICAgICAgLy8gYW55dGhpbmcgaGVyZS4gSWYgd2UgYXJlbid0IHJlc29sdmVkIGFuZCB3ZSBhcmVuJ3QgZmV0Y2hpbmcgdGhlbiB3ZSB3YW50IHRvXG4gICAgICAgICAgLy8gZ28gYW5kIHJlZnJlc2ggdGhlIGRhdGEgYmVjYXVzZSB3ZSBjb3VsZCBoYXZlIGJlZW4gY3JlYXRlZCBmcm9tIHNvbWV3aGVyZSB0aGF0XG4gICAgICAgICAgLy8gaXNuJ3QgdGhlIHNlcnZlclxuICAgICAgICAgIGlmICgoZm9yY2UgJiYgcmVzLiRyZXNvbHZlZCkgfHwgIShyZXMuJHJlc29sdmVkIHx8IHJlcy4kZmV0Y2hpbmcpKSB7XG4gICAgICAgICAgICB1bmtub3duSWRzLnB1c2goaWQpO1xuICAgICAgICAgICAgcmVzLiRmZXRjaGluZyA9IHRydWU7XG5cbiAgICAgICAgICAgIC8vIElmIHdlJ3ZlIGFscmVhZHkgcmVzb2x2ZWQgdGhlbiBjcmVhdGUgYSBuZXcgcHJvbWlzZSBvYmplY3Qgb24gdGhlIHJlc291cmNlXG4gICAgICAgICAgICBpZiAocmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgICByZXMuJGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgICAgcmVzLiRwcm9taXNlID0gcmVzLiRkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICAgICAgICByZXMuJHJlc29sdmVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEhhdmVuJ3Qgc2VlbiB0aGlzIGlkIHlldC4gQ3JlYXRlIGEgbmV3IHJlc291cmNlIGFuZCBzdG9yZSBpdCBvZmZcbiAgICAgICAgICByZXMgPSBfcmVzb3VyY2VzW2lkXSA9IG5ldyBTZXJ2ZXJSZXNvdXJjZSgpO1xuICAgICAgICAgIHJlcy4kZmV0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgIHJlc3VsdHMucHVzaCh0cmFuc2Zvcm0ocmVzLCBpZCkpO1xuICAgICAgICAgIHVua25vd25JZHMucHVzaChpZCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBEbyB3ZSBoYXZlIGFueSBpZHMgdG8gZmV0Y2guIElmIHNvIGdvIGFuZCBnZXQgdGhlbVxuICAgICAgaWYgKHVua25vd25JZHMubGVuZ3RoID4gMCkge1xuICAgICAgICB2YXIgcmVxID0gc29jay5nZXQodW5rbm93bklkcyk7XG4gICAgICAgIHJlcS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG5cbiAgICAgICAgICAvLyBXZSBtaWdodCBub3QgZ2V0IGEgcmVzcG9uc2UgKHNheSBpZiB0aGUgYXBwIGlzIG9mZmxpbmUpLiBJbiB0aGlzIGNhc2VcbiAgICAgICAgICAvLyB3ZSBqdXN0IHJlc29sdmUgZXZlcnl0aGluZyBhcyBpcy5cbiAgICAgICAgICBpZiAoYW5ndWxhci5pc1VuZGVmaW5lZChyZXNwb25zZSkpIHtcbiAgICAgICAgICAgIHVua25vd25JZHMuZm9yRWFjaChmdW5jdGlvbihpZCkge1xuICAgICAgICAgICAgICB2YXIgcmVzID0gX3Jlc291cmNlc1tpZF07XG4gICAgICAgICAgICAgIHJlcy4kZmV0Y2hpbmcgPSBmYWxzZTtcblxuICAgICAgICAgICAgICBpZiAoIXJlcy4kcmVzb2x2ZWQpIHtcbiAgICAgICAgICAgICAgICByZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlc3BvbnNlLmZvckVhY2goZnVuY3Rpb24ocmVzZGF0YSkge1xuICAgICAgICAgICAgICBpZiAocmVzZGF0YS5faWQpIHtcbiAgICAgICAgICAgICAgICB2YXIgaWQgPSByZXNkYXRhLl9pZDtcbiAgICAgICAgICAgICAgICB2YXIgcmVzID0gX3Jlc291cmNlc1tpZF07XG4gICAgICAgICAgICAgICAgcmVzLiRmZXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIHVwZGF0ZVZhbChyZXMsIHJlc2RhdGEpO1xuXG4gICAgICAgICAgICAgICAgLy8gV2UndmUgZ290IHRoZSBkYXRhIGZvciB0aGUgZmlyc3QgdGltZSAtIHJlc29sdmUgdGhlIGRlZmVycmVkXG4gICAgICAgICAgICAgICAgaWYgKCFyZXMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICAgICAgICAgIHJlcy4kcmVzb2x2ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIElmIGFueSBvZiBvdXIgdW5rbm93biBpZHMgaGFzbid0IGJlZW4gcmVzb2x2ZWQgdGhlbiB3ZSBhc3N1bWUgaXRzIGRlbGV0ZWQuLi5cbiAgICAgICAgICAgIHVua25vd25JZHMuZm9yRWFjaChmdW5jdGlvbihpZCkge1xuICAgICAgICAgICAgICB2YXIgcmVzID0gX3Jlc291cmNlc1tpZF07XG4gICAgICAgICAgICAgIGlmICghcmVzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgcmVzLiRmZXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICBpZiAoIXJlcy4kcmVzb2x2ZWQpIHtcbiAgICAgICAgICAgICAgICByZXMuJGRlbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlcy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCBudWxsLCByZXMuJHRvT2JqZWN0KCkpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH0sIGZ1bmN0aW9uKHJlYXNvbikge1xuICAgICAgICAgIC8vIEhhbmRsZSBhbiBlcnJvci4uLlxuICAgICAgICAgIC8vIENsZWFuIHVwIGFueSBvZiBvdXIgdW5rbm93biBpZHMgLSB3ZSBkb24ndCBrbm93IGFib3V0IHRoZW1cbiAgICAgICAgICB1bmtub3duSWRzLmZvckVhY2goZnVuY3Rpb24oaWQpIHtcbiAgICAgICAgICAgIHZhciByZXMgPSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgICAgIHJlcy4kZmV0Y2hpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgIHJlcy4kZGVmZXJyZWQucmVqZWN0KHJlYXNvbik7XG4gICAgICAgICAgICBkZWxldGUgX3Jlc291cmNlc1tpZF07XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoIXNpbmdsZUlkKSB7XG4gICAgICAgIC8vIFdhaXQgZm9yIGFsbCB0aGUgcHJvbWlzZXMgdG8gYmUgcmVzb2x2ZWQgYmVmb3JlIHJlc29sdmluZ1xuICAgICAgICB2YXIgcHJvbWlzZXMgPSBbXTtcbiAgICAgICAgcmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uKHJlcykge1xuICAgICAgICAgIHByb21pc2VzLnB1c2gocmVzLiRwcm9taXNlKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdmFyIHRtcFByb20gPSAkcS5hbGwocHJvbWlzZXMpO1xuICAgICAgICByZXN1bHRzLiRwcm9taXNlID0gdG1wUHJvbS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIC8vIFJldHVybiB0aGUgcmVzdWx0cyBhcnJheSBhcyB3ZSByZXNvbHZlXG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdHJhbnNmb3JtUmVzdWx0cygpO1xuICAgIH1cblxuICAgIC8vIFBlcmZvcm0gYSBzYXZlXG4gICAgZnVuY3Rpb24gc2F2ZShwYXRjaCkge1xuICAgICAgdXRpbHMuYXBwbHlQYXRjaCh0aGlzLCBwYXRjaCk7XG5cbiAgICAgIC8vIFdlIHVwZGF0ZSBpZiB3ZSBoYXZlIGFuIF9pZCAtIG90aGVyd2lzZSB3ZSBjcmVhdGUuXG4gICAgICBpZiAodGhpcy5faWQpIHtcbiAgICAgICAgcmV0dXJuIHVwZGF0ZVJlc291cmNlKHRoaXMsIHBhdGNoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFRoaXMgaXMgYW4gaW5pdGlhbCBjcmVhdGVcbiAgICAgICAgcmV0dXJuIGNyZWF0ZVJlc291cmNlKHRoaXMpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHVwZGF0ZVJlc291cmNlKHJlcywgcGF0Y2gpIHtcbiAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICB2YXIgcmVxID0gc29jay5wYXRjaChyZXMuX2lkLCBwYXRjaCk7XG4gICAgICByZXEudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICB1cGRhdGVWYWwocmVzLCByZXNwb25zZSk7XG4gICAgICAgIC8vIFJlc29sdmUgdGhlIGRlZmVycmVkXG4gICAgICAgIGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgX3Jlc291cmNlc1tyZXMuX2lkXSA9IHJlcztcbiAgICAgICAgaWYgKCFyZXMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgcmVzLiRkZWZlcnJlZC5yZXNvbHZlKHJlcyk7XG4gICAgICAgICAgcmVzLiRyZXNvbHZlZCA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgfSwgZnVuY3Rpb24ocmVhc29uKSB7XG5cbiAgICAgICAgLy8gU29tZXRoaW5nIHdlbnQgd3JvbmcgLSBnbyBhbmQgZmV0Y2ggdGhlIG9iamVjdCBhZ2FpbiBzbyB3ZSBhcmUgdXAgdG8gZGF0ZVxuICAgICAgICBpZiAocmVzLl9pZCkge1xuICAgICAgICAgIHJlcy4kcmVmcmVzaCgpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGVmZXJyZWQucmVqZWN0KHJlYXNvbik7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY3JlYXRlUmVzb3VyY2UocmVzKSB7XG4gICAgICB2YXIgZGF0YSA9IHJlcy4kdG9PYmplY3QoKTtcblxuICAgICAgdmFyIHJlcSA9IHNvY2suY3JlYXRlKGRhdGEpO1xuICAgICAgcmV0dXJuIHJlcS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgIC8vIFRoZXJlIGNvdWxkIGJlIGEgcmFjZSBjb25kaXRpb24gaGVyZSB3aGVyZSB3ZSBjb3VsZCBlbmQgdXAgY3JlYXRpbmcgdGhlIGlkIG1hcFxuICAgICAgICAvLyBlYXJsaWVyIChtYXliZS4uLj8pXG4gICAgICAgIHVwZGF0ZVZhbChyZXMsIHJlc3BvbnNlKTtcbiAgICAgICAgX3Jlc291cmNlc1tyZXMuX2lkXSA9IHJlcztcblxuICAgICAgICBpZiAoIXJlcy4kcmVzb2x2ZWQpIHtcbiAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICByZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuXG4gICAgICB2YXIgcmVzID0gdGhpcztcbiAgICAgIHJlcy4kZGVsZXRlZCA9IHRydWU7XG5cblxuICAgICAgdmFyIHJlcSA9IHNvY2sucmVtb3ZlKHJlcy5faWQpO1xuICAgICAgcmV0dXJuIHJlcS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICAgIGRlbGV0ZSBfcmVzb3VyY2VzW3Jlcy5faWRdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlcy4kZGVsZXRlZCA9IGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlcyB0aGUgdmFsdWUgZnJvbSB0aGUgc2VydmVyXG4gICAgZnVuY3Rpb24gdXBkYXRlVmFsKHJlcywgdmFsKSB7XG5cbiAgICAgIC8vIERvIHdlIGhhdmUgYSBudWxsIHZhbHVlIChpbmRpY2F0aW5nIHRoZSByZXNvdXJjZSBoYXMgYmVlbiBkZWxldGVkPylcbiAgICAgIGlmICh2YWwpIHtcbiAgICAgICAgLy8gQ29udmVydCBhbnkgSlNPTiBkYXRlcyBpbnRvIGRhdGVzXG4gICAgICAgIHZhbCA9IHV0aWxzLmNvbnZlcnRKc29uRGF0ZXModmFsKTtcblxuICAgICAgICB2YXIgb2xkRGF0YSA9IHJlcy4kdG9PYmplY3QoKTtcbiAgICAgICAgdXRpbHMucmVtb3ZlUmVzVmFsdWVzKHJlcyk7XG4gICAgICAgIHV0aWxzLnNldFJlc1ZhbHVlcyhyZXMsIHZhbCk7XG5cbiAgICAgICAgLy8gTWFrZSBzdXJlIHdlIGhhdmUgc3RvcmUgdGhpcyByZXNvdXJjZSBvZmZcbiAgICAgICAgX3Jlc291cmNlc1tyZXMuX2lkXSA9IHJlcztcbiAgICAgICAgcmVzLiRlbWl0dGVyLmVtaXQoJ3VwZGF0ZScsIHJlcy4kdG9PYmplY3QoKSwgb2xkRGF0YSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBEZWxldGVkIC0gY2xlYW4gbWUgdXAgc2NvdHR5XG4gICAgICAgIGRlbGV0ZSBfcmVzb3VyY2VzW3Jlcy5faWRdO1xuICAgICAgICByZXMuJGVtaXR0ZXIuZW1pdCgndXBkYXRlJywgbnVsbCwgcmVzLiR0b09iamVjdCgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBfdXBkYXRlVmFsKHZhbCkge1xuICAgICAgcmV0dXJuIHVwZGF0ZVZhbCh0aGlzLCB2YWwpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlZnJlc2goKSB7XG4gICAgICBpZiAodGhpcy5faWQpIHtcbiAgICAgICAgZ2V0KHRoaXMuX2lkLCB0cnVlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGUgbWFpbiBjb25zdHJ1Y3RvciBmb3IgdGhlU2VydmVyUmVzb3VyY2UgY2xhc3NcbiAgICBmdW5jdGlvbiBTZXJ2ZXJSZXNvdXJjZSh2YWwsIGlkKSB7XG4gICAgICB2YXIgcmVzID0gdGhpcztcbiAgICAgIHRoaXMuJGVtaXR0ZXIgPSBuZXcgZXZlbnRzLkV2ZW50RW1pdHRlcigpO1xuXG4gICAgICB0aGlzLiRkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICB0aGlzLiRwcm9taXNlID0gdGhpcy4kZGVmZXJyZWQucHJvbWlzZTsgLy8gQW4gaW5pdGlhbCBwcm9taXNlIGZvciBvdXIgaW5pdGlhbFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZldGNoIG9yIGNyZWF0ZSBvZiBkYXRhXG4gICAgICB0aGlzLiRyZXNvbHZlZCA9IGZhbHNlOyAvLyBIYXZlIHdlIGhhZCBhbiBpbml0aWFsIHJlc29sdXRpb24gb2YgdGhlIHByb21pc2VcbiAgICAgIHRoaXMuJGRlbGV0ZWQgPSBmYWxzZTsgLy8gSGFzIHRoZSByZXNvdXJjZSBiZWVuIGRlbGV0ZWRcbiAgICAgIHRoaXMuJGZldGNoaW5nID0gZmFsc2U7IC8vIEFyZSB3ZSBjdXJyZW50bHkgZmV0Y2hpbmcgZGF0YSBmb3IgdGhpcyByZXNvdXJjZVxuXG4gICAgICB0aGlzLiRpZCA9IGlkID8gaWQgOiB1dGlscy51dWlkKCk7XG5cbiAgICAgIF9pbnRlcm5hbFJlc1t0aGlzLiRpZF0gPSB0aGlzO1xuXG4gICAgICBmb3IgKHZhciBrZXkgaW4gdmFsKSB7XG4gICAgICAgIHJlc1trZXldID0gdmFsW2tleV07XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHdlIGhhdmUgYW4gaWQgdGhlbiBhZGQgdXMgdG8gdGhlIHN0b3JlXG4gICAgICBpZiAodGhpcy5faWQpIHtcbiAgICAgICAgX3Jlc291cmNlc1t0aGlzLl9pZF0gPSB0aGlzO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBTZXJ2ZXJSZXNvdXJjZS5nZXQgPSBnZXQ7XG5cbiAgICBTZXJ2ZXJSZXNvdXJjZS5wcm90b3R5cGUuJHNhdmUgPSBzYXZlO1xuICAgIFNlcnZlclJlc291cmNlLnByb3RvdHlwZS4kcmVtb3ZlID0gcmVtb3ZlO1xuICAgIFNlcnZlclJlc291cmNlLnByb3RvdHlwZS4kZGVsZXRlID0gcmVtb3ZlO1xuICAgIFNlcnZlclJlc291cmNlLnByb3RvdHlwZS4kcmVmcmVzaCA9IHJlZnJlc2g7XG4gICAgU2VydmVyUmVzb3VyY2UucHJvdG90eXBlLiR0b09iamVjdCA9IHRvT2JqZWN0O1xuICAgIFNlcnZlclJlc291cmNlLnByb3RvdHlwZS4kdXBkYXRlVmFsID0gX3VwZGF0ZVZhbDtcblxuICAgIHJldHVybiBTZXJ2ZXJSZXNvdXJjZTtcbiAgfVxuXG4gIHJldHVybiBTZXJ2ZXJSZXNvdXJjZUZhY3Rvcnk7XG59XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
