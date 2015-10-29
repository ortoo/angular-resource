'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

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

var utils = _interopRequireWildcard(_utils);

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
      return utils.toObject(this);
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
      this.$emitter = new _events2['default'].EventEmitter();

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
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,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QUksQ0FBQyxHQUFHLEVBQUU7QUFDWixrQkFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUM7T0FDN0I7O0FBRUQsYUFBTyxJQUFJLENBQUM7S0FDYjs7QUFFRCxrQkFBYyxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7O0FBRXpCLGtCQUFjLENBQUMsU0FBUyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7QUFDdEMsa0JBQWMsQ0FBQyxTQUFTLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUMxQyxrQkFBYyxDQUFDLFNBQVMsQ0FBQyxPQUFPLEdBQUcsTUFBTSxDQUFDO0FBQzFDLGtCQUFjLENBQUMsU0FBUyxDQUFDLFFBQVEsR0FBRyxPQUFPLENBQUM7QUFDNUMsa0JBQWMsQ0FBQyxTQUFTLENBQUMsU0FBUyxHQUFHLFFBQVEsQ0FBQztBQUM5QyxrQkFBYyxDQUFDLFNBQVMsQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDOztBQUVqRCxXQUFPLGNBQWMsQ0FBQztHQUN2Qjs7QUFFRCxTQUFPLHFCQUFxQixDQUFDO0NBQzlCIiwiZmlsZSI6InNlcnZlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBldmVudHMgZnJvbSAnZXZlbnRzJztcblxuaW1wb3J0IGtleXMgZnJvbSAnbG9kYXNoLmtleXMnO1xuaW1wb3J0IHVuaXEgZnJvbSAnbG9kYXNoLnVuaXEnO1xuXG5pbXBvcnQgYW5ndWxhciBmcm9tICdhbmd1bGFyJztcblxuaW1wb3J0ICogYXMgdXRpbHMgZnJvbSAnLi91dGlscyc7XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCRxLCAkaW5qZWN0b3IpIHtcbiAgJ25nSW5qZWN0JztcblxuICBmdW5jdGlvbiBTZXJ2ZXJSZXNvdXJjZUZhY3RvcnkodXJsLCByb290S2V5LCByb290S2V5UGx1cmFsKSB7XG4gICAgdmFyIHNvY2tldCA9ICRpbmplY3Rvci5nZXQoJ3NvY2tldCcpO1xuICAgIHZhciBzb2NrID0gc29ja2V0KHVybCwgcm9vdEtleSwgcm9vdEtleVBsdXJhbCk7XG5cbiAgICAvLyBPYmplY3QgaG9sZGluZyB0aGUgcmVzb3VyY2VzIChrZXlzIGFyZSB0aGUgb2JqZWN0IGlkcylcbiAgICB2YXIgX3Jlc291cmNlcyA9IHt9O1xuICAgIHZhciBfaW50ZXJuYWxSZXMgPSB7fTtcblxuICAgIC8vIElmIHRoZSBzb2NrZXQgcmVzZXRzIG9yIGNvbm5lY3RzIHRoZW4gcmVmZXRjaCBldmVyeXRoaW5nXG4gICAgc29jay5vbigncmVzZXQnLCBmdW5jdGlvbigpIHtcbiAgICAgIHJlZnJlc2hSZXNvdXJjZXMoKTtcbiAgICB9KTtcbiAgICBzb2NrLm9uKCdjb25uZWN0ZWQnLCBmdW5jdGlvbigpIHtcbiAgICAgIHJlZnJlc2hSZXNvdXJjZXMoKTtcbiAgICB9KTtcblxuICAgIC8vIExpc3RlbiBmb3IgbW9kaWZpZWQgZ2V0c1xuICAgIHNvY2sub24oJ21vZGlmaWVkIGdldCcsIGZ1bmN0aW9uKGlkKSB7XG4gICAgICBpZiAoaWQpIHtcbiAgICAgICAgdmFyIHJlcyA9IF9yZXNvdXJjZXNbaWRdO1xuICAgICAgICBpZiAocmVzKSB7XG4gICAgICAgICAgcmVzLiRyZWZyZXNoKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGZ1bmN0aW9uIHRvT2JqZWN0KCkge1xuICAgICAgcmV0dXJuIHV0aWxzLnRvT2JqZWN0KHRoaXMpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlZnJlc2hSZXNvdXJjZXMoKSB7XG4gICAgICBTZXJ2ZXJSZXNvdXJjZS5nZXQoa2V5cyhfcmVzb3VyY2VzKSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLy8gUmV0dXJucyB0aGUgb2JqZWN0IG9yIGEgbGlzdCBvZiBvYmplY3RzIChkZXBlbmRpbmcgb24gaWRzIHBhc3NlZCBpbilcbiAgICAvLyBUaGUgYXJyYXkgb3Igb2JqZWN0IHdpbGwgaGF2ZSB0aGUgJHByb21pc2UgYXR0cmlidXRlIHRvIHVzZS5cbiAgICBmdW5jdGlvbiBnZXQoaWRzLCBmb3JjZSwgdHJhbnNmb3JtKSB7XG5cbiAgICAgIGlmIChhbmd1bGFyLmlzRnVuY3Rpb24oZm9yY2UpKSB7XG4gICAgICAgIHRyYW5zZm9ybSA9IGZvcmNlO1xuICAgICAgICBmb3JjZSA9IGZhbHNlO1xuICAgICAgfVxuXG4gICAgICBpZiAoIXRyYW5zZm9ybSkge1xuICAgICAgICB0cmFuc2Zvcm0gPSBmdW5jdGlvbih2YWwpIHsgcmV0dXJuIHZhbDsgfTtcbiAgICAgIH1cblxuICAgICAgdmFyIHNpbmdsZUlkID0gZmFsc2U7XG4gICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuXG4gICAgICBmdW5jdGlvbiB0cmFuc2Zvcm1SZXN1bHRzKCkge1xuICAgICAgICBpZiAoc2luZ2xlSWQpIHtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0c1swXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBJZiB3ZSd2ZSBiZWVuIHBhc3NlZFxuICAgICAgaWYgKGFuZ3VsYXIuaXNTdHJpbmcoaWRzKSkge1xuICAgICAgICBzaW5nbGVJZCA9IHRydWU7XG4gICAgICAgIGlkcyA9IFtpZHNdO1xuICAgICAgfVxuXG4gICAgICAvLyBNYWtlIHN1cmUgd2UgaGF2ZSBubyByZXBlYXRlZCBpdGVtcyBpbiB0aGUgYXJyYXlcbiAgICAgIGlkcyA9IHVuaXEoaWRzKTtcblxuICAgICAgLy8gR28gYW5kIGxvYWQgaW4gdGhlIHJlc3VsdHMsIGNvbXBpbGluZyBhIGxpc3Qgb2YgcmVzb3VyY2VzIHdlIG5lZWQgdG8gZ28gYW5kIGZldGNoXG4gICAgICB2YXIgdW5rbm93bklkcyA9IFtdO1xuICAgICAgaWRzLmZvckVhY2goZnVuY3Rpb24oaWQpIHtcbiAgICAgICAgdmFyIHJlcyA9IF9yZXNvdXJjZXNbaWRdO1xuICAgICAgICBpZiAocmVzKSB7XG4gICAgICAgICAgcmVzdWx0cy5wdXNoKHRyYW5zZm9ybShyZXMsIGlkKSk7XG5cbiAgICAgICAgICAvLyBJZiB3ZSBhcmUgZm9yY2luZyB0aGVuIHdlIHdhbnQgdG8gZ28gYW5kIHJlZmV0Y2ggYXNzdW1pbmcgd2UndmUgYWxyZWFkeSByZXNvbHZlZFxuICAgICAgICAgIC8vIElmIHdlIGhhdmVuJ3QgcmVzb2x2ZWQgdGhlbiB3ZSBhcmUgZ29pbmcgdG8gcmVmcmVzaCB0aGUgZGF0YSBhbnl3YXkgc28gZG9uJ3QgZG9cbiAgICAgICAgICAvLyBhbnl0aGluZyBoZXJlLiBJZiB3ZSBhcmVuJ3QgcmVzb2x2ZWQgYW5kIHdlIGFyZW4ndCBmZXRjaGluZyB0aGVuIHdlIHdhbnQgdG9cbiAgICAgICAgICAvLyBnbyBhbmQgcmVmcmVzaCB0aGUgZGF0YSBiZWNhdXNlIHdlIGNvdWxkIGhhdmUgYmVlbiBjcmVhdGVkIGZyb20gc29tZXdoZXJlIHRoYXRcbiAgICAgICAgICAvLyBpc24ndCB0aGUgc2VydmVyXG4gICAgICAgICAgaWYgKChmb3JjZSAmJiByZXMuJHJlc29sdmVkKSB8fCAhKHJlcy4kcmVzb2x2ZWQgfHwgcmVzLiRmZXRjaGluZykpIHtcbiAgICAgICAgICAgIHVua25vd25JZHMucHVzaChpZCk7XG4gICAgICAgICAgICByZXMuJGZldGNoaW5nID0gdHJ1ZTtcblxuICAgICAgICAgICAgLy8gSWYgd2UndmUgYWxyZWFkeSByZXNvbHZlZCB0aGVuIGNyZWF0ZSBhIG5ldyBwcm9taXNlIG9iamVjdCBvbiB0aGUgcmVzb3VyY2VcbiAgICAgICAgICAgIGlmIChyZXMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgICAgIHJlcy4kZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICByZXMuJHByb21pc2UgPSByZXMuJGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgICAgICAgIHJlcy4kcmVzb2x2ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gSGF2ZW4ndCBzZWVuIHRoaXMgaWQgeWV0LiBDcmVhdGUgYSBuZXcgcmVzb3VyY2UgYW5kIHN0b3JlIGl0IG9mZlxuICAgICAgICAgIHJlcyA9IF9yZXNvdXJjZXNbaWRdID0gbmV3IFNlcnZlclJlc291cmNlKCk7XG4gICAgICAgICAgcmVzLiRmZXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgcmVzdWx0cy5wdXNoKHRyYW5zZm9ybShyZXMsIGlkKSk7XG4gICAgICAgICAgdW5rbm93bklkcy5wdXNoKGlkKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIC8vIERvIHdlIGhhdmUgYW55IGlkcyB0byBmZXRjaC4gSWYgc28gZ28gYW5kIGdldCB0aGVtXG4gICAgICBpZiAodW5rbm93bklkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHZhciByZXEgPSBzb2NrLmdldCh1bmtub3duSWRzKTtcbiAgICAgICAgcmVxLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcblxuICAgICAgICAgIC8vIFdlIG1pZ2h0IG5vdCBnZXQgYSByZXNwb25zZSAoc2F5IGlmIHRoZSBhcHAgaXMgb2ZmbGluZSkuIEluIHRoaXMgY2FzZVxuICAgICAgICAgIC8vIHdlIGp1c3QgcmVzb2x2ZSBldmVyeXRoaW5nIGFzIGlzLlxuICAgICAgICAgIGlmIChhbmd1bGFyLmlzVW5kZWZpbmVkKHJlc3BvbnNlKSkge1xuICAgICAgICAgICAgdW5rbm93bklkcy5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICAgICAgICAgIHZhciByZXMgPSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgICAgICAgcmVzLiRmZXRjaGluZyA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgICAgIHJlcy4kcmVzb2x2ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlcy4kZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVzcG9uc2UuZm9yRWFjaChmdW5jdGlvbihyZXNkYXRhKSB7XG4gICAgICAgICAgICAgIGlmIChyZXNkYXRhLl9pZCkge1xuICAgICAgICAgICAgICAgIHZhciBpZCA9IHJlc2RhdGEuX2lkO1xuICAgICAgICAgICAgICAgIHZhciByZXMgPSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgICAgICAgICByZXMuJGZldGNoaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgdXBkYXRlVmFsKHJlcywgcmVzZGF0YSk7XG5cbiAgICAgICAgICAgICAgICAvLyBXZSd2ZSBnb3QgdGhlIGRhdGEgZm9yIHRoZSBmaXJzdCB0aW1lIC0gcmVzb2x2ZSB0aGUgZGVmZXJyZWRcbiAgICAgICAgICAgICAgICBpZiAoIXJlcy4kcmVzb2x2ZWQpIHtcbiAgICAgICAgICAgICAgICAgIHJlcy4kZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xuICAgICAgICAgICAgICAgICAgcmVzLiRyZXNvbHZlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gSWYgYW55IG9mIG91ciB1bmtub3duIGlkcyBoYXNuJ3QgYmVlbiByZXNvbHZlZCB0aGVuIHdlIGFzc3VtZSBpdHMgZGVsZXRlZC4uLlxuICAgICAgICAgICAgdW5rbm93bklkcy5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICAgICAgICAgIHZhciByZXMgPSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgICAgICAgaWYgKCFyZXMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICByZXMuJGZldGNoaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgICAgIHJlcy4kZGVsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVzLiRlbWl0dGVyLmVtaXQoJ3VwZGF0ZScsIG51bGwsIHJlcy4kdG9PYmplY3QoKSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSwgZnVuY3Rpb24ocmVhc29uKSB7XG4gICAgICAgICAgLy8gSGFuZGxlIGFuIGVycm9yLi4uXG4gICAgICAgICAgLy8gQ2xlYW4gdXAgYW55IG9mIG91ciB1bmtub3duIGlkcyAtIHdlIGRvbid0IGtub3cgYWJvdXQgdGhlbVxuICAgICAgICAgIHVua25vd25JZHMuZm9yRWFjaChmdW5jdGlvbihpZCkge1xuICAgICAgICAgICAgdmFyIHJlcyA9IF9yZXNvdXJjZXNbaWRdO1xuICAgICAgICAgICAgcmVzLiRmZXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgcmVzLiRkZWZlcnJlZC5yZWplY3QocmVhc29uKTtcbiAgICAgICAgICAgIGRlbGV0ZSBfcmVzb3VyY2VzW2lkXTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGlmICghc2luZ2xlSWQpIHtcbiAgICAgICAgLy8gV2FpdCBmb3IgYWxsIHRoZSBwcm9taXNlcyB0byBiZSByZXNvbHZlZCBiZWZvcmUgcmVzb2x2aW5nXG4gICAgICAgIHZhciBwcm9taXNlcyA9IFtdO1xuICAgICAgICByZXN1bHRzLmZvckVhY2goZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgcHJvbWlzZXMucHVzaChyZXMuJHByb21pc2UpO1xuICAgICAgICB9KTtcblxuICAgICAgICB2YXIgdG1wUHJvbSA9ICRxLmFsbChwcm9taXNlcyk7XG4gICAgICAgIHJlc3VsdHMuJHByb21pc2UgPSB0bXBQcm9tLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgLy8gUmV0dXJuIHRoZSByZXN1bHRzIGFycmF5IGFzIHdlIHJlc29sdmVcbiAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0cmFuc2Zvcm1SZXN1bHRzKCk7XG4gICAgfVxuXG4gICAgLy8gUGVyZm9ybSBhIHNhdmVcbiAgICBmdW5jdGlvbiBzYXZlKHBhdGNoKSB7XG4gICAgICB1dGlscy5hcHBseVBhdGNoKHRoaXMsIHBhdGNoKTtcblxuICAgICAgLy8gV2UgdXBkYXRlIGlmIHdlIGhhdmUgYW4gX2lkIC0gb3RoZXJ3aXNlIHdlIGNyZWF0ZS5cbiAgICAgIGlmICh0aGlzLl9pZCkge1xuICAgICAgICByZXR1cm4gdXBkYXRlUmVzb3VyY2UodGhpcywgcGF0Y2gpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gVGhpcyBpcyBhbiBpbml0aWFsIGNyZWF0ZVxuICAgICAgICByZXR1cm4gY3JlYXRlUmVzb3VyY2UodGhpcyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdXBkYXRlUmVzb3VyY2UocmVzLCBwYXRjaCkge1xuICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgIHZhciByZXEgPSBzb2NrLnBhdGNoKHJlcy5faWQsIHBhdGNoKTtcbiAgICAgIHJlcS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgIHVwZGF0ZVZhbChyZXMsIHJlc3BvbnNlKTtcbiAgICAgICAgLy8gUmVzb2x2ZSB0aGUgZGVmZXJyZWRcbiAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xuICAgICAgICBfcmVzb3VyY2VzW3Jlcy5faWRdID0gcmVzO1xuICAgICAgICBpZiAoIXJlcy4kcmVzb2x2ZWQpIHtcbiAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICByZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICB9LCBmdW5jdGlvbihyZWFzb24pIHtcblxuICAgICAgICAvLyBTb21ldGhpbmcgd2VudCB3cm9uZyAtIGdvIGFuZCBmZXRjaCB0aGUgb2JqZWN0IGFnYWluIHNvIHdlIGFyZSB1cCB0byBkYXRlXG4gICAgICAgIGlmIChyZXMuX2lkKSB7XG4gICAgICAgICAgcmVzLiRyZWZyZXNoKCk7XG4gICAgICAgIH1cblxuICAgICAgICBkZWZlcnJlZC5yZWplY3QocmVhc29uKTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjcmVhdGVSZXNvdXJjZShyZXMpIHtcbiAgICAgIHZhciBkYXRhID0gcmVzLiR0b09iamVjdCgpO1xuXG4gICAgICB2YXIgcmVxID0gc29jay5jcmVhdGUoZGF0YSk7XG4gICAgICByZXR1cm4gcmVxLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgLy8gVGhlcmUgY291bGQgYmUgYSByYWNlIGNvbmRpdGlvbiBoZXJlIHdoZXJlIHdlIGNvdWxkIGVuZCB1cCBjcmVhdGluZyB0aGUgaWQgbWFwXG4gICAgICAgIC8vIGVhcmxpZXIgKG1heWJlLi4uPylcbiAgICAgICAgdXBkYXRlVmFsKHJlcywgcmVzcG9uc2UpO1xuICAgICAgICBfcmVzb3VyY2VzW3Jlcy5faWRdID0gcmVzO1xuXG4gICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgIHJlcy4kZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xuICAgICAgICAgIHJlcy4kcmVzb2x2ZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZW1vdmUoKSB7XG5cbiAgICAgIHZhciByZXMgPSB0aGlzO1xuICAgICAgcmVzLiRkZWxldGVkID0gdHJ1ZTtcblxuXG4gICAgICB2YXIgcmVxID0gc29jay5yZW1vdmUocmVzLl9pZCk7XG4gICAgICByZXR1cm4gcmVxLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgICAgZGVsZXRlIF9yZXNvdXJjZXNbcmVzLl9pZF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzLiRkZWxldGVkID0gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBVcGRhdGVzIHRoZSB2YWx1ZSBmcm9tIHRoZSBzZXJ2ZXJcbiAgICBmdW5jdGlvbiB1cGRhdGVWYWwocmVzLCB2YWwpIHtcblxuICAgICAgLy8gRG8gd2UgaGF2ZSBhIG51bGwgdmFsdWUgKGluZGljYXRpbmcgdGhlIHJlc291cmNlIGhhcyBiZWVuIGRlbGV0ZWQ/KVxuICAgICAgaWYgKHZhbCkge1xuICAgICAgICAvLyBDb252ZXJ0IGFueSBKU09OIGRhdGVzIGludG8gZGF0ZXNcbiAgICAgICAgdmFsID0gdXRpbHMuY29udmVydEpzb25EYXRlcyh2YWwpO1xuXG4gICAgICAgIHZhciBvbGREYXRhID0gcmVzLiR0b09iamVjdCgpO1xuICAgICAgICB1dGlscy5yZW1vdmVSZXNWYWx1ZXMocmVzKTtcbiAgICAgICAgdXRpbHMuc2V0UmVzVmFsdWVzKHJlcywgdmFsKTtcblxuICAgICAgICAvLyBNYWtlIHN1cmUgd2UgaGF2ZSBzdG9yZSB0aGlzIHJlc291cmNlIG9mZlxuICAgICAgICBfcmVzb3VyY2VzW3Jlcy5faWRdID0gcmVzO1xuICAgICAgICByZXMuJGVtaXR0ZXIuZW1pdCgndXBkYXRlJywgcmVzLiR0b09iamVjdCgpLCBvbGREYXRhKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIERlbGV0ZWQgLSBjbGVhbiBtZSB1cCBzY290dHlcbiAgICAgICAgZGVsZXRlIF9yZXNvdXJjZXNbcmVzLl9pZF07XG4gICAgICAgIHJlcy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCBudWxsLCByZXMuJHRvT2JqZWN0KCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIF91cGRhdGVWYWwodmFsKSB7XG4gICAgICByZXR1cm4gdXBkYXRlVmFsKHRoaXMsIHZhbCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVmcmVzaCgpIHtcbiAgICAgIGlmICh0aGlzLl9pZCkge1xuICAgICAgICBnZXQodGhpcy5faWQsIHRydWUpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZSBtYWluIGNvbnN0cnVjdG9yIGZvciB0aGVTZXJ2ZXJSZXNvdXJjZSBjbGFzc1xuICAgIGZ1bmN0aW9uIFNlcnZlclJlc291cmNlKHZhbCwgaWQpIHtcbiAgICAgIHZhciByZXMgPSB0aGlzO1xuICAgICAgdGhpcy4kZW1pdHRlciA9IG5ldyBldmVudHMuRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgIHRoaXMuJGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgIHRoaXMuJHByb21pc2UgPSB0aGlzLiRkZWZlcnJlZC5wcm9taXNlOyAvLyBBbiBpbml0aWFsIHByb21pc2UgZm9yIG91ciBpbml0aWFsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gZmV0Y2ggb3IgY3JlYXRlIG9mIGRhdGFcbiAgICAgIHRoaXMuJHJlc29sdmVkID0gZmFsc2U7IC8vIEhhdmUgd2UgaGFkIGFuIGluaXRpYWwgcmVzb2x1dGlvbiBvZiB0aGUgcHJvbWlzZVxuICAgICAgdGhpcy4kZGVsZXRlZCA9IGZhbHNlOyAvLyBIYXMgdGhlIHJlc291cmNlIGJlZW4gZGVsZXRlZFxuICAgICAgdGhpcy4kZmV0Y2hpbmcgPSBmYWxzZTsgLy8gQXJlIHdlIGN1cnJlbnRseSBmZXRjaGluZyBkYXRhIGZvciB0aGlzIHJlc291cmNlXG5cbiAgICAgIHRoaXMuJGlkID0gaWQgPyBpZCA6IHV0aWxzLnV1aWQoKTtcblxuICAgICAgX2ludGVybmFsUmVzW3RoaXMuJGlkXSA9IHRoaXM7XG5cbiAgICAgIGZvciAodmFyIGtleSBpbiB2YWwpIHtcbiAgICAgICAgcmVzW2tleV0gPSB2YWxba2V5XTtcbiAgICAgIH1cblxuICAgICAgLy8gSWYgd2UgaGF2ZSBhbiBpZCB0aGVuIGFkZCB1cyB0byB0aGUgc3RvcmVcbiAgICAgIGlmICh0aGlzLl9pZCkge1xuICAgICAgICBfcmVzb3VyY2VzW3RoaXMuX2lkXSA9IHRoaXM7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIFNlcnZlclJlc291cmNlLmdldCA9IGdldDtcblxuICAgIFNlcnZlclJlc291cmNlLnByb3RvdHlwZS4kc2F2ZSA9IHNhdmU7XG4gICAgU2VydmVyUmVzb3VyY2UucHJvdG90eXBlLiRyZW1vdmUgPSByZW1vdmU7XG4gICAgU2VydmVyUmVzb3VyY2UucHJvdG90eXBlLiRkZWxldGUgPSByZW1vdmU7XG4gICAgU2VydmVyUmVzb3VyY2UucHJvdG90eXBlLiRyZWZyZXNoID0gcmVmcmVzaDtcbiAgICBTZXJ2ZXJSZXNvdXJjZS5wcm90b3R5cGUuJHRvT2JqZWN0ID0gdG9PYmplY3Q7XG4gICAgU2VydmVyUmVzb3VyY2UucHJvdG90eXBlLiR1cGRhdGVWYWwgPSBfdXBkYXRlVmFsO1xuXG4gICAgcmV0dXJuIFNlcnZlclJlc291cmNlO1xuICB9XG5cbiAgcmV0dXJuIFNlcnZlclJlc291cmNlRmFjdG9yeTtcbn1cbiJdLCJzb3VyY2VSb290IjoiL3NvdXJjZS8ifQ==
