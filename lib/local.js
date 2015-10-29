'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _events = require('events');

var _events2 = _interopRequireDefault(_events);

var _utils = require('./utils');

var utils = _interopRequireWildcard(_utils);

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

    var pStorageKey = utils.persistentStorageKey(url);
    var persistProm = null;

    function toObject() {
      return utils.toObject(this);
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

          var patch = utils.diff(oldData, res.$toObject());
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

      utils.removeResValues(res);
      utils.setResValues(res, vals);

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
        var merge = utils.mergeObjects(res.$toObject(), oldVal, newVal);

        // Now put back in the merge values
        utils.removeResValues(res);
        utils.setResValues(res, merge);

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
      if (persistMode === 'NONE' || !utils.advancedStorage($localForage)) {
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
      if (persistProm || persistMode === 'NONE' || !utils.advancedStorage($localForage)) {
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
      this.$id = fromServ ? val.$id : utils.uuid();
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
//# sourceMappingURL=data:application/json;base64,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QUssR0FBRyxJQUFJLENBQUM7QUFDckMsaUJBQWEsQ0FBQyxTQUFTLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUN6QyxpQkFBYSxDQUFDLFNBQVMsQ0FBQyxPQUFPLEdBQUcsTUFBTSxDQUFDO0FBQ3pDLGlCQUFhLENBQUMsU0FBUyxDQUFDLFNBQVMsR0FBRyxRQUFRLENBQUM7QUFDN0MsaUJBQWEsQ0FBQyxTQUFTLENBQUMsYUFBYSxHQUFHLFlBQVksQ0FBQztBQUNyRCxpQkFBYSxDQUFDLFNBQVMsQ0FBQyxRQUFRLEdBQUcsT0FBTyxDQUFDOztBQUUzQyxXQUFPLGFBQWEsQ0FBQztHQUN0Qjs7QUFFRCxTQUFPLG9CQUFvQixDQUFDO0NBQzdCIiwiZmlsZSI6ImxvY2FsLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGV2ZW50cyBmcm9tICdldmVudHMnO1xuaW1wb3J0ICogYXMgdXRpbHMgZnJvbSAnLi91dGlscyc7XG5cbmltcG9ydCB2YWx1ZXMgZnJvbSAnbG9kYXNoLnZhbHVlcyc7XG5cbmltcG9ydCBhbmd1bGFyIGZyb20gJ2FuZ3VsYXInO1xuaW1wb3J0IERhdGFzdG9yZSBmcm9tICduZWRiJztcblxudmFyIE1BWF9TVE9SQUdFX1NJWkUgPSAzICogMTAyNCAqIDEwMjQ7IC8vIDNNQiAtIHNob3VsZCBmaXQgd2l0aG91dCBwcm9ibGVtcyBpbiBhbnkgYnJvd3NlclxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbigkcSxcbiAgICAgICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAkdGltZW91dCxcbiAgICAgICAgICAgICAgICAgICAgICAgICR3aW5kb3csXG4gICAgICAgICAgICAgICAgICAgICAgICBTZXJ2ZXJSZXNvdXJjZUZhY3RvcnksXG4gICAgICAgICAgICAgICAgICAgICAgICBRdWVyeUZhY3RvcnksXG4gICAgICAgICAgICAgICAgICAgICAgICAkbG9jYWxGb3JhZ2UpIHtcbiAgJ25nSW5qZWN0JztcblxuICB2YXIgdG90YWxTdG9yYWdlU2l6ZSA9IDA7XG4gIHZhciB0b3RhbERlc2lyZWRTaXplID0gMDtcbiAgdmFyIHBlcnNpc3RNb2RlID0gJ0ZVTEwnO1xuICB2YXIgcGVyc2lzdE1vZGVFbWl0dGVyID0gbmV3IGV2ZW50cy5FdmVudEVtaXR0ZXIoKTtcblxuICBwZXJzaXN0TW9kZUVtaXR0ZXIuc2V0TWF4TGlzdGVuZXJzKDApOyAvLyBVbmxpbWl0ZWQgbGlzdGVuZXJzXG5cbiAgZnVuY3Rpb24gTG9jYWxSZXNvdXJjZUZhY3RvcnkodXJsLCByb290S2V5LCByb290S2V5UGx1cmFsKSB7XG5cbiAgICAvLyBJcyBuZWRiIGF2YWlsYWJsZT8gSWYgc28gZ2V0IGEgbG9jYWwgY29sbGVjdGlvbiBzdGFydGVkXG4gICAgdmFyIGRiO1xuICAgIGlmIChEYXRhc3RvcmUpIHtcbiAgICAgIGRiID0gbmV3IERhdGFzdG9yZSgpO1xuXG4gICAgICAvLyBTdGljayBhbiBpbmRleCBvbiBfX2lkIC0gb3VyIGlkIGZpZWxkLlxuICAgICAgZGIuZW5zdXJlSW5kZXgoeyBmaWVsZE5hbWU6ICdfX2lkJyB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSB0aGUgc2VydmVyIHJlc291cmNlIGFuZCBxdWVyeVxuICAgIHZhciBTZXJ2ZXJSZXNvdXJjZSA9IFNlcnZlclJlc291cmNlRmFjdG9yeSh1cmwsIHJvb3RLZXksIHJvb3RLZXlQbHVyYWwpO1xuICAgIHZhciBRdWVyeUxpc3QgPSBRdWVyeUZhY3RvcnkodXJsLCByb290S2V5LCByb290S2V5UGx1cmFsLCBkYik7XG5cbiAgICAvLyBJbiBtZW1vcnkgcmVzb3VyY2Ugc3RvcmVcbiAgICB2YXIgX3Jlc291cmNlcyA9IHt9O1xuICAgIHZhciBfaW50ZXJuYWxSZXMgPSB7fTtcblxuICAgIHZhciBvdXJTdG9yYWdlU2l6ZSA9IDA7XG4gICAgdmFyIG91ckRlc2lyZWRTaXplID0gMDtcbiAgICB2YXIgcGVyc2lzdE1vZGVXYXRjaGluZyA9IGZhbHNlO1xuXG4gICAgdmFyIF9sYXN0cmVxcyA9IHt9O1xuICAgIHZhciBfcmVxcyA9IHt9O1xuXG4gICAgdmFyIHBTdG9yYWdlS2V5ID0gdXRpbHMucGVyc2lzdGVudFN0b3JhZ2VLZXkodXJsKTtcbiAgICB2YXIgcGVyc2lzdFByb20gPSBudWxsO1xuXG4gICAgZnVuY3Rpb24gdG9PYmplY3QoKSB7XG4gICAgICByZXR1cm4gdXRpbHMudG9PYmplY3QodGhpcyk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGJUb1JlcyhkYk1vZGVsKSB7XG4gICAgICByZXR1cm4gX2ludGVybmFsUmVzW2RiTW9kZWwuX18kaWRdO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRiVG9Nb2RlbChkYk1vZGVsKSB7XG4gICAgICB2YXIgbG9jID0gZGJUb1JlcyhkYk1vZGVsKTtcbiAgICAgIHJldHVybiBsb2MuJG1vZDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzZXJ2ZXJUcmFuc2Zvcm0oc2VydiwgaWQsIHRyYW5zZm9ybWVyKSB7XG4gICAgICB2YXIgcmVzID0gX2ludGVybmFsUmVzW3NlcnYuJGlkXTtcblxuICAgICAgLy8gSWYgd2UgZG9uJ3QgaGF2ZSBhIHJlc291cmNlIHRoZW4gY3JlYXRlIGl0XG4gICAgICBpZiAoIXJlcykge1xuICAgICAgICByZXMgPSBuZXcgTG9jYWxSZXNvdXJjZShzZXJ2LCB0cnVlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGlkKSB7XG4gICAgICAgIF9yZXNvdXJjZXNbaWRdID0gcmVzO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdHJhbnNmb3JtZXIocmVzLCBpZCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0KGlkcywgZm9yY2UsIHRyYW5zZm9ybSkge1xuICAgICAgLy8gV2UndmUgcmVxdWVzdGVkIGEgYnVuY2ggb2YgaWRzXG4gICAgICAvLyBXZSBzaG91bGQgcGVyc2lzdCB0aGUgY2hhbmdlICh0byBvZmZsaW5lIHN0b3JhZ2UpIGlmIHRoaXMgaXMgdGhlIGZpcnN0IHJlcXVlc3RcbiAgICAgIC8vIGZvciB0aGlzICh0aGVzZSkgb2JqZWN0c1xuICAgICAgdmFyIG5vdyA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xuICAgICAgdmFyIGlzU29tZUZpcnN0ID0gZmFsc2U7XG4gICAgICBpZiAoYW5ndWxhci5pc0FycmF5KGlkcykpIHtcbiAgICAgICAgaWRzLmZvckVhY2goZnVuY3Rpb24oaWQpIHtcbiAgICAgICAgICBpZiAoIV9yZXFzW2lkXSkge1xuICAgICAgICAgICAgaXNTb21lRmlyc3QgPSB0cnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIF9sYXN0cmVxc1tpZF0gPSBub3c7XG4gICAgICAgICAgX3JlcXNbaWRdID0gdHJ1ZTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoIV9yZXFzW2lkc10pIHtcbiAgICAgICAgICBpc1NvbWVGaXJzdCA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICBfbGFzdHJlcXNbaWRzXSA9IG5vdztcbiAgICAgICAgX3JlcXNbaWRzXSA9IHRydWU7XG4gICAgICB9XG5cbiAgICAgIC8vIElmIG91ciBwZXJzaXN0TW9kZSBpcyBNSU4gd2UnbGwgd2FudCB0byBwZXJzaXN0IHRvIHN0b3JhZ2UgaGVyZVxuICAgICAgaWYgKHBlcnNpc3RNb2RlID09PSAnTUlOJyAmJiBpc1NvbWVGaXJzdCkge1xuICAgICAgICBwZXJzaXN0Q2hhbmdlKCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBTZXJ2ZXJSZXNvdXJjZS5nZXQoaWRzLCBmb3JjZSwgZnVuY3Rpb24oc2VydiwgaWQpIHtcbiAgICAgICAgcmV0dXJuIHNlcnZlclRyYW5zZm9ybShzZXJ2LCBpZCwgdHJhbnNmb3JtKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHF1ZXJ5KHFyeSwgbGltaXQsIFJlc291cmNlKSB7XG4gICAgICByZXR1cm4gUXVlcnlMaXN0KHFyeSwgbGltaXQsIFJlc291cmNlLCBkYlRvTW9kZWwpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlbW92ZShza2lwU2VydmVyKSB7XG4gICAgICBpZiAodGhpcy5faWQpIHtcbiAgICAgICAgZGVsZXRlIF9yZXNvdXJjZXNbdGhpcy5faWRdO1xuICAgICAgfVxuXG4gICAgICB0aGlzLiRkZWxldGVkID0gdHJ1ZTtcblxuICAgICAgLy8gS2ljayB0aGUgZGF0YWJhc2VcbiAgICAgIHN5bmNUb1N0b3JhZ2UodGhpcyk7XG5cbiAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBjcmVhdGVkIHRoZW4gbm90aWZ5IHRoZSBzZXJ2ZXJcblxuICAgICAgaWYgKHRoaXMuJGNyZWF0ZWQgJiYgIXNraXBTZXJ2ZXIpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuJHNlcnYuJHJlbW92ZSgpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gJHEud2hlbih0cnVlKTtcbiAgICB9XG5cbiAgICAvLyBPbmNlIHdlIGFyZSBzeW5jZWQgd2l0aCB0aGUgc2VydmVyIHJlc291cmNlIHdlIHdpbGwgcmVzb2x2ZSB0aGUgcHJvbWlzZVxuICAgIGZ1bmN0aW9uIHNhdmUodmFscykge1xuICAgICAgdmFyIHJlcyA9IHRoaXM7XG4gICAgICByZXMuJGNyZWF0ZWQgPSB0cnVlO1xuXG4gICAgICAvLyBPbmx5IHRyaWdnZXIgdGhlIHNlcnZlciBzeW5jIG9uY2UgcGVyICd0aWNrJyAoc28gY2FsbGluZyBzYXZlKCkgbXVsdGlwbGUgdGltZXNcbiAgICAgIC8vIGhhcyBubyBlZmZlY3QpXG4gICAgICBpZiAoIXJlcy4kc2F2ZXByb20pIHtcbiAgICAgICAgdmFyIG9sZERhdGEgPSB0aGlzLiR0b09iamVjdCgpO1xuICAgICAgICByZXMuJHNhdmVwcm9tID0gJHRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgcmVzLiRzYXZlcHJvbSA9IG51bGw7XG5cbiAgICAgICAgICAvLyBTYXZlIHVzIHRvIHRoZSBkYlxuICAgICAgICAgIHN5bmNUb1N0b3JhZ2UocmVzKTtcblxuICAgICAgICAgIHZhciBwYXRjaCA9IHV0aWxzLmRpZmYob2xkRGF0YSwgcmVzLiR0b09iamVjdCgpKTtcbiAgICAgICAgICByZXR1cm4gc3luY1RvU2VydmVyKHJlcywgcGF0Y2gpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgLy8gV2FpdCBmb3IgdGhlIGRiIHRvIHN5bmMgYmVmb3JlIHJlc29sdmluZyAoaWYgdGhlIHN5bmMgaXMgb3V0c3RhbmRpbmcpXG4gICAgICAgICAgICB2YXIgZGJwcm9tID0gcmVzLiRkYnN5bmMgPyByZXMuJGRic3luYyA6ICRxLndoZW4oKTtcbiAgICAgICAgICAgIGRicHJvbS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICAgICAgcmVzLiRyZXNvbHZlZCA9IHRydWU7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHV0aWxzLnJlbW92ZVJlc1ZhbHVlcyhyZXMpO1xuICAgICAgdXRpbHMuc2V0UmVzVmFsdWVzKHJlcywgdmFscyk7XG5cbiAgICAgIHJldHVybiByZXMuJHNhdmVwcm9tO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHBlcmZvcm1TZXJ2ZXJTeW5jKHJlcywgcGF0Y2gpIHtcbiAgICAgIC8vIFdlIGFyZSBhYm91dCB0byBzeW5jLiBVbnNldCB0aGUgcmVzeW5jIGZsYWdcbiAgICAgIHJlcy4kcmVzeW5jID0gW107XG5cbiAgICAgIC8vIFdhaXQgZm9yIHRoZSBzZXJ2ZXIgdG8gZmluaXNoIHNhdmluZy4gVGhlbiBjaGVjayBpZiB3ZSBuZWVkIHRvIHJlc3luYy4gVGhpcyBwcm9taXNlXG4gICAgICAvLyB3b24ndCByZXNvbHZlIHVudGlsIHRoZXJlIGFyZSBubyBtb3JlIHJlc3luY3MgdG8gZG9cbiAgICAgIHJldHVybiByZXMuJHNlcnYuJHNhdmUocGF0Y2gpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmIChyZXMuJHJlc3luYy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcmV0dXJuIHBlcmZvcm1TZXJ2ZXJTeW5jKHJlcywgcmVzLiRyZXN5bmMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHN5bmNUb1NlcnZlcihyZXMsIHBhdGNoKSB7XG4gICAgICBpZiAocmVzLiRzeW5jKSB7XG4gICAgICAgIHJlcy4kcmVzeW5jLnB1c2guYXBwbHkocmVzLiRyZXN5bmMsIHBhdGNoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBwcm9tID0gcGVyZm9ybVNlcnZlclN5bmMocmVzLCBwYXRjaClbJ2ZpbmFsbHknXShmdW5jdGlvbigpIHtcbiAgICAgICAgICAvLyBPbmNlIHdlJ3ZlIHN5bmNlZCByZW1vdmUgdGhlICRzeW5jIHByb21pc2VcbiAgICAgICAgICBkZWxldGUgcmVzLiRzeW5jO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXMuJHN5bmMgPSBwcm9tO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzLiRzeW5jO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHVwZGF0ZWRTZXJ2ZXIocmVzLCBuZXdWYWwsIG9sZFZhbCkge1xuXG4gICAgICAvLyBXZSBjb3VsZCBoYXZlIGJlZW4gZGVsZXRlZCAoZXhpc3Rpbmcgb2xkVmFsLCBudWxsIG5ld3ZhbClcbiAgICAgIGlmIChvbGRWYWwgJiYgIW5ld1ZhbCkge1xuICAgICAgICAvLyBXZSBoYXZlIGJlZW4gZGVsZXRlZC4gQ2xlYW51cCBvdXJzZWx2ZXMgYW5kIHBhc3MgaXQgdXAgdGhlIGNoYWluXG4gICAgICAgIHJlcy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCBudWxsLCByZXMuJHRvT2JqZWN0KCkpO1xuICAgICAgICByZXMuJHJlbW92ZSh0cnVlKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlcy4kY3JlYXRlZCA9IHRydWU7XG5cbiAgICAgICAgaWYgKG9sZFZhbC5faWQgJiYgKG5ld1ZhbC5faWQgIT09IG9sZFZhbC5faWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgYWxsb3dlZCB0byBjaGFuZ2UgaWQnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE1lcmdlIHRoZSBvYmplY3RzIHRvZ2V0aGVyIHVzaW5nIHRoZSBvbGRWYWwgYXMgYSBiYXNlLCBhbmQgdXNpbmcgKm91ciogdmVyc2lvblxuICAgICAgICAvLyB0byByZXNvbHZlIGFueSBjb25mbGljdHMuIFdlIG1heSBuZWVkIHRvIHB1dCBpbiBzb21lIGNvbmZsaWN0IHJlc29sdXRpb24gbG9naWNcbiAgICAgICAgLy8gc29tZXdoZXJlIG9uIGEgY2FzZSBieSBjYXNlIGJhc2lzXG4gICAgICAgIHZhciBwcmVleGlzdCA9IHJlcy4kdG9PYmplY3QoKTtcbiAgICAgICAgdmFyIG1lcmdlID0gdXRpbHMubWVyZ2VPYmplY3RzKHJlcy4kdG9PYmplY3QoKSwgb2xkVmFsLCBuZXdWYWwpO1xuXG4gICAgICAgIC8vIE5vdyBwdXQgYmFjayBpbiB0aGUgbWVyZ2UgdmFsdWVzXG4gICAgICAgIHV0aWxzLnJlbW92ZVJlc1ZhbHVlcyhyZXMpO1xuICAgICAgICB1dGlscy5zZXRSZXNWYWx1ZXMocmVzLCBtZXJnZSk7XG5cbiAgICAgICAgLy8gTWFrZSBzdXJlIHdlIGFyZSBzdG9yZWRcbiAgICAgICAgX3Jlc291cmNlc1tyZXMuX2lkXSA9IHJlcztcblxuICAgICAgICAvLyBJZiB3ZSd2ZSBvbmx5IGp1c3QgYmVlbiBnaXZlbiBhbiBpZCB0aGVuIHN0b3JlIG9mIHRoZSBjcmVhdGVkIHRpbWUgYXMgdGhlXG4gICAgICAgIC8vIHRpbWUgd2Ugd2VyZSBsYXN0IHJlcXVlc3RlZCAodGhpcyBpcyBiZWNhdXNlIHRoZSBvYmplY3QgbXVzdCBoYXZlIGp1c3QgYmVlblxuICAgICAgICAvLyBjcmVhdGVkIG9uIHRoZSBzZXJ2ZXIpXG4gICAgICAgIGlmIChyZXMuX2lkICYmICFvbGRWYWwuX2lkKSB7XG4gICAgICAgICAgX2xhc3RyZXFzW3Jlcy5faWRdID0gcmVzLiRjcmVhdGVkQXQ7XG4gICAgICAgICAgX3JlcXNbcmVzLl9pZF0gPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gTm90aWZ5IHRoYXQgd2UgaGF2ZSBjaGFuZ2VkXG4gICAgICAgIHJlcy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCByZXMuJHRvT2JqZWN0KCksIHByZWV4aXN0KTtcbiAgICAgICAgLy8gS2ljayB0aGUgZGJcbiAgICAgICAgdmFyIHN5bmNwcm9tID0gc3luY1RvU3RvcmFnZShyZXMpIHx8ICRxLndoZW4oKTtcblxuICAgICAgICBzeW5jcHJvbS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIC8vIFdlIG1pZ2h0IGhhdmUgc3luY2VkIGZvciB0aGUgZmlyc3QgdGltZVxuICAgICAgICAgIHJldHVybiByZXMuJHNlcnYuJHByb21pc2UudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICAgICAgcmVzLiRyZXNvbHZlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHBlcmZvcm1EYlN5bmMocmVzKSB7XG4gICAgICByZXMuJGRicmVzeW5jID0gZmFsc2U7XG4gICAgICByZXR1cm4gdXBkYXRlVG9EYihyZXMpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmIChyZXMuJGRicmVzeW5jKSB7XG4gICAgICAgICAgcmV0dXJuIHBlcmZvcm1EYlN5bmMocmVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybjtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHdhdGNoRm9yUGVyc2lzdE1vZGVDaGFuZ2VzKCkge1xuICAgICAgaWYgKHBlcnNpc3RNb2RlV2F0Y2hpbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBwZXJzaXN0TW9kZUVtaXR0ZXIub24oJ2NoYW5nZScsIGZ1bmN0aW9uKF91cmwpIHtcbiAgICAgICAgLy8gSWYgd2UgaGF2ZSBjYWxsZWQgdGhpcyB0aGVuIGlnbm9yZVxuICAgICAgICBpZiAoX3VybCA9PT0gdXJsKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUmVkbyB0aGUgcGVyc2lzdFxuICAgICAgICBkb1BlcnNpc3QoKTtcbiAgICAgIH0pO1xuXG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZG9QZXJzaXN0KCkge1xuICAgICAgLy8gSWYgd2UncmUgYWxyZWFkeSBkb2luZyBhIHBlcnNpc3Qgb3Igd2UgZG9udCBoYXZlIGFkdmFuY2VkIHN0b3JhZ2Ugb3B0aW9ucyB0aGVuXG4gICAgICAvLyBqdXN0IHJldHVyblxuICAgICAgaWYgKHBlcnNpc3RNb2RlID09PSAnTk9ORScgfHwgIXV0aWxzLmFkdmFuY2VkU3RvcmFnZSgkbG9jYWxGb3JhZ2UpKSB7XG4gICAgICAgIHJldHVybiAkcS53aGVuKCk7XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHRoaXMgaXMgdGhlIGZpcnN0IHRpbWUgdGhyb3VnaCB0aGVuIHN0aWNrIGEgbGlzdGVuZXIgb24gZm9yIGNoYW5nZXNcbiAgICAgIGlmICghcGVyc2lzdE1vZGVXYXRjaGluZykge1xuICAgICAgICB3YXRjaEZvclBlcnNpc3RNb2RlQ2hhbmdlcygpO1xuICAgICAgfVxuXG4gICAgICB2YXIgZGF0YSA9IFtdO1xuXG4gICAgICBzd2l0Y2gocGVyc2lzdE1vZGUpIHtcbiAgICAgICAgY2FzZSAnRlVMTCc6XG4gICAgICAgICAgZGF0YSA9IHZhbHVlcyhfcmVzb3VyY2VzKS5tYXAoZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBvYmo6IHJlcy4kdG9PYmplY3QoKSxcbiAgICAgICAgICAgICAgbGFzdHJlcTogX2xhc3RyZXFzW3Jlcy5faWRdXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ01JTic6XG4gICAgICAgICAgdmFsdWVzKF9yZXNvdXJjZXMpLmZvckVhY2goZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgICBpZiAoX3JlcXNbcmVzLl9pZF0pIHtcbiAgICAgICAgICAgICAgZGF0YS5wdXNoKHtcbiAgICAgICAgICAgICAgICBvYmo6IHJlcy4kdG9PYmplY3QoKSxcbiAgICAgICAgICAgICAgICBsYXN0cmVxOiBfbGFzdHJlcXNbcmVzLl9pZF1cbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFdlIG5lZWQgdG8gbWFudWFsbHkgbWFuYWdlIHN0b3JhZ2VcbiAgICAgIHZhciBkYXRhU3RyID0gSlNPTi5zdHJpbmdpZnkoZGF0YSk7XG5cbiAgICAgIHZhciBuZXdTdG9yYWdlU2l6ZSA9IGRhdGFTdHIubGVuZ3RoO1xuICAgICAgdmFyIGV4cGVjdGVkU2l6ZSA9IHRvdGFsRGVzaXJlZFNpemUgLSBvdXJEZXNpcmVkU2l6ZSArIG5ld1N0b3JhZ2VTaXplO1xuXG4gICAgICAvLyBEbyB3ZSBleHBlY3QgdG8gYnVzdCB0aGUgbWF4IHNpemU/IElmIHNvIHdlIG5lZWQgdG8gY2hhbmdlIHBlcnNpc3QgbW9kZVxuICAgICAgLy8gYW5kIGVtaXRcbiAgICAgIGlmIChleHBlY3RlZFNpemUgPiBNQVhfU1RPUkFHRV9TSVpFKSB7XG4gICAgICAgIGlmIChwZXJzaXN0TW9kZSA9PT0gJ0ZVTEwnKSB7XG4gICAgICAgICAgcGVyc2lzdE1vZGUgPSAnTUlOJztcbiAgICAgICAgfSBlbHNlIGlmIChwZXJzaXN0TW9kZSA9PT0gJ01JTicpIHtcbiAgICAgICAgICBwZXJzaXN0TW9kZSA9ICdOT05FJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBEb24ndCBrbm93IGhvdyB3ZSBjb3VsZCBnZXQgaGVyZSBidXQgcmV0dXJuIGp1c3QgaW4gY2FzZVxuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHBlcnNpc3RNb2RlRW1pdHRlci5lbWl0KCdjaGFuZ2UnLCB1cmwpO1xuXG4gICAgICAgIC8vIFNjaGVkdWxlIHRoaXMgbGF0ZXJcbiAgICAgICAgcmV0dXJuICR0aW1lb3V0KGRvUGVyc2lzdCwgMCwgZmFsc2UpO1xuICAgICAgfVxuXG4gICAgICAvLyBNT0RFIEhBUyBOT1QgQ0hBTkdFRFxuXG4gICAgICAvLyBTdG9yZSBvdXIgZXhwZWN0ZWQgc2l6ZVxuICAgICAgdG90YWxEZXNpcmVkU2l6ZSA9IGV4cGVjdGVkU2l6ZTtcbiAgICAgIG91ckRlc2lyZWRTaXplID0gbmV3U3RvcmFnZVNpemU7XG5cbiAgICAgIHJldHVybiAkbG9jYWxGb3JhZ2Uuc2V0SXRlbShwU3RvcmFnZUtleSwgZGF0YSkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgdG90YWxTdG9yYWdlU2l6ZSA9IHRvdGFsU3RvcmFnZVNpemUgLSBvdXJTdG9yYWdlU2l6ZSArIG5ld1N0b3JhZ2VTaXplO1xuICAgICAgICBvdXJTdG9yYWdlU2l6ZSA9IG5ld1N0b3JhZ2VTaXplO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcGVyc2lzdENoYW5nZSgpIHtcbiAgICAgIC8vIElmIHdlJ3JlIGFscmVhZHkgZG9pbmcgYSBwZXJzaXN0IG9yIHdlIGRvbnQgaGF2ZSBhZHZhbmNlZCBzdG9yYWdlIG9wdGlvbnMgdGhlblxuICAgICAgLy8ganVzdCByZXR1cm5cbiAgICAgIGlmIChwZXJzaXN0UHJvbSB8fCBwZXJzaXN0TW9kZSA9PT0gJ05PTkUnIHx8ICF1dGlscy5hZHZhbmNlZFN0b3JhZ2UoJGxvY2FsRm9yYWdlKSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHBlcnNpc3RQcm9tID0gJHRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBkb1BlcnNpc3QoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIC8vIEZpbmlzaGVkIHRoZSBwZXJzaXN0XG4gICAgICAgICAgcGVyc2lzdFByb20gPSBudWxsO1xuICAgICAgICB9KTtcbiAgICAgIH0sIDUwMCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc3luY1RvU3RvcmFnZShyZXMpIHtcblxuICAgICAgcGVyc2lzdENoYW5nZSgpO1xuXG4gICAgICAvLyBJZiB3ZSBoYXZlIG5vIGRiIHRoZW4gZXhpdFxuICAgICAgaWYgKCFkYikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXMuJGRic3luYykge1xuICAgICAgICByZXMuJGRicmVzeW5jID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBwcm9tID0gcGVyZm9ybURiU3luYyhyZXMpO1xuXG4gICAgICAgIHByb21bJ2ZpbmFsbHknXShmdW5jdGlvbigpIHtcbiAgICAgICAgICAvLyBXaGF0ZXZlciBoYXBwZW5zIHJlbW92ZSB0aGUgJHN5bmMgcHJvbWlzZSBhbmQgcmVmcmVzaCBhbGwgdGhlIHF1ZXJpZXNcbiAgICAgICAgICBkZWxldGUgcmVzLiRkYnN5bmM7XG4gICAgICAgICAgcmVzLiRkYnJlc3luYyA9IGZhbHNlO1xuICAgICAgICAgIFF1ZXJ5TGlzdC5yZWZyZXNoKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJlcy4kZGJzeW5jID0gcHJvbTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlcy4kZGJzeW5jO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHVwZGF0ZVRvRGIocmVzKSB7XG5cbiAgICAgIC8vIFdlIG5lZWQgdG8gdHJhbnNmb3JtIHRoZSByZXNvdXJjZSBieSByZXBsYWNpbmcgdGhlIF9pZCBmaWVsZCAobmVkYiB1c2VzIGl0cyBvd24gaWQgaW4gdGhhdFxuICAgICAgLy8gcGxhY2UpLiBJbnN0ZWFkIGNhbGwgaXQgX19pZFxuICAgICAgdmFyIGRvYyA9IHJlcy4kdG9PYmplY3QoKTtcbiAgICAgIGRvYy5fX2lkID0gZG9jLl9pZDtcbiAgICAgIGRvYy5fXyRpZCA9IHJlcy4kaWQ7XG4gICAgICBkZWxldGUgZG9jLl9pZDtcblxuICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgIGlmICghcmVzLiRkYmlkICYmICFyZXMuJGRlbGV0ZWQpIHtcbiAgICAgICAgZGIuaW5zZXJ0KGRvYywgZnVuY3Rpb24oZXJyLCBuZXdEb2MpIHtcbiAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KGVycik7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlcy4kZGJpZCA9IG5ld0RvYy5faWQ7XG4gICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChyZXMuJGRlbGV0ZWQpIHtcbiAgICAgICAgZGIucmVtb3ZlKHtfaWQ6IHJlcy4kZGJpZH0sIHttdWx0aTogdHJ1ZX0sIGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoZXJyKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGIudXBkYXRlKHtfaWQ6IHJlcy4kZGJpZH0sIGRvYywge30sIGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoZXJyKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdXBkYXRlU2VydmVyKHZhbCkge1xuICAgICAgdGhpcy4kc2Vydi4kdXBkYXRlVmFsKHZhbCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVmcmVzaCgpIHtcbiAgICAgIHRoaXMuJHNlcnYuJHJlZnJlc2goKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBMb2NhbFJlc291cmNlKHZhbCwgZnJvbVNlcnYsIG1vZCwgbGFzdFJlcXVlc3RlZCkge1xuICAgICAgdmFyIHJlcyA9IHRoaXM7XG4gICAgICB0aGlzLiRlbWl0dGVyID0gbmV3IGV2ZW50cy5FdmVudEVtaXR0ZXIoKTtcblxuICAgICAgdGhpcy4kZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgdGhpcy4kcHJvbWlzZSA9IHRoaXMuJGRlZmVycmVkLnByb21pc2U7IC8vIEFuIGluaXRpYWwgcHJvbWlzZSBmb3Igb3VyIGluaXRpYWxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBmZXRjaCBvciBjcmVhdGUgb2YgZGF0YVxuICAgICAgdGhpcy4kcmVzb2x2ZWQgPSBmYWxzZTsgLy8gSGF2ZSB3ZSBoYWQgYW4gaW5pdGlhbCByZXNvbHV0aW9uIG9mIHRoZSBwcm9taXNlXG4gICAgICB0aGlzLiRjcmVhdGVkID0gZmFsc2U7IC8vIEhhdmUgd2UgcHVzaGVkIGFueSB2YWx1ZXMgZG93biB0byB0aGUgc2VydmVyIHlldD9cblxuICAgICAgdGhpcy4kY3JlYXRlZEF0ID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG5cbiAgICAgIHRoaXMuJHJlc3luYyA9IFtdO1xuICAgICAgdGhpcy4kc2F2ZXByb20gPSBudWxsO1xuICAgICAgdGhpcy4kZGVsZXRlZCA9IGZhbHNlO1xuXG4gICAgICAvLyBTdG9yZSBvZmYgdGhlIG1vZGVsIHNvIHdlIGNhbiByZWZlcmVuY2UgaXQgbGF0ZXJcbiAgICAgIHRoaXMuJG1vZCA9IG1vZDtcblxuICAgICAgLy8gVXNlZCB0byBjb3JyZWxhdGUgdG8gdGhlIGRiIG9iamVjdHMgd2hlbiB3ZSBkb24ndCBoYXZlIGFuIF9pZCAoY3JlYXRpbmcpXG4gICAgICB0aGlzLiRpZCA9IGZyb21TZXJ2ID8gdmFsLiRpZCA6IHV0aWxzLnV1aWQoKTtcbiAgICAgIF9pbnRlcm5hbFJlc1t0aGlzLiRpZF0gPSB0aGlzO1xuXG4gICAgICAvLyBJZiB3ZSd2ZSBiZWVuIGdpdmVuIHZhbHVlcyBwdXQgdGhlbSBvblxuICAgICAgaWYgKHZhbCkge1xuICAgICAgICB2YXIgcHJvcHMgPSBmcm9tU2VydiA/IHZhbC4kdG9PYmplY3QoKSA6IHZhbDtcblxuICAgICAgICBmb3IgKHZhciBrZXkgaW4gcHJvcHMpIHtcbiAgICAgICAgICByZXNba2V5XSA9IHByb3BzW2tleV07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHZhbCAmJiBmcm9tU2Vydikge1xuICAgICAgICB0aGlzLiRzZXJ2ID0gdmFsO1xuICAgICAgfSBlbHNlIGlmICh0aGlzLl9pZCkge1xuICAgICAgICB0aGlzLiRzZXJ2ID0gbmV3IFNlcnZlclJlc291cmNlKHZhbCwgdGhpcy4kaWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gRG9uJ3QgYWRkIGluIHRoZSB2YWx1ZXMgdW50aWwgd2Ugc2F2ZVxuICAgICAgICB0aGlzLiRzZXJ2ID0gbmV3IFNlcnZlclJlc291cmNlKG51bGwsIHRoaXMuJGlkKTtcbiAgICAgIH1cblxuICAgICAgLy8gSWYgd2UgaGF2ZSBhbiBpZCB0aGVuIGFkZCB1cyB0byB0aGUgc3RvcmVcbiAgICAgIGlmICh0aGlzLl9pZCkge1xuICAgICAgICBfcmVzb3VyY2VzW3RoaXMuX2lkXSA9IHRoaXM7XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHdlIGhhdmUgYW4gaWQgYW5kIHdlJ3ZlIGJlZW4gcGFzc2VkIGluIGEgbGFzdCByZXF1ZXN0ZWQgdGltZSB0aGVuIHN0b3JlIG9mZlxuICAgICAgLy8gdGhlIGxhc3QgcmVxdWVzdGVkIHRpbWVcbiAgICAgIGlmICh0aGlzLl9pZCAmJiBsYXN0UmVxdWVzdGVkKSB7XG4gICAgICAgIC8vIElmIHRoZSBsYXN0IHJlcXVlc3RlZCBhbHJlYWR5IGV4aXN0cyB1c2UgdGhlIG1heFxuICAgICAgICB2YXIgZXhpc3RpbmcgPSBfbGFzdHJlcXNbdGhpcy5faWRdIHx8IDA7XG4gICAgICAgIF9sYXN0cmVxc1t0aGlzLl9pZF0gPSBNYXRoLm1heChsYXN0UmVxdWVzdGVkLCBleGlzdGluZyk7XG4gICAgICB9XG5cbiAgICAgIC8vIExpc3RlbiBmb3IgY2hhbmdlcyBvbiB0aGUgc2VydmVyXG4gICAgICB0aGlzLiRzZXJ2LiRlbWl0dGVyLm9uKCd1cGRhdGUnLCBmdW5jdGlvbihuZXdWYWwsIG9sZFZhbCkge1xuICAgICAgICB1cGRhdGVkU2VydmVyKHJlcywgbmV3VmFsLCBvbGRWYWwpO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIFVwZGF0ZSB1cyBpbiB0aGUgZGJcbiAgICAgIHRoaXMuJGRicmVzeW5jID0gZmFsc2U7XG5cbiAgICAgIC8vIElmIGl0J3MgZnJvbSB0aGUgc2VydmVyIGRvbid0IGNyZWF0ZSBpdCB5ZXQuIFdhaXQgZm9yIHRoZSB1cGRhdGUgdG8gY29tZSAoYWxvbmdcbiAgICAgIC8vIHdpdGggaG9wZWZ1bGx5IGFsbCB0aGUgZGF0YSlcbiAgICAgIGlmICghZnJvbVNlcnYgJiYgdmFsKSB7XG4gICAgICAgIHN5bmNUb1N0b3JhZ2UodGhpcyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgTG9jYWxSZXNvdXJjZS5nZXQgPSBnZXQ7XG4gICAgTG9jYWxSZXNvdXJjZS5xdWVyeSA9IHF1ZXJ5O1xuXG4gICAgTG9jYWxSZXNvdXJjZS5wcm90b3R5cGUuJHNhdmUgPSBzYXZlO1xuICAgIExvY2FsUmVzb3VyY2UucHJvdG90eXBlLiRyZW1vdmUgPSByZW1vdmU7XG4gICAgTG9jYWxSZXNvdXJjZS5wcm90b3R5cGUuJGRlbGV0ZSA9IHJlbW92ZTtcbiAgICBMb2NhbFJlc291cmNlLnByb3RvdHlwZS4kdG9PYmplY3QgPSB0b09iamVjdDtcbiAgICBMb2NhbFJlc291cmNlLnByb3RvdHlwZS4kdXBkYXRlU2VydmVyID0gdXBkYXRlU2VydmVyO1xuICAgIExvY2FsUmVzb3VyY2UucHJvdG90eXBlLiRyZWZyZXNoID0gcmVmcmVzaDtcblxuICAgIHJldHVybiBMb2NhbFJlc291cmNlO1xuICB9XG5cbiAgcmV0dXJuIExvY2FsUmVzb3VyY2VGYWN0b3J5O1xufVxuIl0sInNvdXJjZVJvb3QiOiIvc291cmNlLyJ9
