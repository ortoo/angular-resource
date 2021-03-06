import events from 'events';
import * as utils from './utils';

import angular from 'angular';

var MAX_STORAGE_SIZE = 3 * 1024 * 1024; // 3MB - should fit without problems in any browser

export default function(
  $q,
  $timeout,
  $window,
  ServerResourceFactory,
  QueryFactory,
  ResourceDBFactory,
  $localForage
) {
  'ngInject';

  var totalStorageSize = 0;
  var totalDesiredSize = 0;
  var persistMode = 'FULL';
  var persistModeEmitter = new events.EventEmitter();

  persistModeEmitter.setMaxListeners(0); // Unlimited listeners

  function LocalResourceFactory(url, rootKey, rootKeyPlural) {
    var db = ResourceDBFactory();

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

    db.on('update', () => {
      QueryList.refresh();
    });

    function toObject() {
      return utils.toObject(this);
    }

    function idToModel(id) {
      var loc = _internalRes[id];
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
      if (angular.isArray(ids)) {
        ids.forEach(function(id) {
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

      return ServerResource.get(ids, force, function(serv, id) {
        return serverTransform(serv, id, transform);
      });
    }

    function query(qry, limit, Resource) {
      return QueryList(qry, limit, Resource, idToModel);
    }

    function remove(skipServer) {
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
        res.$saveprom = $timeout(function() {
          res.$saveprom = null;

          // Save us to the db
          syncToStorage(res);

          var patch = utils.diff(oldData, res.$toObject());
          return syncToServer(res, patch).then(function() {
            return res;
          });
        }).then(function() {
          if (!res.$resolved) {
            // Wait for the db to sync before resolving (if the sync is outstanding)
            var dbprom = res.$dbsync ? res.$dbsync : $q.when();
            dbprom.then(function() {
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
      return res.$serv.$save(patch).then(function() {
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
        var prom = performServerSync(res, patch)['finally'](function() {
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

        if (newVal) {
          // Kick the db
          syncToStorage(res);
        }

        // We might have synced for the first time
        db.awaitOutstandingUpdates().then(() => {
          res.$serv.$promise.then(function() {
            if (!res.$resolved) {
              res.$deferred.resolve(res);
              res.$resolved = true;
            }
          });
        });
      }
    }

    function watchForPersistModeChanges() {
      if (persistModeWatching) {
        return;
      }

      persistModeEmitter.on('change', function(_url) {
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

      const resources = Object.values(_resources).filter(
        res => res._id && !res.$deleted
      );

      switch (persistMode) {
        case 'FULL':
          data = resources.map(res => {
            return {
              obj: res.$toObject(),
              lastreq: _lastreqs[res._id]
            };
          });
          break;

        case 'MIN':
          resources.forEach(function(res) {
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

      return $localForage.setItem(pStorageKey, data).then(function() {
        totalStorageSize = totalStorageSize - ourStorageSize + newStorageSize;
        ourStorageSize = newStorageSize;
      });
    }

    function persistChange() {
      // If we're already doing a persist or we dont have advanced storage options then
      // just return
      if (
        persistProm ||
        persistMode === 'NONE' ||
        !utils.advancedStorage($localForage)
      ) {
        return;
      }

      persistProm = $timeout(function() {
        return doPersist().then(function() {
          // Finished the persist
          persistProm = null;
        });
      }, 500);
    }

    function syncToStorage(res) {
      persistChange();
      db.update(res);
    }

    function updateServer(val) {
      this.$serv.$updateVal(val);
    }

    function refresh() {
      this.$serv.$refresh();
    }

    function LocalResource(val, fromServ, mod, lastRequested) {
      var res = this;
      this.$emitter = new events.EventEmitter();

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
      this.$serv.$emitter.on('update', function(newVal, oldVal) {
        updatedServer(res, newVal, oldVal);
      });

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
}
