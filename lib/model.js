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

exports['default'] = function () {

  // The length of time since an object has been requested that we keep in persistent storage.
  // In milliseconds - default to 7 days
  var pStorageMaxLen = 7 * 24 * 60 * 60 * 1000;

  // set pStorageMaxLen. In DAYS
  this.setPStorageMaxLen = function setPStorageMaxLen(len) {
    pStorageMaxLen = len * 24 * 60 * 60 * 1000;
  };

  this.$get = ResourceFactoryFactory;

  function ResourceFactoryFactory($window, $q, $rootScope, $timeout, $localForage, LocalResourceFactory, Chain, Collection) {
    'ngInject';

    function ResourceFactory(url, rootKey, rootKeyPlural) {
      rootKeyPlural = rootKeyPlural || rootKey + 's';

      // Create the local resource
      var LocalResource = LocalResourceFactory(url, rootKey, rootKeyPlural);

      // In memory resource store
      var _resources = {};
      var _resFromLocal = {};

      // Create an event emitter
      var emitter = new _events2['default'].EventEmitter();

      // Load from persistent storage (if we have something more exciting than localstorage)
      if (utils.advancedStorage($localForage)) {
        var pStorageKey = utils.persistentStorageKey(url);
        $localForage.getItem(pStorageKey).then(function (data) {
          if (!data) {
            return;
          }

          var now = new Date().getTime();

          data.forEach(function (datum) {
            var obj = datum.obj;
            var lastRequested = datum.lastreq;

            // Only create if the time between now and the last request is less than
            // pStorageMaxLen
            if (now - lastRequested <= pStorageMaxLen) {
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
        return this.$loc.$save(this.$toObject()).then(function () {
          if (!res.$resolved) {
            res.$deferred.resolve(res);
            res.$resolved = true;
          }
          return res;
        });
      }

      function remove(noPrompt, skipLocal) {
        if (!noPrompt) {
          // Add confirmation alert
          if (!$window.confirm('Do you really want to delete this item?')) {
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

          if (oldVal._id && newVal._id !== oldVal._id) {
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
          this.$loc.$promise.then(function () {
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
        this.$loc.$emitter.on('update', function (newVal, oldVal) {
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
      var eeprops = ['addListener', 'on', 'once', 'removeListener'];
      eeprops.forEach(function (prop) {
        Resource[prop] = function () {
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
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,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QUFLLEdBQUcsS0FBSyxDQUFDOztBQUU5QixXQUFPLGVBQWUsQ0FBQztHQUN4QjtDQUNGIiwiZmlsZSI6Im1vZGVsLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGV2ZW50cyBmcm9tICdldmVudHMnO1xuaW1wb3J0ICogYXMgdXRpbHMgZnJvbSAnLi91dGlscyc7XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCkge1xuXG4gIC8vIFRoZSBsZW5ndGggb2YgdGltZSBzaW5jZSBhbiBvYmplY3QgaGFzIGJlZW4gcmVxdWVzdGVkIHRoYXQgd2Uga2VlcCBpbiBwZXJzaXN0ZW50IHN0b3JhZ2UuXG4gIC8vIEluIG1pbGxpc2Vjb25kcyAtIGRlZmF1bHQgdG8gNyBkYXlzXG4gIHZhciBwU3RvcmFnZU1heExlbiA9IDcgKiAyNCAqIDYwICogNjAgKiAxMDAwO1xuXG4gIC8vIHNldCBwU3RvcmFnZU1heExlbi4gSW4gREFZU1xuICB0aGlzLnNldFBTdG9yYWdlTWF4TGVuID0gZnVuY3Rpb24gc2V0UFN0b3JhZ2VNYXhMZW4obGVuKSB7XG4gICAgcFN0b3JhZ2VNYXhMZW4gPSBsZW4gKiAyNCAqIDYwICogNjAgKiAxMDAwO1xuICB9O1xuXG4gIHRoaXMuJGdldCA9IFJlc291cmNlRmFjdG9yeUZhY3Rvcnk7XG5cbiAgZnVuY3Rpb24gUmVzb3VyY2VGYWN0b3J5RmFjdG9yeSgkd2luZG93LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICRxLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJGxvY2FsRm9yYWdlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIExvY2FsUmVzb3VyY2VGYWN0b3J5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIENoYWluLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIENvbGxlY3Rpb24pIHtcbiAgICAnbmdJbmplY3QnO1xuXG4gICAgZnVuY3Rpb24gUmVzb3VyY2VGYWN0b3J5KHVybCwgcm9vdEtleSwgcm9vdEtleVBsdXJhbCkge1xuICAgICAgcm9vdEtleVBsdXJhbCA9IHJvb3RLZXlQbHVyYWwgfHwgKHJvb3RLZXkgKyAncycpO1xuXG4gICAgICAvLyBDcmVhdGUgdGhlIGxvY2FsIHJlc291cmNlXG4gICAgICB2YXIgTG9jYWxSZXNvdXJjZSA9IExvY2FsUmVzb3VyY2VGYWN0b3J5KHVybCwgcm9vdEtleSwgcm9vdEtleVBsdXJhbCk7XG5cbiAgICAgIC8vIEluIG1lbW9yeSByZXNvdXJjZSBzdG9yZVxuICAgICAgdmFyIF9yZXNvdXJjZXMgPSB7fTtcbiAgICAgIHZhciBfcmVzRnJvbUxvY2FsID0ge307XG5cbiAgICAgIC8vIENyZWF0ZSBhbiBldmVudCBlbWl0dGVyXG4gICAgICB2YXIgZW1pdHRlciA9IG5ldyBldmVudHMuRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgIC8vIExvYWQgZnJvbSBwZXJzaXN0ZW50IHN0b3JhZ2UgKGlmIHdlIGhhdmUgc29tZXRoaW5nIG1vcmUgZXhjaXRpbmcgdGhhbiBsb2NhbHN0b3JhZ2UpXG4gICAgICBpZiAodXRpbHMuYWR2YW5jZWRTdG9yYWdlKCRsb2NhbEZvcmFnZSkpIHtcbiAgICAgICAgdmFyIHBTdG9yYWdlS2V5ID0gdXRpbHMucGVyc2lzdGVudFN0b3JhZ2VLZXkodXJsKTtcbiAgICAgICAgJGxvY2FsRm9yYWdlLmdldEl0ZW0ocFN0b3JhZ2VLZXkpLnRoZW4oZnVuY3Rpb24oZGF0YSkge1xuICAgICAgICAgIGlmICghZGF0YSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHZhciBub3cgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcblxuICAgICAgICAgIGRhdGEuZm9yRWFjaChmdW5jdGlvbihkYXR1bSkge1xuICAgICAgICAgICAgdmFyIG9iaiA9IGRhdHVtLm9iajtcbiAgICAgICAgICAgIHZhciBsYXN0UmVxdWVzdGVkID0gZGF0dW0ubGFzdHJlcTtcblxuICAgICAgICAgICAgLy8gT25seSBjcmVhdGUgaWYgdGhlIHRpbWUgYmV0d2VlbiBub3cgYW5kIHRoZSBsYXN0IHJlcXVlc3QgaXMgbGVzcyB0aGFuXG4gICAgICAgICAgICAvLyBwU3RvcmFnZU1heExlblxuICAgICAgICAgICAgaWYgKChub3cgLSBsYXN0UmVxdWVzdGVkKSA8PSBwU3RvcmFnZU1heExlbikge1xuICAgICAgICAgICAgICBjcmVhdGVGcm9tU3RvcmFnZShvYmosIGxhc3RSZXF1ZXN0ZWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gbG9jYWxUb1Jlcyhsb2MsIGlkKSB7XG4gICAgICAgIHZhciByZXMgPSBfcmVzRnJvbUxvY2FsW2xvYy4kaWRdO1xuXG4gICAgICAgIC8vIElmIHdlIGRvbid0IGhhdmUgYSByZXNvdXJjZSB0aGVuIGNyZWF0ZSBpdFxuICAgICAgICBpZiAoIXJlcykge1xuICAgICAgICAgIHJlcyA9IG5ldyBSZXNvdXJjZShsb2MsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGlkKSB7XG4gICAgICAgICAgX3Jlc291cmNlc1tpZF0gPSByZXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiB0b09iamVjdCgpIHtcbiAgICAgICAgcmV0dXJuIHV0aWxzLnRvT2JqZWN0KHRoaXMpO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiByZXNldCgpIHtcblxuICAgICAgICAvLyBJZiB3ZSBhcmVuJ3Qgc2F2ZWQgYXQgYWxsIHRoZW4ganVzdCByZW1vdmVcbiAgICAgICAgaWYgKCF0aGlzLiRjcmVhdGVkKSB7XG4gICAgICAgICAgdGhpcy4kcmVtb3ZlKHRydWUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBuZXdWYWx1ZXMgPSB0aGlzLiRsb2MuJHRvT2JqZWN0KCk7XG4gICAgICAgIHV0aWxzLnJlbW92ZVJlc1ZhbHVlcyh0aGlzKTtcbiAgICAgICAgdXRpbHMuc2V0UmVzVmFsdWVzKHRoaXMsIG5ld1ZhbHVlcyk7XG4gICAgICB9XG5cbiAgICAgIC8vIFRoZSBwcm9taXNlIHJlc29sdmVzIG9uY2UgdGhlIHNhdmUgaGFzIGJlZW4gY29tbWl0dGVkXG4gICAgICBmdW5jdGlvbiBzYXZlKCkge1xuICAgICAgICB2YXIgcmVzID0gdGhpcztcbiAgICAgICAgcmVzLiRjcmVhdGVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXMuJGxvYy4kc2F2ZSh0aGlzLiR0b09iamVjdCgpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgcmVzLiRkZWZlcnJlZC5yZXNvbHZlKHJlcyk7XG4gICAgICAgICAgICByZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHJlbW92ZShub1Byb21wdCwgc2tpcExvY2FsKSB7XG4gICAgICAgIGlmKCFub1Byb21wdCkge1xuICAgICAgICAgIC8vIEFkZCBjb25maXJtYXRpb24gYWxlcnRcbiAgICAgICAgICBpZighJHdpbmRvdy5jb25maXJtKCdEbyB5b3UgcmVhbGx5IHdhbnQgdG8gZGVsZXRlIHRoaXMgaXRlbT8nKSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB0aGlzLiRkZWxldGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKHRoaXMuX2lkKSB7XG4gICAgICAgICAgZGVsZXRlIF9yZXNvdXJjZXNbdGhpcy5faWRdO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIHByb207XG4gICAgICAgIGlmIChza2lwTG9jYWwpIHtcbiAgICAgICAgICBwcm9tID0gJHEud2hlbih0cnVlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBwcm9tID0gdGhpcy4kbG9jLiRyZW1vdmUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGVtaXR0ZXIuZW1pdCgncmVtb3ZlJywgdGhpcyk7XG5cbiAgICAgICAgcmV0dXJuIHByb207XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHR5cGUoKSB7XG4gICAgICAgIHJldHVybiByb290S2V5WzBdLnRvVXBwZXJDYXNlKCkgKyByb290S2V5LnNsaWNlKDEpO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBjb2xsZWN0aW9uKHNlZWRzLCByZWxhdGlvbikge1xuICAgICAgICByZXR1cm4gQ29sbGVjdGlvbihSZXNvdXJjZSwgc2VlZHMsIHJlbGF0aW9uKTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gY2hhaW4ob3JpZ1FyeSwgTW9kZWwsIHFyeUZuKSB7XG4gICAgICAgIHJldHVybiBDaGFpbihvcmlnUXJ5LCBNb2RlbCwgcXJ5Rm4pO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBxdWVyeShxcnksIGxpbWl0KSB7XG4gICAgICAgIHZhciByZXN1bHQgPSBMb2NhbFJlc291cmNlLnF1ZXJ5KHFyeSwgbGltaXQsIFJlc291cmNlKTtcbiAgICAgICAgZW1pdHRlci5lbWl0KCdxdWVyeScsIHJlc3VsdCwgcXJ5LCBsaW1pdCk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGdldChpZHMsIGZvcmNlKSB7XG4gICAgICAgIHZhciByZXN1bHRzID0gTG9jYWxSZXNvdXJjZS5nZXQoaWRzLCBmb3JjZSwgbG9jYWxUb1Jlcyk7XG4gICAgICAgIGVtaXR0ZXIuZW1pdCgnZ2V0JywgaWRzLCByZXN1bHRzLCBmb3JjZSk7XG4gICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiB1cGRhdGVkTG9jYWwocmVzLCBuZXdWYWwsIG9sZFZhbCkge1xuXG4gICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgYmVlbiBkZWxldGVkIChleGlzdGluZyBvbGRWYWwsIG51bGwgbmV3dmFsKVxuICAgICAgICBpZiAob2xkVmFsICYmICFuZXdWYWwpIHtcbiAgICAgICAgICAvLyBXZSBoYXZlIGJlZW4gZGVsZXRlZC4gQ2xlYW51cCBvdXJzZWx2ZXNcbiAgICAgICAgICByZXMuJHJlbW92ZSh0cnVlLCB0cnVlKTtcbiAgICAgICAgfSBlbHNlIHtcblxuICAgICAgICAgIHJlcy4kY3JlYXRlZCA9IHRydWU7XG5cbiAgICAgICAgICBpZiAob2xkVmFsLl9pZCAmJiAobmV3VmFsLl9pZCAhPT0gb2xkVmFsLl9pZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGFsbG93ZWQgdG8gY2hhbmdlIGlkJyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gTWVyZ2UgdGhlIG9iamVjdHMgdG9nZXRoZXIgdXNpbmcgdGhlIG9sZFZhbCBhcyBhIGJhc2UsIGFuZCB1c2luZyAqb3VyKiB2ZXJzaW9uXG4gICAgICAgICAgLy8gdG8gcmVzb2x2ZSBhbnkgY29uZmxpY3RzLiBXZSBtYXkgbmVlZCB0byBwdXQgaW4gc29tZSBjb25mbGljdCByZXNvbHV0aW9uIGxvZ2ljXG4gICAgICAgICAgLy8gc29tZXdoZXJlIG9uIGEgY2FzZSBieSBjYXNlIGJhc2lzXG4gICAgICAgICAgdmFyIG1lcmdlID0gdXRpbHMubWVyZ2VPYmplY3RzKHJlcy4kdG9PYmplY3QoKSwgb2xkVmFsLCBuZXdWYWwpO1xuXG4gICAgICAgICAgLy8gTm93IHB1dCBiYWNrIGluIHRoZSBtZXJnZSB2YWx1ZXNcbiAgICAgICAgICB1dGlscy5yZW1vdmVSZXNWYWx1ZXMocmVzKTtcbiAgICAgICAgICB1dGlscy5zZXRSZXNWYWx1ZXMocmVzLCBtZXJnZSk7XG5cbiAgICAgICAgICAvLyBNYWtlIHN1cmUgd2UgYXJlIHN0b3JlZFxuICAgICAgICAgIF9yZXNvdXJjZXNbcmVzLl9pZF0gPSByZXM7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gdXBkYXRlU2VydmVyKHZhbCkge1xuICAgICAgICB0aGlzLiRsb2MuJHVwZGF0ZVNlcnZlcih2YWwpO1xuICAgICAgfVxuXG4gICAgICAvLyB1cGRhdGVzIG9yIGNyZWF0ZXMgYSBtb2RlbCBkZXBlbmRpbmcgb24gd2hldGhlciB3ZSBrbm93IGFib3V0IGl0IGFscmVhZHkuIFRoaXNcbiAgICAgIC8vIGlzIHVzdWFsbHkgdXNlZCB3aGVuIHdlIHJlY2lldmUgYSByZXNwb25zZSB3aXRoIG1vZGVsIGRhdGEgZnJvbSB0aGUgc2VydmVyIHVzaW5nXG4gICAgICAvLyBhIG5vbi1zdGFuZGFyZCBtZXRob2RcbiAgICAgIGZ1bmN0aW9uIHVwZGF0ZU9yQ3JlYXRlKHZhbCkge1xuICAgICAgICB2YXIgcmVzID0gX3Jlc291cmNlc1t2YWwuX2lkXTtcbiAgICAgICAgaWYgKCFyZXMpIHtcbiAgICAgICAgICByZXMgPSBuZXcgUmVzb3VyY2UodmFsLCBmYWxzZSwgbmV3IERhdGUoKS5nZXRUaW1lKCkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlcy4kdXBkYXRlU2VydmVyKHZhbCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBjcmVhdGVGcm9tU3RvcmFnZSh2YWwsIGxhc3RSZXF1ZXN0ZWQpIHtcbiAgICAgICAgdmFyIHJlcyA9IF9yZXNvdXJjZXNbdmFsLl9pZF07XG5cbiAgICAgICAgLy8gSWYgd2UgZG8gaGF2ZSBhbHJlYWR5IGtub3cgYWJvdXQgYSByZXNvdXJjZSB0aGVuIGxldHMgYXNzdW1lIGl0IGlzIG1vcmUgdXAgdG8gZGF0ZVxuICAgICAgICAvLyB0aGFuIHRoZSBzdG9yYWdlIHZlcnNpb24uIElmIHdlIGhhdmVuJ3QgcmVzb2x2ZWQgeWV0IHRob3VnaCAob3Igd2UgZG9uJ3QgeWV0IGhhdmVcbiAgICAgICAgLy8gYW4gSUQgb24gdGhlIG9iamVjdCkgbGV0cyB1cGRhdGUgb3VyIHZhbHVlc1xuICAgICAgICBpZiAoIXJlcykge1xuICAgICAgICAgIHJlcyA9IG5ldyBSZXNvdXJjZSh2YWwsIGZhbHNlLCBsYXN0UmVxdWVzdGVkKTtcbiAgICAgICAgfSBlbHNlIGlmICghcmVzLl9pZCB8fCAhcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgIHJlcy4kdXBkYXRlU2VydmVyKHZhbCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiByZWZyZXNoKCkge1xuICAgICAgICB0aGlzLiRsb2MuJHJlZnJlc2goKTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gUmVzb3VyY2UodmFsLCBmcm9tTG9jLCBsYXN0UmVxdWVzdGVkKSB7XG4gICAgICAgIHZhciByZXMgPSB0aGlzO1xuICAgICAgICB0aGlzLiRkZWxldGVkID0gZmFsc2U7XG4gICAgICAgIHRoaXMuJGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgdGhpcy4kcHJvbWlzZSA9IHRoaXMuJGRlZmVycmVkLnByb21pc2U7IC8vIEFuIGluaXRpYWwgcHJvbWlzZSBmb3Igb3VyIGluaXRpYWxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZldGNoIG9yIGNyZWF0ZSBvZiBkYXRhXG4gICAgICAgIHRoaXMuJHJlc29sdmVkID0gZmFsc2U7IC8vIEhhdmUgd2UgaGFkIGFuIGluaXRpYWwgcmVzb2x1dGlvbiBvZiB0aGUgcHJvbWlzZVxuICAgICAgICB0aGlzLiRjcmVhdGVkID0gZmFsc2U7IC8vIEdvZXMgdHJ1ZSBvbiBhbiBpbml0aWFsIHNhdmVcblxuICAgICAgICAvLyBJZiB3ZSd2ZSBiZWVuIGdpdmVuIHZhbHVlcyBwdXQgdGhlbSBvblxuICAgICAgICBpZiAodmFsKSB7XG4gICAgICAgICAgdmFyIHByb3BzID0gZnJvbUxvYyA/IHZhbC4kdG9PYmplY3QoKSA6IHZhbDtcbiAgICAgICAgICBmb3IgKHZhciBrZXkgaW4gcHJvcHMpIHtcbiAgICAgICAgICAgIHJlc1trZXldID0gcHJvcHNba2V5XTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGxvY2FsIHJlc291cmNlXG4gICAgICAgIGlmIChmcm9tTG9jKSB7XG4gICAgICAgICAgdGhpcy4kbG9jID0gdmFsO1xuICAgICAgICAgIHRoaXMuJGxvYy4kbW9kID0gdGhpcztcblxuICAgICAgICAgIC8vIFJlc29sdmUgdGhlIHByb21pc2Ugb25jZSB0aGUgbG9jYWwgY29weSBoYXMgcmVzb2x2ZWRcbiAgICAgICAgICB0aGlzLiRsb2MuJHByb21pc2UudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmICghcmVzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgICByZXMuJGRlZmVycmVkLnJlc29sdmUocmVzKTtcbiAgICAgICAgICAgICAgcmVzLiRyZXNvbHZlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy5faWQpIHtcbiAgICAgICAgICAvLyBXZSBoYXZlIGFuIGlkIC0gc28gd2UgcGVyc2lzdCBkb3duXG4gICAgICAgICAgdGhpcy4kbG9jID0gbmV3IExvY2FsUmVzb3VyY2UodmFsLCBmYWxzZSwgdGhpcywgbGFzdFJlcXVlc3RlZCk7XG5cbiAgICAgICAgICAvLyBXZSBpbW1lZGlhdGVseSByZXNvbHZlIG91ciBwcm9taXNlIHNpbmNlIHdlIGhhdmUgZGF0YVxuICAgICAgICAgIHRoaXMuJGRlZmVycmVkLnJlc29sdmUodGhpcyk7XG4gICAgICAgICAgdGhpcy4kcmVzb2x2ZWQgPSB0cnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIERvbid0IGFkZCBpbiB0aGUgdmFsdWVzIHVudGlsIHdlIHNhdmVcbiAgICAgICAgICB0aGlzLiRsb2MgPSBuZXcgTG9jYWxSZXNvdXJjZShudWxsLCBmYWxzZSwgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLiRpZCA9IHRoaXMuJGxvYy4kaWQ7XG4gICAgICAgIF9yZXNGcm9tTG9jYWxbdGhpcy4kaWRdID0gdGhpcztcblxuICAgICAgICAvLyBJZiB3ZSBoYXZlIGFuIGlkIHRoZW4gYWRkIHVzIHRvIHRoZSBzdG9yZVxuICAgICAgICBpZiAodGhpcy5faWQpIHtcbiAgICAgICAgICBfcmVzb3VyY2VzW3RoaXMuX2lkXSA9IHRoaXM7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBMaXN0ZW4gZm9yIGNoYW5nZXMgb24gdGhlIGxvY2FsIHJlc291cmNlXG4gICAgICAgIHRoaXMuJGxvYy4kZW1pdHRlci5vbigndXBkYXRlJywgZnVuY3Rpb24obmV3VmFsLCBvbGRWYWwpIHtcbiAgICAgICAgICB1cGRhdGVkTG9jYWwocmVzLCBuZXdWYWwsIG9sZFZhbCk7XG4gICAgICAgIH0pO1xuXG4gICAgICB9XG5cbiAgICAgIFJlc291cmNlLmdldCA9IGdldDtcbiAgICAgIFJlc291cmNlLnF1ZXJ5ID0gcXVlcnk7XG4gICAgICBSZXNvdXJjZS5jaGFpbiA9IGNoYWluO1xuICAgICAgUmVzb3VyY2UudHlwZSA9IHR5cGU7XG4gICAgICBSZXNvdXJjZS5jb2xsZWN0ID0gY29sbGVjdGlvbjtcbiAgICAgIFJlc291cmNlLnVwZGF0ZU9yQ3JlYXRlID0gdXBkYXRlT3JDcmVhdGU7XG5cbiAgICAgIC8vIEV2ZW50IGVtaXR0ZXIgJ2luaGVyaXRhbmNlJ1xuICAgICAgdmFyIGVlcHJvcHMgPSBbXG4gICAgICAgICdhZGRMaXN0ZW5lcicsXG4gICAgICAgICdvbicsXG4gICAgICAgICdvbmNlJyxcbiAgICAgICAgJ3JlbW92ZUxpc3RlbmVyJ1xuICAgICAgXTtcbiAgICAgIGVlcHJvcHMuZm9yRWFjaChmdW5jdGlvbihwcm9wKSB7XG4gICAgICAgIFJlc291cmNlW3Byb3BdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgcmV0dXJuIGVtaXR0ZXJbcHJvcF0uYXBwbHkoZW1pdHRlciwgYXJndW1lbnRzKTtcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuXG4gICAgICBSZXNvdXJjZS5wcm90b3R5cGUuJHNhdmUgPSBzYXZlO1xuICAgICAgUmVzb3VyY2UucHJvdG90eXBlLiRyZW1vdmUgPSByZW1vdmU7XG4gICAgICBSZXNvdXJjZS5wcm90b3R5cGUuJGRlbGV0ZSA9IHJlbW92ZTtcbiAgICAgIFJlc291cmNlLnByb3RvdHlwZS4kdHlwZSA9IHR5cGU7XG4gICAgICBSZXNvdXJjZS5wcm90b3R5cGUuJHJlc2V0ID0gcmVzZXQ7XG4gICAgICBSZXNvdXJjZS5wcm90b3R5cGUuJHJlZnJlc2ggPSByZWZyZXNoO1xuICAgICAgUmVzb3VyY2UucHJvdG90eXBlLiR0b09iamVjdCA9IHRvT2JqZWN0O1xuICAgICAgUmVzb3VyY2UucHJvdG90eXBlLiR1cGRhdGVTZXJ2ZXIgPSB1cGRhdGVTZXJ2ZXI7XG5cbiAgICAgIHJldHVybiBSZXNvdXJjZTtcbiAgICB9XG5cbiAgICBSZXNvdXJjZUZhY3RvcnkuQ2hhaW4gPSBDaGFpbjtcblxuICAgIHJldHVybiBSZXNvdXJjZUZhY3Rvcnk7XG4gIH1cbn1cbiJdLCJzb3VyY2VSb290IjoiL3NvdXJjZS8ifQ==
