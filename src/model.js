import events from 'events';
import * as utils from './utils';

export default function() {

  // The length of time since an object has been requested that we keep in persistent storage.
  // In milliseconds - default to 7 days
  var pStorageMaxLen = 7 * 24 * 60 * 60 * 1000;

  // set pStorageMaxLen. In DAYS
  this.setPStorageMaxLen = function setPStorageMaxLen(len) {
    pStorageMaxLen = len * 24 * 60 * 60 * 1000;
  };

  this.$get = ResourceFactoryFactory;

  function ResourceFactoryFactory($window,
                                  $q,
                                  $rootScope,
                                  $timeout,
                                  $localForage,
                                  LocalResourceFactory,
                                  Chain,
                                  Collection) {
    'ngInject';

    function ResourceFactory(url, rootKey, rootKeyPlural) {
      rootKeyPlural = rootKeyPlural || (rootKey + 's');

      // Create the local resource
      var LocalResource = LocalResourceFactory(url, rootKey, rootKeyPlural);

      // In memory resource store
      var _resources = {};
      var _resFromLocal = {};

      // Create an event emitter
      var emitter = new events.EventEmitter();

      // Load from persistent storage (if we have something more exciting than localstorage)
      if (utils.advancedStorage($localForage)) {
        var pStorageKey = utils.persistentStorageKey(url);
        $localForage.getItem(pStorageKey).then(function(data) {
          if (!data) {
            return;
          }

          var now = new Date().getTime();

          data.forEach(function(datum) {
            var obj = datum.obj;
            var lastRequested = datum.lastreq;

            // Only create if the time between now and the last request is less than
            // pStorageMaxLen
            if ((now - lastRequested) <= pStorageMaxLen) {
              createFromStorage(obj, lastRequested);
            }
          });
        });
      }

      function localToRes(loc, id) {
        var res = _resFromLocal[loc.$id];

        // If we don't have a resource then create it
        if (!res) {
          res = new Resource(loc, true);
        }

        if (id) {
          _resources[id] = res;
        }

        return res;
      }

      function toObject() {
        return utils.toObject(this);
      }

      function reset() {

        // If we aren't saved at all then just remove
        if (!this.$created) {
          this.$remove(true);
          return;
        }

        var newValues = this.$loc.$toObject();
        utils.removeResValues(this);
        utils.setResValues(this, newValues);
      }

      // The promise resolves once the save has been committed
      function save() {
        var res = this;
        res.$created = true;
        return this.$loc.$save(this.$toObject()).then(function() {
          if (!res.$resolved) {
            res.$deferred.resolve(res);
            res.$resolved = true;
          }
          return res;
        });
      }

      function remove(noPrompt, skipLocal) {
        if(!noPrompt) {
          // Add confirmation alert
          if(!$window.confirm('Do you really want to delete this item?')) {
            return;
          }
        }
        this.$deleted = true;
        if (this._id) {
          delete _resources[this._id];
        }

        var prom;
        if (skipLocal) {
          prom = $q.when(true);
        } else {
          prom = this.$loc.$remove();
        }

        emitter.emit('remove', this);

        return prom;
      }

      function type() {
        return rootKey[0].toUpperCase() + rootKey.slice(1);
      }

      function collection(seeds, relation) {
        return Collection(Resource, seeds, relation);
      }

      function chain(origQry, Model, qryFn) {
        return Chain(origQry, Model, qryFn);
      }

      function query(qry, limit) {
        var result = LocalResource.query(qry, limit, Resource);
        emitter.emit('query', result, qry, limit);
        return result;
      }

      function get(ids, force) {
        var results = LocalResource.get(ids, force, localToRes);
        emitter.emit('get', ids, results, force);
        return results;
      }

      function updatedLocal(res, newVal, oldVal) {

        // We could have been deleted (existing oldVal, null newval)
        if (oldVal && !newVal) {
          // We have been deleted. Cleanup ourselves
          res.$remove(true, true);
        } else {

          res.$created = true;

          if (oldVal._id && (newVal._id !== oldVal._id)) {
            throw new Error('Not allowed to change id');
          }

          // Merge the objects together using the oldVal as a base, and using *our* version
          // to resolve any conflicts. We may need to put in some conflict resolution logic
          // somewhere on a case by case basis
          var merge = utils.mergeObjects(res.$toObject(), oldVal, newVal);

          // Now put back in the merge values
          utils.removeResValues(res);
          utils.setResValues(res, merge);

          // Make sure we are stored
          _resources[res._id] = res;
        }
      }

      function updateServer(val) {
        this.$loc.$updateServer(val);
      }

      // updates or creates a model depending on whether we know about it already. This
      // is usually used when we recieve a response with model data from the server using
      // a non-standard method
      function updateOrCreate(val) {
        var res = _resources[val._id];
        if (!res) {
          res = new Resource(val, false, new Date().getTime());
        } else {
          res.$updateServer(val);
        }

        return res;
      }

      function createFromStorage(val, lastRequested) {
        var res = _resources[val._id];

        // If we do have already know about a resource then lets assume it is more up to date
        // than the storage version. If we haven't resolved yet though (or we don't yet have
        // an ID on the object) lets update our values
        if (!res) {
          res = new Resource(val, false, lastRequested);
        } else if (!res._id || !res.$resolved) {
          res.$updateServer(val);
        }

        return res;
      }

      function refresh() {
        this.$loc.$refresh();
      }

      function Resource(val, fromLoc, lastRequested) {
        var res = this;
        this.$deleted = false;
        this.$deferred = $q.defer();
        this.$promise = this.$deferred.promise; // An initial promise for our initial
                                                // fetch or create of data
        this.$resolved = false; // Have we had an initial resolution of the promise
        this.$created = false; // Goes true on an initial save

        // If we've been given values put them on
        if (val) {
          var props = fromLoc ? val.$toObject() : val;
          for (var key in props) {
            res[key] = props[key];
          }
        }

        // Create the local resource
        if (fromLoc) {
          this.$loc = val;
          this.$loc.$mod = this;

          // Resolve the promise once the local copy has resolved
          this.$loc.$promise.then(function() {
            if (!res.$resolved) {
              res.$deferred.resolve(res);
              res.$resolved = true;
            }
          });
        } else if (this._id) {
          // We have an id - so we persist down
          this.$loc = new LocalResource(val, false, this, lastRequested);

          // We immediately resolve our promise since we have data
          this.$deferred.resolve(this);
          this.$resolved = true;
        } else {
          // Don't add in the values until we save
          this.$loc = new LocalResource(null, false, this);
        }

        this.$id = this.$loc.$id;
        _resFromLocal[this.$id] = this;

        // If we have an id then add us to the store
        if (this._id) {
          _resources[this._id] = this;
        }

        // Listen for changes on the local resource
        this.$loc.$emitter.on('update', function(newVal, oldVal) {
          updatedLocal(res, newVal, oldVal);
        });

      }

      Resource.get = get;
      Resource.query = query;
      Resource.chain = chain;
      Resource.type = type;
      Resource.collect = collection;
      Resource.updateOrCreate = updateOrCreate;

      // Event emitter 'inheritance'
      var eeprops = [
        'addListener',
        'on',
        'once',
        'removeListener'
      ];
      eeprops.forEach(function(prop) {
        Resource[prop] = function() {
          return emitter[prop].apply(emitter, arguments);
        };
      });

      Resource.prototype.$save = save;
      Resource.prototype.$remove = remove;
      Resource.prototype.$delete = remove;
      Resource.prototype.$type = type;
      Resource.prototype.$reset = reset;
      Resource.prototype.$refresh = refresh;
      Resource.prototype.$toObject = toObject;
      Resource.prototype.$updateServer = updateServer;

      return Resource;
    }

    ResourceFactory.Chain = Chain;

    return ResourceFactory;
  }
}
