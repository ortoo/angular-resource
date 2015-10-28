'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _events = require('events');

var _events2 = _interopRequireDefault(_events);

var _utils = require('./utils');

var _utils2 = _interopRequireDefault(_utils);

var _lodashValues = require('lodash.values');

var _lodashValues2 = _interopRequireDefault(_lodashValues);

var _angular = require('angular');

var _angular2 = _interopRequireDefault(_angular);

var _nedb = require('nedb');

var _nedb2 = _interopRequireDefault(_nedb);

var MAX_STORAGE_SIZE = 3 * 1024 * 1024; // 3MB - should fit without problems in any browser

exports['default'] = function ($q, $rootScope, $timeout, $window, ServerResourceFactory, QueryFactory, $localForage) {
  'ngInject';

  var totalStorageSize = 0;
  var totalDesiredSize = 0;
  var persistMode = 'FULL';
  var persistModeEmitter = new _events2['default'].EventEmitter();

  persistModeEmitter.setMaxListeners(0); // Unlimited listeners

  function LocalResourceFactory(url, rootKey, rootKeyPlural) {

    // Is nedb available? If so get a local collection started
    var db;
    if (_nedb2['default']) {
      db = new _nedb2['default']();

      // Stick an index on __id - our id field.
      db.ensureIndex({ fieldName: '__id' }, function (err) {
        if (err) {
          throw err;
        }
      });
    }

    // Create the server resource and query
    var ServerResource = ServerResourceFactory(url, rootKey, rootKeyPlural);
    var QueryList = QueryFactory(url, rootKey, rootKeyPlural, db);

    // In memory resource store
    var _resources = {};
    var _internalRes = {};

    var ourStorageSize = 0;
    var ourDesiredSize = 0;
    var persistModeWatching = false;

    var _lastreqs = {};
    var _reqs = {};

    var pStorageKey = _utils2['default'].persistentStorageKey(url);
    var persistProm = null;

    function toObject() {
      return _utils2['default'].toObject(this);
    }

    function dbToRes(dbModel) {
      return _internalRes[dbModel.__$id];
    }

    function dbToModel(dbModel) {
      var loc = dbToRes(dbModel);
      return loc.$mod;
    }

    function serverTransform(serv, id, transformer) {
      var res = _internalRes[serv.$id];

      // If we don't have a resource then create it
      if (!res) {
        res = new LocalResource(serv, true);
      }

      if (id) {
        _resources[id] = res;
      }

      return transformer(res, id);
    }

    function get(ids, force, transform) {
      // We've requested a bunch of ids
      // We should persist the change (to offline storage) if this is the first request
      // for this (these) objects
      var now = new Date().getTime();
      var isSomeFirst = false;
      if (_angular2['default'].isArray(ids)) {
        ids.forEach(function (id) {
          if (!_reqs[id]) {
            isSomeFirst = true;
          }

          _lastreqs[id] = now;
          _reqs[id] = true;
        });
      } else {
        if (!_reqs[ids]) {
          isSomeFirst = true;
        }

        _lastreqs[ids] = now;
        _reqs[ids] = true;
      }

      // If our persistMode is MIN we'll want to persist to storage here
      if (persistMode === 'MIN' && isSomeFirst) {
        persistChange();
      }

      return ServerResource.get(ids, force, function (serv, id) {
        return serverTransform(serv, id, transform);
      });
    }

    function query(qry, limit, Resource) {
      return QueryList(qry, limit, Resource, dbToModel);
    }

    function remove(skipServer) {
      if (this._id) {
        delete _resources[this._id];
      }

      this.$deleted = true;

      // Kick the database
      syncToStorage(this);

      // If we have been created then notify the server

      if (this.$created && !skipServer) {
        return this.$serv.$remove();
      }

      return $q.when(true);
    }

    // Once we are synced with the server resource we will resolve the promise
    function save(vals) {
      var res = this;
      res.$created = true;

      // Only trigger the server sync once per 'tick' (so calling save() multiple times
      // has no effect)
      if (!res.$saveprom) {
        var oldData = this.$toObject();
        res.$saveprom = $timeout(function () {
          res.$saveprom = null;

          // Save us to the db
          syncToStorage(res);

          var patch = _utils2['default'].diff(oldData, res.$toObject());
          return syncToServer(res, patch).then(function () {
            return res;
          });
        }).then(function () {
          if (!res.$resolved) {
            // Wait for the db to sync before resolving (if the sync is outstanding)
            var dbprom = res.$dbsync ? res.$dbsync : $q.when();
            dbprom.then(function () {
              res.$deferred.resolve(res);
              res.$resolved = true;
            });
          }
          return res;
        });
      }

      _utils2['default'].removeResValues(res);
      _utils2['default'].setResValues(res, vals);

      return res.$saveprom;
    }

    function performServerSync(res, patch) {
      // We are about to sync. Unset the resync flag
      res.$resync = [];

      // Wait for the server to finish saving. Then check if we need to resync. This promise
      // won't resolve until there are no more resyncs to do
      return res.$serv.$save(patch).then(function () {
        if (res.$resync.length > 0) {
          return performServerSync(res, res.$resync);
        }

        return res;
      });
    }

    function syncToServer(res, patch) {
      if (res.$sync) {
        res.$resync.push.apply(res.$resync, patch);
      } else {
        var prom = performServerSync(res, patch)['finally'](function () {
          // Once we've synced remove the $sync promise
          delete res.$sync;
        });

        res.$sync = prom;
      }

      return res.$sync;
    }

    function updatedServer(res, newVal, oldVal) {

      // We could have been deleted (existing oldVal, null newval)
      if (oldVal && !newVal) {
        // We have been deleted. Cleanup ourselves and pass it up the chain
        res.$emitter.emit('update', null, res.$toObject());
        res.$remove(true);
      } else {
        res.$created = true;

        if (oldVal._id && newVal._id !== oldVal._id) {
          throw new Error('Not allowed to change id');
        }

        // Merge the objects together using the oldVal as a base, and using *our* version
        // to resolve any conflicts. We may need to put in some conflict resolution logic
        // somewhere on a case by case basis
        var preexist = res.$toObject();
        var merge = _utils2['default'].mergeObjects(res.$toObject(), oldVal, newVal);

        // Now put back in the merge values
        _utils2['default'].removeResValues(res);
        _utils2['default'].setResValues(res, merge);

        // Make sure we are stored
        _resources[res._id] = res;

        // If we've only just been given an id then store of the created time as the
        // time we were last requested (this is because the object must have just been
        // created on the server)
        if (res._id && !oldVal._id) {
          _lastreqs[res._id] = res.$createdAt;
          _reqs[res._id] = true;
        }

        // Notify that we have changed
        res.$emitter.emit('update', res.$toObject(), preexist);
        // Kick the db
        var syncprom = syncToStorage(res) || $q.when();

        syncprom.then(function () {
          // We might have synced for the first time
          return res.$serv.$promise.then(function () {
            if (!res.$resolved) {
              res.$deferred.resolve(res);
              res.$resolved = true;
            }
          });
        });
      }
    }

    function performDbSync(res) {
      res.$dbresync = false;
      return updateToDb(res).then(function () {
        if (res.$dbresync) {
          return performDbSync(res);
        }

        return;
      });
    }

    function watchForPersistModeChanges() {
      if (persistModeWatching) {
        return;
      }

      persistModeEmitter.on('change', function (_url) {
        // If we have called this then ignore
        if (_url === url) {
          return;
        }

        // Redo the persist
        doPersist();
      });
    }

    function doPersist() {
      // If we're already doing a persist or we dont have advanced storage options then
      // just return
      if (persistMode === 'NONE' || !_utils2['default'].advancedStorage($localForage)) {
        return $q.when();
      }

      // If this is the first time through then stick a listener on for changes
      if (!persistModeWatching) {
        watchForPersistModeChanges();
      }

      var data = [];

      switch (persistMode) {
        case 'FULL':
          data = (0, _lodashValues2['default'])(_resources).map(function (res) {
            return {
              obj: res.$toObject(),
              lastreq: _lastreqs[res._id]
            };
          });
          break;

        case 'MIN':
          (0, _lodashValues2['default'])(_resources).forEach(function (res) {
            if (_reqs[res._id]) {
              data.push({
                obj: res.$toObject(),
                lastreq: _lastreqs[res._id]
              });
            }
          });
          break;
      }

      // We need to manually manage storage
      var dataStr = JSON.stringify(data);

      var newStorageSize = dataStr.length;
      var expectedSize = totalDesiredSize - ourDesiredSize + newStorageSize;

      // Do we expect to bust the max size? If so we need to change persist mode
      // and emit
      if (expectedSize > MAX_STORAGE_SIZE) {
        if (persistMode === 'FULL') {
          persistMode = 'MIN';
        } else if (persistMode === 'MIN') {
          persistMode = 'NONE';
        } else {
          // Don't know how we could get here but return just in case
          return;
        }

        persistModeEmitter.emit('change', url);

        // Schedule this later
        return $timeout(doPersist, 0, false);
      }

      // MODE HAS NOT CHANGED

      // Store our expected size
      totalDesiredSize = expectedSize;
      ourDesiredSize = newStorageSize;

      return $localForage.setItem(pStorageKey, data).then(function () {
        totalStorageSize = totalStorageSize - ourStorageSize + newStorageSize;
        ourStorageSize = newStorageSize;
      });
    }

    function persistChange() {
      // If we're already doing a persist or we dont have advanced storage options then
      // just return
      if (persistProm || persistMode === 'NONE' || !_utils2['default'].advancedStorage($localForage)) {
        return;
      }

      persistProm = $timeout(function () {
        return doPersist().then(function () {
          // Finished the persist
          persistProm = null;
        });
      }, 500);
    }

    function syncToStorage(res) {

      persistChange();

      // If we have no db then exit
      if (!db) {
        return;
      }

      if (res.$dbsync) {
        res.$dbresync = true;
      } else {
        var prom = performDbSync(res);

        prom['finally'](function () {
          // Whatever happens remove the $sync promise and refresh all the queries
          delete res.$dbsync;
          res.$dbresync = false;
          QueryList.refresh();
        });

        res.$dbsync = prom;
      }

      return res.$dbsync;
    }

    function updateToDb(res) {

      // We need to transform the resource by replacing the _id field (nedb uses its own id in that
      // place). Instead call it __id
      var doc = res.$toObject();
      doc.__id = doc._id;
      doc.__$id = res.$id;
      delete doc._id;

      var deferred = $q.defer();
      if (!res.$dbid && !res.$deleted) {
        db.insert(doc, function (err, newDoc) {
          $rootScope.$apply(function () {
            if (err) {
              deferred.reject(err);
              return;
            }
            res.$dbid = newDoc._id;
            deferred.resolve();
          });
        });
      } else if (res.$deleted) {
        db.remove({ _id: res.$dbid }, { multi: true }, function (err) {
          $rootScope.$apply(function () {
            if (err) {
              deferred.reject(err);
              return;
            }

            deferred.resolve();
          });
        });
      } else {
        db.update({ _id: res.$dbid }, doc, {}, function (err) {
          $rootScope.$apply(function () {
            if (err) {
              deferred.reject(err);
              return;
            }
            deferred.resolve();
          });
        });
      }

      return deferred.promise;
    }

    function updateServer(val) {
      this.$serv.$updateVal(val);
    }

    function refresh() {
      this.$serv.$refresh();
    }

    function LocalResource(val, fromServ, mod, lastRequested) {
      var res = this;
      this.$emitter = new _events2['default'].EventEmitter();

      this.$deferred = $q.defer();
      this.$promise = this.$deferred.promise; // An initial promise for our initial
      // fetch or create of data
      this.$resolved = false; // Have we had an initial resolution of the promise
      this.$created = false; // Have we pushed any values down to the server yet?

      this.$createdAt = new Date().getTime();

      this.$resync = [];
      this.$saveprom = null;
      this.$deleted = false;

      // Store off the model so we can reference it later
      this.$mod = mod;

      // Used to correlate to the db objects when we don't have an _id (creating)
      this.$id = fromServ ? val.$id : _utils2['default'].uuid();
      _internalRes[this.$id] = this;

      // If we've been given values put them on
      if (val) {
        var props = fromServ ? val.$toObject() : val;

        for (var key in props) {
          res[key] = props[key];
        }
      }

      if (val && fromServ) {
        this.$serv = val;
      } else if (this._id) {
        this.$serv = new ServerResource(val, this.$id);
      } else {
        // Don't add in the values until we save
        this.$serv = new ServerResource(null, this.$id);
      }

      // If we have an id then add us to the store
      if (this._id) {
        _resources[this._id] = this;
      }

      // If we have an id and we've been passed in a last requested time then store off
      // the last requested time
      if (this._id && lastRequested) {
        // If the last requested already exists use the max
        var existing = _lastreqs[this._id] || 0;
        _lastreqs[this._id] = Math.max(lastRequested, existing);
      }

      // Listen for changes on the server
      this.$serv.$emitter.on('update', function (newVal, oldVal) {
        updatedServer(res, newVal, oldVal);
      });

      // Update us in the db
      this.$dbresync = false;

      // If it's from the server don't create it yet. Wait for the update to come (along
      // with hopefully all the data)
      if (!fromServ && val) {
        syncToStorage(this);
      }
    }

    LocalResource.get = get;
    LocalResource.query = query;

    LocalResource.prototype.$save = save;
    LocalResource.prototype.$remove = remove;
    LocalResource.prototype.$delete = remove;
    LocalResource.prototype.$toObject = toObject;
    LocalResource.prototype.$updateServer = updateServer;
    LocalResource.prototype.$refresh = refresh;

    return LocalResource;
  }

  return LocalResourceFactory;
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImxvY2FsLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O3NCQUFtQixRQUFROzs7O3FCQUNULFNBQVM7Ozs7NEJBRVIsZUFBZTs7Ozt1QkFFZCxTQUFTOzs7O29CQUNQLE1BQU07Ozs7QUFFNUIsSUFBSSxnQkFBZ0IsR0FBRyxDQUFDLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQzs7cUJBRXhCLFVBQVMsRUFBRSxFQUNGLFVBQVUsRUFDVixRQUFRLEVBQ1IsT0FBTyxFQUNQLHFCQUFxQixFQUNyQixZQUFZLEVBQ1osWUFBWSxFQUFFO0FBQ3BDLFlBQVUsQ0FBQzs7QUFFWCxNQUFJLGdCQUFnQixHQUFHLENBQUMsQ0FBQztBQUN6QixNQUFJLGdCQUFnQixHQUFHLENBQUMsQ0FBQztBQUN6QixNQUFJLFdBQVcsR0FBRyxNQUFNLENBQUM7QUFDekIsTUFBSSxrQkFBa0IsR0FBRyxJQUFJLG9CQUFPLFlBQVksRUFBRSxDQUFDOztBQUVuRCxvQkFBa0IsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUM7O0FBRXRDLFdBQVMsb0JBQW9CLENBQUMsR0FBRyxFQUFFLE9BQU8sRUFBRSxhQUFhLEVBQUU7OztBQUd6RCxRQUFJLEVBQUUsQ0FBQztBQUNQLDJCQUFlO0FBQ2IsUUFBRSxHQUFHLHVCQUFlLENBQUM7OztBQUdyQixRQUFFLENBQUMsV0FBVyxDQUFDLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxFQUFFLFVBQVUsR0FBRyxFQUFFO0FBQ25ELFlBQUksR0FBRyxFQUFFO0FBQ1AsZ0JBQU0sR0FBRyxDQUFDO1NBQ1g7T0FDRixDQUFDLENBQUM7S0FDSjs7O0FBR0QsUUFBSSxjQUFjLEdBQUcscUJBQXFCLENBQUMsR0FBRyxFQUFFLE9BQU8sRUFBRSxhQUFhLENBQUMsQ0FBQztBQUN4RSxRQUFJLFNBQVMsR0FBRyxZQUFZLENBQUMsR0FBRyxFQUFFLE9BQU8sRUFBRSxhQUFhLEVBQUUsRUFBRSxDQUFDLENBQUM7OztBQUc5RCxRQUFJLFVBQVUsR0FBRyxFQUFFLENBQUM7QUFDcEIsUUFBSSxZQUFZLEdBQUcsRUFBRSxDQUFDOztBQUV0QixRQUFJLGNBQWMsR0FBRyxDQUFDLENBQUM7QUFDdkIsUUFBSSxjQUFjLEdBQUcsQ0FBQyxDQUFDO0FBQ3ZCLFFBQUksbUJBQW1CLEdBQUcsS0FBSyxDQUFDOztBQUVoQyxRQUFJLFNBQVMsR0FBRyxFQUFFLENBQUM7QUFDbkIsUUFBSSxLQUFLLEdBQUcsRUFBRSxDQUFDOztBQUVmLFFBQUksV0FBVyxHQUFHLG1CQUFNLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2xELFFBQUksV0FBVyxHQUFHLElBQUksQ0FBQzs7QUFFdkIsYUFBUyxRQUFRLEdBQUc7QUFDbEIsYUFBTyxtQkFBTSxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7S0FDN0I7O0FBRUQsYUFBUyxPQUFPLENBQUMsT0FBTyxFQUFFO0FBQ3hCLGFBQU8sWUFBWSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztLQUNwQzs7QUFFRCxhQUFTLFNBQVMsQ0FBQyxPQUFPLEVBQUU7QUFDMUIsVUFBSSxHQUFHLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQzNCLGFBQU8sR0FBRyxDQUFDLElBQUksQ0FBQztLQUNqQjs7QUFFRCxhQUFTLGVBQWUsQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLFdBQVcsRUFBRTtBQUM5QyxVQUFJLEdBQUcsR0FBRyxZQUFZLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDOzs7QUFHakMsVUFBSSxDQUFDLEdBQUcsRUFBRTtBQUNSLFdBQUcsR0FBRyxJQUFJLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7T0FDckM7O0FBRUQsVUFBSSxFQUFFLEVBQUU7QUFDTixrQkFBVSxDQUFDLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQztPQUN0Qjs7QUFFRCxhQUFPLFdBQVcsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLENBQUM7S0FDN0I7O0FBRUQsYUFBUyxHQUFHLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxTQUFTLEVBQUU7Ozs7QUFJbEMsVUFBSSxHQUFHLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUMvQixVQUFJLFdBQVcsR0FBRyxLQUFLLENBQUM7QUFDeEIsVUFBSSxxQkFBUSxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUU7QUFDeEIsV0FBRyxDQUFDLE9BQU8sQ0FBQyxVQUFTLEVBQUUsRUFBRTtBQUN2QixjQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxFQUFFO0FBQ2QsdUJBQVcsR0FBRyxJQUFJLENBQUM7V0FDcEI7O0FBRUQsbUJBQVMsQ0FBQyxFQUFFLENBQUMsR0FBRyxHQUFHLENBQUM7QUFDcEIsZUFBSyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQztTQUNsQixDQUFDLENBQUM7T0FDSixNQUFNO0FBQ0wsWUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRTtBQUNmLHFCQUFXLEdBQUcsSUFBSSxDQUFDO1NBQ3BCOztBQUVELGlCQUFTLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDO0FBQ3JCLGFBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUM7T0FDbkI7OztBQUdELFVBQUksV0FBVyxLQUFLLEtBQUssSUFBSSxXQUFXLEVBQUU7QUFDeEMscUJBQWEsRUFBRSxDQUFDO09BQ2pCOztBQUVELGFBQU8sY0FBYyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLFVBQVMsSUFBSSxFQUFFLEVBQUUsRUFBRTtBQUN2RCxlQUFPLGVBQWUsQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLFNBQVMsQ0FBQyxDQUFDO09BQzdDLENBQUMsQ0FBQztLQUNKOztBQUVELGFBQVMsS0FBSyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFO0FBQ25DLGFBQU8sU0FBUyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0tBQ25EOztBQUVELGFBQVMsTUFBTSxDQUFDLFVBQVUsRUFBRTtBQUMxQixVQUFJLElBQUksQ0FBQyxHQUFHLEVBQUU7QUFDWixlQUFPLFVBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7T0FDN0I7O0FBRUQsVUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUM7OztBQUdyQixtQkFBYSxDQUFDLElBQUksQ0FBQyxDQUFDOzs7O0FBSXBCLFVBQUksSUFBSSxDQUFDLFFBQVEsSUFBSSxDQUFDLFVBQVUsRUFBRTtBQUNoQyxlQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLENBQUM7T0FDN0I7O0FBRUQsYUFBTyxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0tBQ3RCOzs7QUFHRCxhQUFTLElBQUksQ0FBQyxJQUFJLEVBQUU7QUFDbEIsVUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDO0FBQ2YsU0FBRyxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUM7Ozs7QUFJcEIsVUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUU7QUFDbEIsWUFBSSxPQUFPLEdBQUcsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO0FBQy9CLFdBQUcsQ0FBQyxTQUFTLEdBQUcsUUFBUSxDQUFDLFlBQVc7QUFDbEMsYUFBRyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUM7OztBQUdyQix1QkFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDOztBQUVuQixjQUFJLEtBQUssR0FBRyxtQkFBTSxJQUFJLENBQUMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO0FBQ2pELGlCQUFPLFlBQVksQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVc7QUFDOUMsbUJBQU8sR0FBRyxDQUFDO1dBQ1osQ0FBQyxDQUFDO1NBQ0osQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFXO0FBQ2pCLGNBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFOztBQUVsQixnQkFBSSxNQUFNLEdBQUcsR0FBRyxDQUFDLE9BQU8sR0FBRyxHQUFHLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNuRCxrQkFBTSxDQUFDLElBQUksQ0FBQyxZQUFXO0FBQ3JCLGlCQUFHLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUMzQixpQkFBRyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUM7YUFDdEIsQ0FBQyxDQUFDO1dBQ0o7QUFDRCxpQkFBTyxHQUFHLENBQUM7U0FDWixDQUFDLENBQUM7T0FDSjs7QUFFRCx5QkFBTSxlQUFlLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IseUJBQU0sWUFBWSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQzs7QUFFOUIsYUFBTyxHQUFHLENBQUMsU0FBUyxDQUFDO0tBQ3RCOztBQUVELGFBQVMsaUJBQWlCLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRTs7QUFFckMsU0FBRyxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7Ozs7QUFJakIsYUFBTyxHQUFHLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBVztBQUM1QyxZQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtBQUMxQixpQkFBTyxpQkFBaUIsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1NBQzVDOztBQUVELGVBQU8sR0FBRyxDQUFDO09BQ1osQ0FBQyxDQUFDO0tBQ0o7O0FBRUQsYUFBUyxZQUFZLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRTtBQUNoQyxVQUFJLEdBQUcsQ0FBQyxLQUFLLEVBQUU7QUFDYixXQUFHLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQztPQUM1QyxNQUFNO0FBQ0wsWUFBSSxJQUFJLEdBQUcsaUJBQWlCLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLFlBQVc7O0FBRTdELGlCQUFPLEdBQUcsQ0FBQyxLQUFLLENBQUM7U0FDbEIsQ0FBQyxDQUFDOztBQUVILFdBQUcsQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO09BQ2xCOztBQUVELGFBQU8sR0FBRyxDQUFDLEtBQUssQ0FBQztLQUNsQjs7QUFFRCxhQUFTLGFBQWEsQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRTs7O0FBRzFDLFVBQUksTUFBTSxJQUFJLENBQUMsTUFBTSxFQUFFOztBQUVyQixXQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLEdBQUcsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO0FBQ25ELFdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7T0FDbkIsTUFBTTtBQUNMLFdBQUcsQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDOztBQUVwQixZQUFJLE1BQU0sQ0FBQyxHQUFHLElBQUssTUFBTSxDQUFDLEdBQUcsS0FBSyxNQUFNLENBQUMsR0FBRyxBQUFDLEVBQUU7QUFDN0MsZ0JBQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLENBQUMsQ0FBQztTQUM3Qzs7Ozs7QUFLRCxZQUFJLFFBQVEsR0FBRyxHQUFHLENBQUMsU0FBUyxFQUFFLENBQUM7QUFDL0IsWUFBSSxLQUFLLEdBQUcsbUJBQU0sWUFBWSxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUM7OztBQUdoRSwyQkFBTSxlQUFlLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IsMkJBQU0sWUFBWSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQzs7O0FBRy9CLGtCQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQzs7Ozs7QUFLMUIsWUFBSSxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRTtBQUMxQixtQkFBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUMsVUFBVSxDQUFDO0FBQ3BDLGVBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDO1NBQ3ZCOzs7QUFHRCxXQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLFNBQVMsRUFBRSxFQUFFLFFBQVEsQ0FBQyxDQUFDOztBQUV2RCxZQUFJLFFBQVEsR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDOztBQUUvQyxnQkFBUSxDQUFDLElBQUksQ0FBQyxZQUFXOztBQUV2QixpQkFBTyxHQUFHLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsWUFBVztBQUN4QyxnQkFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUU7QUFDbEIsaUJBQUcsQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzNCLGlCQUFHLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQzthQUN0QjtXQUNGLENBQUMsQ0FBQztTQUNKLENBQUMsQ0FBQztPQUNKO0tBQ0Y7O0FBRUQsYUFBUyxhQUFhLENBQUMsR0FBRyxFQUFFO0FBQzFCLFNBQUcsQ0FBQyxTQUFTLEdBQUcsS0FBSyxDQUFDO0FBQ3RCLGFBQU8sVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFXO0FBQ3JDLFlBQUksR0FBRyxDQUFDLFNBQVMsRUFBRTtBQUNqQixpQkFBTyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7U0FDM0I7O0FBRUQsZUFBTztPQUNSLENBQUMsQ0FBQztLQUNKOztBQUVELGFBQVMsMEJBQTBCLEdBQUc7QUFDcEMsVUFBSSxtQkFBbUIsRUFBRTtBQUN2QixlQUFPO09BQ1I7O0FBRUQsd0JBQWtCLENBQUMsRUFBRSxDQUFDLFFBQVEsRUFBRSxVQUFTLElBQUksRUFBRTs7QUFFN0MsWUFBSSxJQUFJLEtBQUssR0FBRyxFQUFFO0FBQ2hCLGlCQUFPO1NBQ1I7OztBQUdELGlCQUFTLEVBQUUsQ0FBQztPQUNiLENBQUMsQ0FBQztLQUVKOztBQUVELGFBQVMsU0FBUyxHQUFHOzs7QUFHbkIsVUFBSSxXQUFXLEtBQUssTUFBTSxJQUFJLENBQUMsbUJBQU0sZUFBZSxDQUFDLFlBQVksQ0FBQyxFQUFFO0FBQ2xFLGVBQU8sRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDO09BQ2xCOzs7QUFHRCxVQUFJLENBQUMsbUJBQW1CLEVBQUU7QUFDeEIsa0NBQTBCLEVBQUUsQ0FBQztPQUM5Qjs7QUFFRCxVQUFJLElBQUksR0FBRyxFQUFFLENBQUM7O0FBRWQsY0FBTyxXQUFXO0FBQ2hCLGFBQUssTUFBTTtBQUNULGNBQUksR0FBRywrQkFBTyxVQUFVLENBQUMsQ0FBQyxHQUFHLENBQUMsVUFBUyxHQUFHLEVBQUU7QUFDMUMsbUJBQU87QUFDTCxpQkFBRyxFQUFFLEdBQUcsQ0FBQyxTQUFTLEVBQUU7QUFDcEIscUJBQU8sRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQzthQUM1QixDQUFDO1dBQ0gsQ0FBQyxDQUFDO0FBQ0gsZ0JBQU07O0FBQUEsQUFFUixhQUFLLEtBQUs7QUFDUix5Q0FBTyxVQUFVLENBQUMsQ0FBQyxPQUFPLENBQUMsVUFBUyxHQUFHLEVBQUU7QUFDdkMsZ0JBQUksS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRTtBQUNsQixrQkFBSSxDQUFDLElBQUksQ0FBQztBQUNSLG1CQUFHLEVBQUUsR0FBRyxDQUFDLFNBQVMsRUFBRTtBQUNwQix1QkFBTyxFQUFFLFNBQVMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO2VBQzVCLENBQUMsQ0FBQzthQUNKO1dBQ0YsQ0FBQyxDQUFDO0FBQ0gsZ0JBQU07QUFBQSxPQUNUOzs7QUFHRCxVQUFJLE9BQU8sR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDOztBQUVuQyxVQUFJLGNBQWMsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO0FBQ3BDLFVBQUksWUFBWSxHQUFHLGdCQUFnQixHQUFHLGNBQWMsR0FBRyxjQUFjLENBQUM7Ozs7QUFJdEUsVUFBSSxZQUFZLEdBQUcsZ0JBQWdCLEVBQUU7QUFDbkMsWUFBSSxXQUFXLEtBQUssTUFBTSxFQUFFO0FBQzFCLHFCQUFXLEdBQUcsS0FBSyxDQUFDO1NBQ3JCLE1BQU0sSUFBSSxXQUFXLEtBQUssS0FBSyxFQUFFO0FBQ2hDLHFCQUFXLEdBQUcsTUFBTSxDQUFDO1NBQ3RCLE1BQU07O0FBRUwsaUJBQU87U0FDUjs7QUFFRCwwQkFBa0IsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLEdBQUcsQ0FBQyxDQUFDOzs7QUFHdkMsZUFBTyxRQUFRLENBQUMsU0FBUyxFQUFFLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQztPQUN0Qzs7Ozs7QUFLRCxzQkFBZ0IsR0FBRyxZQUFZLENBQUM7QUFDaEMsb0JBQWMsR0FBRyxjQUFjLENBQUM7O0FBRWhDLGFBQU8sWUFBWSxDQUFDLE9BQU8sQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVc7QUFDN0Qsd0JBQWdCLEdBQUcsZ0JBQWdCLEdBQUcsY0FBYyxHQUFHLGNBQWMsQ0FBQztBQUN0RSxzQkFBYyxHQUFHLGNBQWMsQ0FBQztPQUNqQyxDQUFDLENBQUM7S0FDSjs7QUFFRCxhQUFTLGFBQWEsR0FBRzs7O0FBR3ZCLFVBQUksV0FBVyxJQUFJLFdBQVcsS0FBSyxNQUFNLElBQUksQ0FBQyxtQkFBTSxlQUFlLENBQUMsWUFBWSxDQUFDLEVBQUU7QUFDakYsZUFBTztPQUNSOztBQUVELGlCQUFXLEdBQUcsUUFBUSxDQUFDLFlBQVc7QUFDaEMsZUFBTyxTQUFTLEVBQUUsQ0FBQyxJQUFJLENBQUMsWUFBVzs7QUFFakMscUJBQVcsR0FBRyxJQUFJLENBQUM7U0FDcEIsQ0FBQyxDQUFDO09BQ0osRUFBRSxHQUFHLENBQUMsQ0FBQztLQUNUOztBQUVELGFBQVMsYUFBYSxDQUFDLEdBQUcsRUFBRTs7QUFFMUIsbUJBQWEsRUFBRSxDQUFDOzs7QUFHaEIsVUFBSSxDQUFDLEVBQUUsRUFBRTtBQUNQLGVBQU87T0FDUjs7QUFFRCxVQUFJLEdBQUcsQ0FBQyxPQUFPLEVBQUU7QUFDZixXQUFHLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQztPQUN0QixNQUFNO0FBQ0wsWUFBSSxJQUFJLEdBQUcsYUFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDOztBQUU5QixZQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsWUFBVzs7QUFFekIsaUJBQU8sR0FBRyxDQUFDLE9BQU8sQ0FBQztBQUNuQixhQUFHLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQztBQUN0QixtQkFBUyxDQUFDLE9BQU8sRUFBRSxDQUFDO1NBQ3JCLENBQUMsQ0FBQzs7QUFFSCxXQUFHLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQztPQUNwQjs7QUFFRCxhQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUM7S0FDcEI7O0FBRUQsYUFBUyxVQUFVLENBQUMsR0FBRyxFQUFFOzs7O0FBSXZCLFVBQUksR0FBRyxHQUFHLEdBQUcsQ0FBQyxTQUFTLEVBQUUsQ0FBQztBQUMxQixTQUFHLENBQUMsSUFBSSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDbkIsU0FBRyxDQUFDLEtBQUssR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQ3BCLGFBQU8sR0FBRyxDQUFDLEdBQUcsQ0FBQzs7QUFFZixVQUFJLFFBQVEsR0FBRyxFQUFFLENBQUMsS0FBSyxFQUFFLENBQUM7QUFDMUIsVUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFO0FBQy9CLFVBQUUsQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLFVBQVMsR0FBRyxFQUFFLE1BQU0sRUFBRTtBQUNuQyxvQkFBVSxDQUFDLE1BQU0sQ0FBQyxZQUFXO0FBQzNCLGdCQUFJLEdBQUcsRUFBRTtBQUNQLHNCQUFRLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3JCLHFCQUFPO2FBQ1I7QUFDRCxlQUFHLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUM7QUFDdkIsb0JBQVEsQ0FBQyxPQUFPLEVBQUUsQ0FBQztXQUNwQixDQUFDLENBQUM7U0FDSixDQUFDLENBQUM7T0FDSixNQUFNLElBQUksR0FBRyxDQUFDLFFBQVEsRUFBRTtBQUN2QixVQUFFLENBQUMsTUFBTSxDQUFDLEVBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxLQUFLLEVBQUMsRUFBRSxFQUFDLEtBQUssRUFBRSxJQUFJLEVBQUMsRUFBRSxVQUFTLEdBQUcsRUFBRTtBQUN2RCxvQkFBVSxDQUFDLE1BQU0sQ0FBQyxZQUFXO0FBQzNCLGdCQUFJLEdBQUcsRUFBRTtBQUNQLHNCQUFRLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3JCLHFCQUFPO2FBQ1I7O0FBRUQsb0JBQVEsQ0FBQyxPQUFPLEVBQUUsQ0FBQztXQUNwQixDQUFDLENBQUM7U0FDSixDQUFDLENBQUM7T0FDSixNQUFNO0FBQ0wsVUFBRSxDQUFDLE1BQU0sQ0FBQyxFQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsS0FBSyxFQUFDLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxVQUFTLEdBQUcsRUFBRTtBQUNqRCxvQkFBVSxDQUFDLE1BQU0sQ0FBQyxZQUFXO0FBQzNCLGdCQUFJLEdBQUcsRUFBRTtBQUNQLHNCQUFRLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3JCLHFCQUFPO2FBQ1I7QUFDRCxvQkFBUSxDQUFDLE9BQU8sRUFBRSxDQUFDO1dBQ3BCLENBQUMsQ0FBQztTQUNKLENBQUMsQ0FBQztPQUNKOztBQUVELGFBQU8sUUFBUSxDQUFDLE9BQU8sQ0FBQztLQUN6Qjs7QUFFRCxhQUFTLFlBQVksQ0FBQyxHQUFHLEVBQUU7QUFDekIsVUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLENBQUM7S0FDNUI7O0FBRUQsYUFBUyxPQUFPLEdBQUc7QUFDakIsVUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsQ0FBQztLQUN2Qjs7QUFFRCxhQUFTLGFBQWEsQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUU7QUFDeEQsVUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDO0FBQ2YsVUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLG9CQUFPLFlBQVksRUFBRSxDQUFDOztBQUUxQyxVQUFJLENBQUMsU0FBUyxHQUFHLEVBQUUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztBQUM1QixVQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDOztBQUV2QyxVQUFJLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQztBQUN2QixVQUFJLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQzs7QUFFdEIsVUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFDOztBQUV2QyxVQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUNsQixVQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQztBQUN0QixVQUFJLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQzs7O0FBR3RCLFVBQUksQ0FBQyxJQUFJLEdBQUcsR0FBRyxDQUFDOzs7QUFHaEIsVUFBSSxDQUFDLEdBQUcsR0FBRyxRQUFRLEdBQUcsR0FBRyxDQUFDLEdBQUcsR0FBRyxtQkFBTSxJQUFJLEVBQUUsQ0FBQztBQUM3QyxrQkFBWSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUM7OztBQUc5QixVQUFJLEdBQUcsRUFBRTtBQUNQLFlBQUksS0FBSyxHQUFHLFFBQVEsR0FBRyxHQUFHLENBQUMsU0FBUyxFQUFFLEdBQUcsR0FBRyxDQUFDOztBQUU3QyxhQUFLLElBQUksR0FBRyxJQUFJLEtBQUssRUFBRTtBQUNyQixhQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1NBQ3ZCO09BQ0Y7O0FBRUQsVUFBSSxHQUFHLElBQUksUUFBUSxFQUFFO0FBQ25CLFlBQUksQ0FBQyxLQUFLLEdBQUcsR0FBRyxDQUFDO09BQ2xCLE1BQU0sSUFBSSxJQUFJLENBQUMsR0FBRyxFQUFFO0FBQ25CLFlBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxjQUFjLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztPQUNoRCxNQUFNOztBQUVMLFlBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxjQUFjLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztPQUNqRDs7O0FBR0QsVUFBSSxJQUFJLENBQUMsR0FBRyxFQUFFO0FBQ1osa0JBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDO09BQzdCOzs7O0FBSUQsVUFBSSxJQUFJLENBQUMsR0FBRyxJQUFJLGFBQWEsRUFBRTs7QUFFN0IsWUFBSSxRQUFRLEdBQUcsU0FBUyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDeEMsaUJBQVMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLENBQUM7T0FDekQ7OztBQUdELFVBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxRQUFRLEVBQUUsVUFBUyxNQUFNLEVBQUUsTUFBTSxFQUFFO0FBQ3hELHFCQUFhLENBQUMsR0FBRyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQztPQUNwQyxDQUFDLENBQUM7OztBQUdILFVBQUksQ0FBQyxTQUFTLEdBQUcsS0FBSyxDQUFDOzs7O0FBSXZCLFVBQUksQ0FBQyxRQUFRLElBQUksR0FBRyxFQUFFO0FBQ3BCLHFCQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7T0FDckI7S0FDRjs7QUFFRCxpQkFBYSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7QUFDeEIsaUJBQWEsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDOztBQUU1QixpQkFBYSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO0FBQ3JDLGlCQUFhLENBQUMsU0FBUyxDQUFDLE9BQU8sR0FBRyxNQUFNLENBQUM7QUFDekMsaUJBQWEsQ0FBQyxTQUFTLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUN6QyxpQkFBYSxDQUFDLFNBQVMsQ0FBQyxTQUFTLEdBQUcsUUFBUSxDQUFDO0FBQzdDLGlCQUFhLENBQUMsU0FBUyxDQUFDLGFBQWEsR0FBRyxZQUFZLENBQUM7QUFDckQsaUJBQWEsQ0FBQyxTQUFTLENBQUMsUUFBUSxHQUFHLE9BQU8sQ0FBQzs7QUFFM0MsV0FBTyxhQUFhLENBQUM7R0FDdEI7O0FBRUQsU0FBTyxvQkFBb0IsQ0FBQztDQUM3QiIsImZpbGUiOiJsb2NhbC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBldmVudHMgZnJvbSAnZXZlbnRzJztcbmltcG9ydCB1dGlscyBmcm9tICcuL3V0aWxzJztcblxuaW1wb3J0IHZhbHVlcyBmcm9tICdsb2Rhc2gudmFsdWVzJztcblxuaW1wb3J0IGFuZ3VsYXIgZnJvbSAnYW5ndWxhcic7XG5pbXBvcnQgRGF0YXN0b3JlIGZyb20gJ25lZGInO1xuXG52YXIgTUFYX1NUT1JBR0VfU0laRSA9IDMgKiAxMDI0ICogMTAyNDsgLy8gM01CIC0gc2hvdWxkIGZpdCB3aXRob3V0IHByb2JsZW1zIGluIGFueSBicm93c2VyXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCRxLFxuICAgICAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LFxuICAgICAgICAgICAgICAgICAgICAgICAgJHdpbmRvdyxcbiAgICAgICAgICAgICAgICAgICAgICAgIFNlcnZlclJlc291cmNlRmFjdG9yeSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFF1ZXJ5RmFjdG9yeSxcbiAgICAgICAgICAgICAgICAgICAgICAgICRsb2NhbEZvcmFnZSkge1xuICAnbmdJbmplY3QnO1xuXG4gIHZhciB0b3RhbFN0b3JhZ2VTaXplID0gMDtcbiAgdmFyIHRvdGFsRGVzaXJlZFNpemUgPSAwO1xuICB2YXIgcGVyc2lzdE1vZGUgPSAnRlVMTCc7XG4gIHZhciBwZXJzaXN0TW9kZUVtaXR0ZXIgPSBuZXcgZXZlbnRzLkV2ZW50RW1pdHRlcigpO1xuXG4gIHBlcnNpc3RNb2RlRW1pdHRlci5zZXRNYXhMaXN0ZW5lcnMoMCk7IC8vIFVubGltaXRlZCBsaXN0ZW5lcnNcblxuICBmdW5jdGlvbiBMb2NhbFJlc291cmNlRmFjdG9yeSh1cmwsIHJvb3RLZXksIHJvb3RLZXlQbHVyYWwpIHtcblxuICAgIC8vIElzIG5lZGIgYXZhaWxhYmxlPyBJZiBzbyBnZXQgYSBsb2NhbCBjb2xsZWN0aW9uIHN0YXJ0ZWRcbiAgICB2YXIgZGI7XG4gICAgaWYgKERhdGFzdG9yZSkge1xuICAgICAgZGIgPSBuZXcgRGF0YXN0b3JlKCk7XG5cbiAgICAgIC8vIFN0aWNrIGFuIGluZGV4IG9uIF9faWQgLSBvdXIgaWQgZmllbGQuXG4gICAgICBkYi5lbnN1cmVJbmRleCh7IGZpZWxkTmFtZTogJ19faWQnIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIHRoZSBzZXJ2ZXIgcmVzb3VyY2UgYW5kIHF1ZXJ5XG4gICAgdmFyIFNlcnZlclJlc291cmNlID0gU2VydmVyUmVzb3VyY2VGYWN0b3J5KHVybCwgcm9vdEtleSwgcm9vdEtleVBsdXJhbCk7XG4gICAgdmFyIFF1ZXJ5TGlzdCA9IFF1ZXJ5RmFjdG9yeSh1cmwsIHJvb3RLZXksIHJvb3RLZXlQbHVyYWwsIGRiKTtcblxuICAgIC8vIEluIG1lbW9yeSByZXNvdXJjZSBzdG9yZVxuICAgIHZhciBfcmVzb3VyY2VzID0ge307XG4gICAgdmFyIF9pbnRlcm5hbFJlcyA9IHt9O1xuXG4gICAgdmFyIG91clN0b3JhZ2VTaXplID0gMDtcbiAgICB2YXIgb3VyRGVzaXJlZFNpemUgPSAwO1xuICAgIHZhciBwZXJzaXN0TW9kZVdhdGNoaW5nID0gZmFsc2U7XG5cbiAgICB2YXIgX2xhc3RyZXFzID0ge307XG4gICAgdmFyIF9yZXFzID0ge307XG5cbiAgICB2YXIgcFN0b3JhZ2VLZXkgPSB1dGlscy5wZXJzaXN0ZW50U3RvcmFnZUtleSh1cmwpO1xuICAgIHZhciBwZXJzaXN0UHJvbSA9IG51bGw7XG5cbiAgICBmdW5jdGlvbiB0b09iamVjdCgpIHtcbiAgICAgIHJldHVybiB1dGlscy50b09iamVjdCh0aGlzKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkYlRvUmVzKGRiTW9kZWwpIHtcbiAgICAgIHJldHVybiBfaW50ZXJuYWxSZXNbZGJNb2RlbC5fXyRpZF07XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGJUb01vZGVsKGRiTW9kZWwpIHtcbiAgICAgIHZhciBsb2MgPSBkYlRvUmVzKGRiTW9kZWwpO1xuICAgICAgcmV0dXJuIGxvYy4kbW9kO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNlcnZlclRyYW5zZm9ybShzZXJ2LCBpZCwgdHJhbnNmb3JtZXIpIHtcbiAgICAgIHZhciByZXMgPSBfaW50ZXJuYWxSZXNbc2Vydi4kaWRdO1xuXG4gICAgICAvLyBJZiB3ZSBkb24ndCBoYXZlIGEgcmVzb3VyY2UgdGhlbiBjcmVhdGUgaXRcbiAgICAgIGlmICghcmVzKSB7XG4gICAgICAgIHJlcyA9IG5ldyBMb2NhbFJlc291cmNlKHNlcnYsIHRydWUpO1xuICAgICAgfVxuXG4gICAgICBpZiAoaWQpIHtcbiAgICAgICAgX3Jlc291cmNlc1tpZF0gPSByZXM7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0cmFuc2Zvcm1lcihyZXMsIGlkKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXQoaWRzLCBmb3JjZSwgdHJhbnNmb3JtKSB7XG4gICAgICAvLyBXZSd2ZSByZXF1ZXN0ZWQgYSBidW5jaCBvZiBpZHNcbiAgICAgIC8vIFdlIHNob3VsZCBwZXJzaXN0IHRoZSBjaGFuZ2UgKHRvIG9mZmxpbmUgc3RvcmFnZSkgaWYgdGhpcyBpcyB0aGUgZmlyc3QgcmVxdWVzdFxuICAgICAgLy8gZm9yIHRoaXMgKHRoZXNlKSBvYmplY3RzXG4gICAgICB2YXIgbm93ID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG4gICAgICB2YXIgaXNTb21lRmlyc3QgPSBmYWxzZTtcbiAgICAgIGlmIChhbmd1bGFyLmlzQXJyYXkoaWRzKSkge1xuICAgICAgICBpZHMuZm9yRWFjaChmdW5jdGlvbihpZCkge1xuICAgICAgICAgIGlmICghX3JlcXNbaWRdKSB7XG4gICAgICAgICAgICBpc1NvbWVGaXJzdCA9IHRydWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgX2xhc3RyZXFzW2lkXSA9IG5vdztcbiAgICAgICAgICBfcmVxc1tpZF0gPSB0cnVlO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICghX3JlcXNbaWRzXSkge1xuICAgICAgICAgIGlzU29tZUZpcnN0ID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIF9sYXN0cmVxc1tpZHNdID0gbm93O1xuICAgICAgICBfcmVxc1tpZHNdID0gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgLy8gSWYgb3VyIHBlcnNpc3RNb2RlIGlzIE1JTiB3ZSdsbCB3YW50IHRvIHBlcnNpc3QgdG8gc3RvcmFnZSBoZXJlXG4gICAgICBpZiAocGVyc2lzdE1vZGUgPT09ICdNSU4nICYmIGlzU29tZUZpcnN0KSB7XG4gICAgICAgIHBlcnNpc3RDaGFuZ2UoKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIFNlcnZlclJlc291cmNlLmdldChpZHMsIGZvcmNlLCBmdW5jdGlvbihzZXJ2LCBpZCkge1xuICAgICAgICByZXR1cm4gc2VydmVyVHJhbnNmb3JtKHNlcnYsIGlkLCB0cmFuc2Zvcm0pO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcXVlcnkocXJ5LCBsaW1pdCwgUmVzb3VyY2UpIHtcbiAgICAgIHJldHVybiBRdWVyeUxpc3QocXJ5LCBsaW1pdCwgUmVzb3VyY2UsIGRiVG9Nb2RlbCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVtb3ZlKHNraXBTZXJ2ZXIpIHtcbiAgICAgIGlmICh0aGlzLl9pZCkge1xuICAgICAgICBkZWxldGUgX3Jlc291cmNlc1t0aGlzLl9pZF07XG4gICAgICB9XG5cbiAgICAgIHRoaXMuJGRlbGV0ZWQgPSB0cnVlO1xuXG4gICAgICAvLyBLaWNrIHRoZSBkYXRhYmFzZVxuICAgICAgc3luY1RvU3RvcmFnZSh0aGlzKTtcblxuICAgICAgLy8gSWYgd2UgaGF2ZSBiZWVuIGNyZWF0ZWQgdGhlbiBub3RpZnkgdGhlIHNlcnZlclxuXG4gICAgICBpZiAodGhpcy4kY3JlYXRlZCAmJiAhc2tpcFNlcnZlcikge1xuICAgICAgICByZXR1cm4gdGhpcy4kc2Vydi4kcmVtb3ZlKCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiAkcS53aGVuKHRydWUpO1xuICAgIH1cblxuICAgIC8vIE9uY2Ugd2UgYXJlIHN5bmNlZCB3aXRoIHRoZSBzZXJ2ZXIgcmVzb3VyY2Ugd2Ugd2lsbCByZXNvbHZlIHRoZSBwcm9taXNlXG4gICAgZnVuY3Rpb24gc2F2ZSh2YWxzKSB7XG4gICAgICB2YXIgcmVzID0gdGhpcztcbiAgICAgIHJlcy4kY3JlYXRlZCA9IHRydWU7XG5cbiAgICAgIC8vIE9ubHkgdHJpZ2dlciB0aGUgc2VydmVyIHN5bmMgb25jZSBwZXIgJ3RpY2snIChzbyBjYWxsaW5nIHNhdmUoKSBtdWx0aXBsZSB0aW1lc1xuICAgICAgLy8gaGFzIG5vIGVmZmVjdClcbiAgICAgIGlmICghcmVzLiRzYXZlcHJvbSkge1xuICAgICAgICB2YXIgb2xkRGF0YSA9IHRoaXMuJHRvT2JqZWN0KCk7XG4gICAgICAgIHJlcy4kc2F2ZXByb20gPSAkdGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICByZXMuJHNhdmVwcm9tID0gbnVsbDtcblxuICAgICAgICAgIC8vIFNhdmUgdXMgdG8gdGhlIGRiXG4gICAgICAgICAgc3luY1RvU3RvcmFnZShyZXMpO1xuXG4gICAgICAgICAgdmFyIHBhdGNoID0gdXRpbHMuZGlmZihvbGREYXRhLCByZXMuJHRvT2JqZWN0KCkpO1xuICAgICAgICAgIHJldHVybiBzeW5jVG9TZXJ2ZXIocmVzLCBwYXRjaCkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgaWYgKCFyZXMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgICAvLyBXYWl0IGZvciB0aGUgZGIgdG8gc3luYyBiZWZvcmUgcmVzb2x2aW5nIChpZiB0aGUgc3luYyBpcyBvdXRzdGFuZGluZylcbiAgICAgICAgICAgIHZhciBkYnByb20gPSByZXMuJGRic3luYyA/IHJlcy4kZGJzeW5jIDogJHEud2hlbigpO1xuICAgICAgICAgICAgZGJwcm9tLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgIHJlcy4kZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xuICAgICAgICAgICAgICByZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgdXRpbHMucmVtb3ZlUmVzVmFsdWVzKHJlcyk7XG4gICAgICB1dGlscy5zZXRSZXNWYWx1ZXMocmVzLCB2YWxzKTtcblxuICAgICAgcmV0dXJuIHJlcy4kc2F2ZXByb207XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcGVyZm9ybVNlcnZlclN5bmMocmVzLCBwYXRjaCkge1xuICAgICAgLy8gV2UgYXJlIGFib3V0IHRvIHN5bmMuIFVuc2V0IHRoZSByZXN5bmMgZmxhZ1xuICAgICAgcmVzLiRyZXN5bmMgPSBbXTtcblxuICAgICAgLy8gV2FpdCBmb3IgdGhlIHNlcnZlciB0byBmaW5pc2ggc2F2aW5nLiBUaGVuIGNoZWNrIGlmIHdlIG5lZWQgdG8gcmVzeW5jLiBUaGlzIHByb21pc2VcbiAgICAgIC8vIHdvbid0IHJlc29sdmUgdW50aWwgdGhlcmUgYXJlIG5vIG1vcmUgcmVzeW5jcyB0byBkb1xuICAgICAgcmV0dXJuIHJlcy4kc2Vydi4kc2F2ZShwYXRjaCkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgaWYgKHJlcy4kcmVzeW5jLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICByZXR1cm4gcGVyZm9ybVNlcnZlclN5bmMocmVzLCByZXMuJHJlc3luYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc3luY1RvU2VydmVyKHJlcywgcGF0Y2gpIHtcbiAgICAgIGlmIChyZXMuJHN5bmMpIHtcbiAgICAgICAgcmVzLiRyZXN5bmMucHVzaC5hcHBseShyZXMuJHJlc3luYywgcGF0Y2gpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHByb20gPSBwZXJmb3JtU2VydmVyU3luYyhyZXMsIHBhdGNoKVsnZmluYWxseSddKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIC8vIE9uY2Ugd2UndmUgc3luY2VkIHJlbW92ZSB0aGUgJHN5bmMgcHJvbWlzZVxuICAgICAgICAgIGRlbGV0ZSByZXMuJHN5bmM7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJlcy4kc3luYyA9IHByb207XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZXMuJHN5bmM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdXBkYXRlZFNlcnZlcihyZXMsIG5ld1ZhbCwgb2xkVmFsKSB7XG5cbiAgICAgIC8vIFdlIGNvdWxkIGhhdmUgYmVlbiBkZWxldGVkIChleGlzdGluZyBvbGRWYWwsIG51bGwgbmV3dmFsKVxuICAgICAgaWYgKG9sZFZhbCAmJiAhbmV3VmFsKSB7XG4gICAgICAgIC8vIFdlIGhhdmUgYmVlbiBkZWxldGVkLiBDbGVhbnVwIG91cnNlbHZlcyBhbmQgcGFzcyBpdCB1cCB0aGUgY2hhaW5cbiAgICAgICAgcmVzLiRlbWl0dGVyLmVtaXQoJ3VwZGF0ZScsIG51bGwsIHJlcy4kdG9PYmplY3QoKSk7XG4gICAgICAgIHJlcy4kcmVtb3ZlKHRydWUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzLiRjcmVhdGVkID0gdHJ1ZTtcblxuICAgICAgICBpZiAob2xkVmFsLl9pZCAmJiAobmV3VmFsLl9pZCAhPT0gb2xkVmFsLl9pZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBhbGxvd2VkIHRvIGNoYW5nZSBpZCcpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gTWVyZ2UgdGhlIG9iamVjdHMgdG9nZXRoZXIgdXNpbmcgdGhlIG9sZFZhbCBhcyBhIGJhc2UsIGFuZCB1c2luZyAqb3VyKiB2ZXJzaW9uXG4gICAgICAgIC8vIHRvIHJlc29sdmUgYW55IGNvbmZsaWN0cy4gV2UgbWF5IG5lZWQgdG8gcHV0IGluIHNvbWUgY29uZmxpY3QgcmVzb2x1dGlvbiBsb2dpY1xuICAgICAgICAvLyBzb21ld2hlcmUgb24gYSBjYXNlIGJ5IGNhc2UgYmFzaXNcbiAgICAgICAgdmFyIHByZWV4aXN0ID0gcmVzLiR0b09iamVjdCgpO1xuICAgICAgICB2YXIgbWVyZ2UgPSB1dGlscy5tZXJnZU9iamVjdHMocmVzLiR0b09iamVjdCgpLCBvbGRWYWwsIG5ld1ZhbCk7XG5cbiAgICAgICAgLy8gTm93IHB1dCBiYWNrIGluIHRoZSBtZXJnZSB2YWx1ZXNcbiAgICAgICAgdXRpbHMucmVtb3ZlUmVzVmFsdWVzKHJlcyk7XG4gICAgICAgIHV0aWxzLnNldFJlc1ZhbHVlcyhyZXMsIG1lcmdlKTtcblxuICAgICAgICAvLyBNYWtlIHN1cmUgd2UgYXJlIHN0b3JlZFxuICAgICAgICBfcmVzb3VyY2VzW3Jlcy5faWRdID0gcmVzO1xuXG4gICAgICAgIC8vIElmIHdlJ3ZlIG9ubHkganVzdCBiZWVuIGdpdmVuIGFuIGlkIHRoZW4gc3RvcmUgb2YgdGhlIGNyZWF0ZWQgdGltZSBhcyB0aGVcbiAgICAgICAgLy8gdGltZSB3ZSB3ZXJlIGxhc3QgcmVxdWVzdGVkICh0aGlzIGlzIGJlY2F1c2UgdGhlIG9iamVjdCBtdXN0IGhhdmUganVzdCBiZWVuXG4gICAgICAgIC8vIGNyZWF0ZWQgb24gdGhlIHNlcnZlcilcbiAgICAgICAgaWYgKHJlcy5faWQgJiYgIW9sZFZhbC5faWQpIHtcbiAgICAgICAgICBfbGFzdHJlcXNbcmVzLl9pZF0gPSByZXMuJGNyZWF0ZWRBdDtcbiAgICAgICAgICBfcmVxc1tyZXMuX2lkXSA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBOb3RpZnkgdGhhdCB3ZSBoYXZlIGNoYW5nZWRcbiAgICAgICAgcmVzLiRlbWl0dGVyLmVtaXQoJ3VwZGF0ZScsIHJlcy4kdG9PYmplY3QoKSwgcHJlZXhpc3QpO1xuICAgICAgICAvLyBLaWNrIHRoZSBkYlxuICAgICAgICB2YXIgc3luY3Byb20gPSBzeW5jVG9TdG9yYWdlKHJlcykgfHwgJHEud2hlbigpO1xuXG4gICAgICAgIHN5bmNwcm9tLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgLy8gV2UgbWlnaHQgaGF2ZSBzeW5jZWQgZm9yIHRoZSBmaXJzdCB0aW1lXG4gICAgICAgICAgcmV0dXJuIHJlcy4kc2Vydi4kcHJvbWlzZS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKCFyZXMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgICAgIHJlcy4kZGVmZXJyZWQucmVzb2x2ZShyZXMpO1xuICAgICAgICAgICAgICByZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcGVyZm9ybURiU3luYyhyZXMpIHtcbiAgICAgIHJlcy4kZGJyZXN5bmMgPSBmYWxzZTtcbiAgICAgIHJldHVybiB1cGRhdGVUb0RiKHJlcykudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgaWYgKHJlcy4kZGJyZXN5bmMpIHtcbiAgICAgICAgICByZXR1cm4gcGVyZm9ybURiU3luYyhyZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gd2F0Y2hGb3JQZXJzaXN0TW9kZUNoYW5nZXMoKSB7XG4gICAgICBpZiAocGVyc2lzdE1vZGVXYXRjaGluZykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHBlcnNpc3RNb2RlRW1pdHRlci5vbignY2hhbmdlJywgZnVuY3Rpb24oX3VybCkge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGNhbGxlZCB0aGlzIHRoZW4gaWdub3JlXG4gICAgICAgIGlmIChfdXJsID09PSB1cmwpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyBSZWRvIHRoZSBwZXJzaXN0XG4gICAgICAgIGRvUGVyc2lzdCgpO1xuICAgICAgfSk7XG5cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkb1BlcnNpc3QoKSB7XG4gICAgICAvLyBJZiB3ZSdyZSBhbHJlYWR5IGRvaW5nIGEgcGVyc2lzdCBvciB3ZSBkb250IGhhdmUgYWR2YW5jZWQgc3RvcmFnZSBvcHRpb25zIHRoZW5cbiAgICAgIC8vIGp1c3QgcmV0dXJuXG4gICAgICBpZiAocGVyc2lzdE1vZGUgPT09ICdOT05FJyB8fCAhdXRpbHMuYWR2YW5jZWRTdG9yYWdlKCRsb2NhbEZvcmFnZSkpIHtcbiAgICAgICAgcmV0dXJuICRxLndoZW4oKTtcbiAgICAgIH1cblxuICAgICAgLy8gSWYgdGhpcyBpcyB0aGUgZmlyc3QgdGltZSB0aHJvdWdoIHRoZW4gc3RpY2sgYSBsaXN0ZW5lciBvbiBmb3IgY2hhbmdlc1xuICAgICAgaWYgKCFwZXJzaXN0TW9kZVdhdGNoaW5nKSB7XG4gICAgICAgIHdhdGNoRm9yUGVyc2lzdE1vZGVDaGFuZ2VzKCk7XG4gICAgICB9XG5cbiAgICAgIHZhciBkYXRhID0gW107XG5cbiAgICAgIHN3aXRjaChwZXJzaXN0TW9kZSkge1xuICAgICAgICBjYXNlICdGVUxMJzpcbiAgICAgICAgICBkYXRhID0gdmFsdWVzKF9yZXNvdXJjZXMpLm1hcChmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIG9iajogcmVzLiR0b09iamVjdCgpLFxuICAgICAgICAgICAgICBsYXN0cmVxOiBfbGFzdHJlcXNbcmVzLl9pZF1cbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnTUlOJzpcbiAgICAgICAgICB2YWx1ZXMoX3Jlc291cmNlcykuZm9yRWFjaChmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAgIGlmIChfcmVxc1tyZXMuX2lkXSkge1xuICAgICAgICAgICAgICBkYXRhLnB1c2goe1xuICAgICAgICAgICAgICAgIG9iajogcmVzLiR0b09iamVjdCgpLFxuICAgICAgICAgICAgICAgIGxhc3RyZXE6IF9sYXN0cmVxc1tyZXMuX2lkXVxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gV2UgbmVlZCB0byBtYW51YWxseSBtYW5hZ2Ugc3RvcmFnZVxuICAgICAgdmFyIGRhdGFTdHIgPSBKU09OLnN0cmluZ2lmeShkYXRhKTtcblxuICAgICAgdmFyIG5ld1N0b3JhZ2VTaXplID0gZGF0YVN0ci5sZW5ndGg7XG4gICAgICB2YXIgZXhwZWN0ZWRTaXplID0gdG90YWxEZXNpcmVkU2l6ZSAtIG91ckRlc2lyZWRTaXplICsgbmV3U3RvcmFnZVNpemU7XG5cbiAgICAgIC8vIERvIHdlIGV4cGVjdCB0byBidXN0IHRoZSBtYXggc2l6ZT8gSWYgc28gd2UgbmVlZCB0byBjaGFuZ2UgcGVyc2lzdCBtb2RlXG4gICAgICAvLyBhbmQgZW1pdFxuICAgICAgaWYgKGV4cGVjdGVkU2l6ZSA+IE1BWF9TVE9SQUdFX1NJWkUpIHtcbiAgICAgICAgaWYgKHBlcnNpc3RNb2RlID09PSAnRlVMTCcpIHtcbiAgICAgICAgICBwZXJzaXN0TW9kZSA9ICdNSU4nO1xuICAgICAgICB9IGVsc2UgaWYgKHBlcnNpc3RNb2RlID09PSAnTUlOJykge1xuICAgICAgICAgIHBlcnNpc3RNb2RlID0gJ05PTkUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIERvbid0IGtub3cgaG93IHdlIGNvdWxkIGdldCBoZXJlIGJ1dCByZXR1cm4ganVzdCBpbiBjYXNlXG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgcGVyc2lzdE1vZGVFbWl0dGVyLmVtaXQoJ2NoYW5nZScsIHVybCk7XG5cbiAgICAgICAgLy8gU2NoZWR1bGUgdGhpcyBsYXRlclxuICAgICAgICByZXR1cm4gJHRpbWVvdXQoZG9QZXJzaXN0LCAwLCBmYWxzZSk7XG4gICAgICB9XG5cbiAgICAgIC8vIE1PREUgSEFTIE5PVCBDSEFOR0VEXG5cbiAgICAgIC8vIFN0b3JlIG91ciBleHBlY3RlZCBzaXplXG4gICAgICB0b3RhbERlc2lyZWRTaXplID0gZXhwZWN0ZWRTaXplO1xuICAgICAgb3VyRGVzaXJlZFNpemUgPSBuZXdTdG9yYWdlU2l6ZTtcblxuICAgICAgcmV0dXJuICRsb2NhbEZvcmFnZS5zZXRJdGVtKHBTdG9yYWdlS2V5LCBkYXRhKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICB0b3RhbFN0b3JhZ2VTaXplID0gdG90YWxTdG9yYWdlU2l6ZSAtIG91clN0b3JhZ2VTaXplICsgbmV3U3RvcmFnZVNpemU7XG4gICAgICAgIG91clN0b3JhZ2VTaXplID0gbmV3U3RvcmFnZVNpemU7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBwZXJzaXN0Q2hhbmdlKCkge1xuICAgICAgLy8gSWYgd2UncmUgYWxyZWFkeSBkb2luZyBhIHBlcnNpc3Qgb3Igd2UgZG9udCBoYXZlIGFkdmFuY2VkIHN0b3JhZ2Ugb3B0aW9ucyB0aGVuXG4gICAgICAvLyBqdXN0IHJldHVyblxuICAgICAgaWYgKHBlcnNpc3RQcm9tIHx8IHBlcnNpc3RNb2RlID09PSAnTk9ORScgfHwgIXV0aWxzLmFkdmFuY2VkU3RvcmFnZSgkbG9jYWxGb3JhZ2UpKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgcGVyc2lzdFByb20gPSAkdGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIGRvUGVyc2lzdCgpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgLy8gRmluaXNoZWQgdGhlIHBlcnNpc3RcbiAgICAgICAgICBwZXJzaXN0UHJvbSA9IG51bGw7XG4gICAgICAgIH0pO1xuICAgICAgfSwgNTAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzeW5jVG9TdG9yYWdlKHJlcykge1xuXG4gICAgICBwZXJzaXN0Q2hhbmdlKCk7XG5cbiAgICAgIC8vIElmIHdlIGhhdmUgbm8gZGIgdGhlbiBleGl0XG4gICAgICBpZiAoIWRiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKHJlcy4kZGJzeW5jKSB7XG4gICAgICAgIHJlcy4kZGJyZXN5bmMgPSB0cnVlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHByb20gPSBwZXJmb3JtRGJTeW5jKHJlcyk7XG5cbiAgICAgICAgcHJvbVsnZmluYWxseSddKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIC8vIFdoYXRldmVyIGhhcHBlbnMgcmVtb3ZlIHRoZSAkc3luYyBwcm9taXNlIGFuZCByZWZyZXNoIGFsbCB0aGUgcXVlcmllc1xuICAgICAgICAgIGRlbGV0ZSByZXMuJGRic3luYztcbiAgICAgICAgICByZXMuJGRicmVzeW5jID0gZmFsc2U7XG4gICAgICAgICAgUXVlcnlMaXN0LnJlZnJlc2goKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmVzLiRkYnN5bmMgPSBwcm9tO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzLiRkYnN5bmM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdXBkYXRlVG9EYihyZXMpIHtcblxuICAgICAgLy8gV2UgbmVlZCB0byB0cmFuc2Zvcm0gdGhlIHJlc291cmNlIGJ5IHJlcGxhY2luZyB0aGUgX2lkIGZpZWxkIChuZWRiIHVzZXMgaXRzIG93biBpZCBpbiB0aGF0XG4gICAgICAvLyBwbGFjZSkuIEluc3RlYWQgY2FsbCBpdCBfX2lkXG4gICAgICB2YXIgZG9jID0gcmVzLiR0b09iamVjdCgpO1xuICAgICAgZG9jLl9faWQgPSBkb2MuX2lkO1xuICAgICAgZG9jLl9fJGlkID0gcmVzLiRpZDtcbiAgICAgIGRlbGV0ZSBkb2MuX2lkO1xuXG4gICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgaWYgKCFyZXMuJGRiaWQgJiYgIXJlcy4kZGVsZXRlZCkge1xuICAgICAgICBkYi5pbnNlcnQoZG9jLCBmdW5jdGlvbihlcnIsIG5ld0RvYykge1xuICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoZXJyKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzLiRkYmlkID0gbmV3RG9jLl9pZDtcbiAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKHJlcy4kZGVsZXRlZCkge1xuICAgICAgICBkYi5yZW1vdmUoe19pZDogcmVzLiRkYmlkfSwge211bHRpOiB0cnVlfSwgZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdChlcnIpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkYi51cGRhdGUoe19pZDogcmVzLiRkYmlkfSwgZG9jLCB7fSwgZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdChlcnIpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiB1cGRhdGVTZXJ2ZXIodmFsKSB7XG4gICAgICB0aGlzLiRzZXJ2LiR1cGRhdGVWYWwodmFsKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWZyZXNoKCkge1xuICAgICAgdGhpcy4kc2Vydi4kcmVmcmVzaCgpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIExvY2FsUmVzb3VyY2UodmFsLCBmcm9tU2VydiwgbW9kLCBsYXN0UmVxdWVzdGVkKSB7XG4gICAgICB2YXIgcmVzID0gdGhpcztcbiAgICAgIHRoaXMuJGVtaXR0ZXIgPSBuZXcgZXZlbnRzLkV2ZW50RW1pdHRlcigpO1xuXG4gICAgICB0aGlzLiRkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICB0aGlzLiRwcm9taXNlID0gdGhpcy4kZGVmZXJyZWQucHJvbWlzZTsgLy8gQW4gaW5pdGlhbCBwcm9taXNlIGZvciBvdXIgaW5pdGlhbFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZldGNoIG9yIGNyZWF0ZSBvZiBkYXRhXG4gICAgICB0aGlzLiRyZXNvbHZlZCA9IGZhbHNlOyAvLyBIYXZlIHdlIGhhZCBhbiBpbml0aWFsIHJlc29sdXRpb24gb2YgdGhlIHByb21pc2VcbiAgICAgIHRoaXMuJGNyZWF0ZWQgPSBmYWxzZTsgLy8gSGF2ZSB3ZSBwdXNoZWQgYW55IHZhbHVlcyBkb3duIHRvIHRoZSBzZXJ2ZXIgeWV0P1xuXG4gICAgICB0aGlzLiRjcmVhdGVkQXQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcblxuICAgICAgdGhpcy4kcmVzeW5jID0gW107XG4gICAgICB0aGlzLiRzYXZlcHJvbSA9IG51bGw7XG4gICAgICB0aGlzLiRkZWxldGVkID0gZmFsc2U7XG5cbiAgICAgIC8vIFN0b3JlIG9mZiB0aGUgbW9kZWwgc28gd2UgY2FuIHJlZmVyZW5jZSBpdCBsYXRlclxuICAgICAgdGhpcy4kbW9kID0gbW9kO1xuXG4gICAgICAvLyBVc2VkIHRvIGNvcnJlbGF0ZSB0byB0aGUgZGIgb2JqZWN0cyB3aGVuIHdlIGRvbid0IGhhdmUgYW4gX2lkIChjcmVhdGluZylcbiAgICAgIHRoaXMuJGlkID0gZnJvbVNlcnYgPyB2YWwuJGlkIDogdXRpbHMudXVpZCgpO1xuICAgICAgX2ludGVybmFsUmVzW3RoaXMuJGlkXSA9IHRoaXM7XG5cbiAgICAgIC8vIElmIHdlJ3ZlIGJlZW4gZ2l2ZW4gdmFsdWVzIHB1dCB0aGVtIG9uXG4gICAgICBpZiAodmFsKSB7XG4gICAgICAgIHZhciBwcm9wcyA9IGZyb21TZXJ2ID8gdmFsLiR0b09iamVjdCgpIDogdmFsO1xuXG4gICAgICAgIGZvciAodmFyIGtleSBpbiBwcm9wcykge1xuICAgICAgICAgIHJlc1trZXldID0gcHJvcHNba2V5XTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAodmFsICYmIGZyb21TZXJ2KSB7XG4gICAgICAgIHRoaXMuJHNlcnYgPSB2YWw7XG4gICAgICB9IGVsc2UgaWYgKHRoaXMuX2lkKSB7XG4gICAgICAgIHRoaXMuJHNlcnYgPSBuZXcgU2VydmVyUmVzb3VyY2UodmFsLCB0aGlzLiRpZCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBEb24ndCBhZGQgaW4gdGhlIHZhbHVlcyB1bnRpbCB3ZSBzYXZlXG4gICAgICAgIHRoaXMuJHNlcnYgPSBuZXcgU2VydmVyUmVzb3VyY2UobnVsbCwgdGhpcy4kaWQpO1xuICAgICAgfVxuXG4gICAgICAvLyBJZiB3ZSBoYXZlIGFuIGlkIHRoZW4gYWRkIHVzIHRvIHRoZSBzdG9yZVxuICAgICAgaWYgKHRoaXMuX2lkKSB7XG4gICAgICAgIF9yZXNvdXJjZXNbdGhpcy5faWRdID0gdGhpcztcbiAgICAgIH1cblxuICAgICAgLy8gSWYgd2UgaGF2ZSBhbiBpZCBhbmQgd2UndmUgYmVlbiBwYXNzZWQgaW4gYSBsYXN0IHJlcXVlc3RlZCB0aW1lIHRoZW4gc3RvcmUgb2ZmXG4gICAgICAvLyB0aGUgbGFzdCByZXF1ZXN0ZWQgdGltZVxuICAgICAgaWYgKHRoaXMuX2lkICYmIGxhc3RSZXF1ZXN0ZWQpIHtcbiAgICAgICAgLy8gSWYgdGhlIGxhc3QgcmVxdWVzdGVkIGFscmVhZHkgZXhpc3RzIHVzZSB0aGUgbWF4XG4gICAgICAgIHZhciBleGlzdGluZyA9IF9sYXN0cmVxc1t0aGlzLl9pZF0gfHwgMDtcbiAgICAgICAgX2xhc3RyZXFzW3RoaXMuX2lkXSA9IE1hdGgubWF4KGxhc3RSZXF1ZXN0ZWQsIGV4aXN0aW5nKTtcbiAgICAgIH1cblxuICAgICAgLy8gTGlzdGVuIGZvciBjaGFuZ2VzIG9uIHRoZSBzZXJ2ZXJcbiAgICAgIHRoaXMuJHNlcnYuJGVtaXR0ZXIub24oJ3VwZGF0ZScsIGZ1bmN0aW9uKG5ld1ZhbCwgb2xkVmFsKSB7XG4gICAgICAgIHVwZGF0ZWRTZXJ2ZXIocmVzLCBuZXdWYWwsIG9sZFZhbCk7XG4gICAgICB9KTtcblxuICAgICAgLy8gVXBkYXRlIHVzIGluIHRoZSBkYlxuICAgICAgdGhpcy4kZGJyZXN5bmMgPSBmYWxzZTtcblxuICAgICAgLy8gSWYgaXQncyBmcm9tIHRoZSBzZXJ2ZXIgZG9uJ3QgY3JlYXRlIGl0IHlldC4gV2FpdCBmb3IgdGhlIHVwZGF0ZSB0byBjb21lIChhbG9uZ1xuICAgICAgLy8gd2l0aCBob3BlZnVsbHkgYWxsIHRoZSBkYXRhKVxuICAgICAgaWYgKCFmcm9tU2VydiAmJiB2YWwpIHtcbiAgICAgICAgc3luY1RvU3RvcmFnZSh0aGlzKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBMb2NhbFJlc291cmNlLmdldCA9IGdldDtcbiAgICBMb2NhbFJlc291cmNlLnF1ZXJ5ID0gcXVlcnk7XG5cbiAgICBMb2NhbFJlc291cmNlLnByb3RvdHlwZS4kc2F2ZSA9IHNhdmU7XG4gICAgTG9jYWxSZXNvdXJjZS5wcm90b3R5cGUuJHJlbW92ZSA9IHJlbW92ZTtcbiAgICBMb2NhbFJlc291cmNlLnByb3RvdHlwZS4kZGVsZXRlID0gcmVtb3ZlO1xuICAgIExvY2FsUmVzb3VyY2UucHJvdG90eXBlLiR0b09iamVjdCA9IHRvT2JqZWN0O1xuICAgIExvY2FsUmVzb3VyY2UucHJvdG90eXBlLiR1cGRhdGVTZXJ2ZXIgPSB1cGRhdGVTZXJ2ZXI7XG4gICAgTG9jYWxSZXNvdXJjZS5wcm90b3R5cGUuJHJlZnJlc2ggPSByZWZyZXNoO1xuXG4gICAgcmV0dXJuIExvY2FsUmVzb3VyY2U7XG4gIH1cblxuICByZXR1cm4gTG9jYWxSZXNvdXJjZUZhY3Rvcnk7XG59XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
