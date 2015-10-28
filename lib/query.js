'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _events = require('events');

var _events2 = _interopRequireDefault(_events);

var _lodashClone = require('lodash.clone');

var _lodashClone2 = _interopRequireDefault(_lodashClone);

var _lodashIsempty = require('lodash.isempty');

var _lodashIsempty2 = _interopRequireDefault(_lodashIsempty);

var _lodashValues = require('lodash.values');

var _lodashValues2 = _interopRequireDefault(_lodashValues);

var _lodashFlatten = require('lodash.flatten');

var _lodashFlatten2 = _interopRequireDefault(_lodashFlatten);

var _lodashUniq = require('lodash.uniq');

var _lodashUniq2 = _interopRequireDefault(_lodashUniq);

var _lodashPluck = require('lodash.pluck');

var _lodashPluck2 = _interopRequireDefault(_lodashPluck);

var _lodashUnion = require('lodash.union');

var _lodashUnion2 = _interopRequireDefault(_lodashUnion);

var _lodashWithout = require('lodash.without');

var _lodashWithout2 = _interopRequireDefault(_lodashWithout);

var _angular = require('angular');

var _angular2 = _interopRequireDefault(_angular);

var _queryTransforms = require('./query-transforms');

var _queryTransforms2 = _interopRequireDefault(_queryTransforms);

// These are the operators nedb supports
var simpleOperators = {
  '$lt': true,
  '$lte': true,
  '$gt': true,
  '$gte': true,
  '$in': true,
  '$nin': true,
  '$ne': true,
  '$exists': true,
  '$regex': true,
  '$size': true,
  '$or': true,
  '$and': true,
  '$not': true
};

function normalizeQuery(qry) {
  if (!qry) {
    return;
  }

  if (qry._q) {
    return qry._q;
  } else if (qry.find) {
    return qry;
  } else {
    return { find: qry };
  }
}

// Returns true if it is a simple query that we can process with nedb
function qryIsSimple(qry) {
  var simple = true;

  if (Array.isArray(qry)) {
    qry.forEach(function (val) {
      var kosher = qryIsSimple(val);
      if (!kosher) {
        simple = false;
        return false;
      }
    });
  } else if (_angular2['default'].isObject(qry)) {
    for (var key in qry) {
      var val = qry[key];
      // The key is fine if it doesn't begin with $ or is a simple operator
      var kosherKey = key[0] !== '$' || simpleOperators[key];

      if (!kosherKey) {
        simple = false;
        break;
      }

      var valKosher = qryIsSimple(val);

      if (!valKosher) {
        simple = false;
        break;
      }
    }
  }

  return simple;
}

// Convert any _id searches to __id (which is where our id moved to)
function _createDbFind(qry) {
  if (Array.isArray(qry)) {
    qry.forEach(function (val) {
      _createDbFind(val);
    });
  } else if (_angular2['default'].isObject(qry)) {
    for (var key in qry) {
      var val = qry[key];

      // Convert the _id to __id searches
      if (key === '_id') {
        qry.__id = val;
        delete qry._id;
      }

      _createDbFind(val);
    }
  }
}

function createDbFind(qry) {
  // Converts the query into the form required for a db search. First clone the object
  qry = (0, _lodashClone2['default'])(qry, true);
  _createDbFind(qry);
  return qry;
}

function extendQuery(qry1, qry2) {
  // Calc the new query that we want
  var _qry = (0, _lodashClone2['default'])(qry1, true);
  ['limit', 'skip', 'sort'].forEach(function (prop) {
    if (qry2[prop]) {
      _qry[prop] = qry2[prop];
    }
  });

  if (!(0, _lodashIsempty2['default'])(qry2.find)) {
    // Want to or together - but is the toplevel already an or? (and only an or)
    var existingOr = false;
    if (_qry.find.$or) {
      var valid = true;
      for (var key in _qry.find) {
        if (key !== '$or') {
          valid = false;
          break;
        }
      }
      existingOr = valid;
    }

    if (existingOr) {
      _qry.find = (0, _lodashClone2['default'])(_qry.find);
    } else {
      _qry.find = { $or: [_qry.find] };
    }

    _qry.find.$or.push(qry2.find);
  }

  return _qry;
}

exports['default'] = function ($rootScope, $q, $timeout, $injector, Chain) {
  'ngInject';

  function QueryFactory(url, rootKey, rootKeyPlural, db) {
    var socket = $injector.get('socket');
    var sock = socket(url, rootKey, rootKeyPlural);

    // Object holding queries (keys are the query ids, values are arrays of arrays)
    var _serverQueries = {};
    var _localQueries = [];

    // If the socket resets or connects then refetch everything
    sock.on('reset', function () {
      refreshQueries();
    });
    sock.on('connected', function () {
      refreshQueries();
    });

    // Listen for modified queries
    sock.on('modified query', function (qryId, data) {
      var qrys = _serverQueries[qryId];
      if (qrys) {
        qrys.forEach(function (qry) {
          qry.$newData(qryId, data);
        });
      }
    });

    function refreshQueries() {
      var resultsSet = (0, _lodashUniq2['default'])((0, _lodashFlatten2['default'])((0, _lodashValues2['default'])(_serverQueries), true));
      resultsSet.forEach(function (results) {
        results.$refresh();
      });
    }

    /**
     * Local Query List
     * @param {[type]} qry      [description]
     * @param {[type]} limit    [description]
     * @param {[type]} Resource [description]
     * @param {[type]} toRes    [description]
     *
     * Strategy - we run the query on the server. However if we can deal with it locally (via
     * nedb) then do so. If the query at any time becomes more complicated we just fall through
     * to the server version
     */
    function LocalQueryList(qry, limit, Resource, toRes) {
      // Allow qry to be a promise, and we return the raw (non _q bit)
      qry = $q.when(qry).then(normalizeQuery).then(function (_qry) {
        if (limit) {
          _qry.limit = limit;
        }
        return _qry;
      });

      // Generate the ServerQuery. We do this so we have something to fall back on
      // and also so that we will (or should!) get notified of changes from the server if
      // someone else creates or removes something that should go in these results
      var serverResults = ServerQueryList(qry, limit, Resource);

      var results = [];
      _localQueries.push(results);
      var currentLimit = 0;
      var currentSkip = 0;
      var lastBatchSize = 0;
      var fallback = false;

      results.loading = true;

      // When the server results are updated we want to check paging options and apply
      // them to our results
      serverResults.$emitter.on('update', syncFromServer);

      function syncFromServer() {
        results.hasNext = serverResults.hasNext;
        results.hasPrev = serverResults.hasPrev;

        // If we are falling back then set up and copy our various properties across
        if (fallback) {
          results.$hasNext = false;
          results.$hasPrev = false;
          results.length = 0;
          serverResults.forEach(function (res) {
            results.push(res);
          });

          currentLimit = results.length;
          currentSkip = results.$skip;
          lastBatchSize = lastBatchSize || results.length;
        }
      }

      function get() {
        return Resource.get.apply(Resource, arguments);
      }

      function chain(Model, qryFn) {
        return Chain(results, Model, qryFn);
      }

      function query(_qry) {

        // Store off the qry making sure its a promise
        qry = $q.when(_qry);

        fallback = !qryIsSimple(_qry);

        // If we are fallingback then just resolve with our results. The server should
        // do the rest.
        if (fallback) {
          // We want to return the server's promise here so that people will be notified
          // when the results are actually loaded
          var prom;
          if (!serverResults.$resolved) {
            prom = serverResults.$promise.then(function () {
              return results;
            });
          } else {
            prom = $q.when(results);
          }

          return prom;
        }

        var deferred = $q.defer();
        var find = createDbFind(_qry.find);
        var limit = _qry.limit;
        var skip = _qry.skip;
        var sort = _qry.sort;

        var cur = db.find(find);

        if (sort) {
          cur = cur.sort(sort);
        }
        if (skip) {
          cur = cur.skip(skip);
        }
        if (limit) {
          // We go + 1 so we can tell if there are any more results
          cur = cur.limit(limit + 1);
        }

        cur.exec(function (err, docs) {
          $rootScope.$apply(function () {
            if (err) {
              deferred.reject(err);
              return;
            }

            // We can set the hasNext and hasPrev values to true here if we know there
            // are some. However only the server has the definitive ability to say
            // there arent any
            results.$hasNext = false;
            results.$hasPrev = false;
            if (limit && docs.length > limit) {
              // We have more results to fetch
              results.hasNext = true;
              results.$hasNext = true;

              // Trim the results down to size
              docs.length -= 1;
            }

            if (skip) {
              results.hasPrev = true;
              results.$hasPrev = true;
            }

            // Calculate paging options
            currentLimit = docs.length;
            currentSkip = skip || 0;
            lastBatchSize = lastBatchSize || docs.length;

            // Go to resource types
            var tmpResults = docs.map(toRes);

            // Do we need to do a transform?
            var rprom;
            if (_angular2['default'].isFunction(results.transform)) {
              rprom = $q.when(results.transform(tmpResults));
            } else {
              rprom = $q.when(tmpResults);
            }

            return rprom.then(function (transformed) {
              // Put the resources into the list
              results.length = 0;
              transformed.forEach(function (res) {
                results.push(res);
              });

              results.$emitter.emit('update', results);

              deferred.resolve(results);
            });
          });
        });

        return deferred.promise;
      }

      function refreshQuery(forceServer) {
        // Perform our query
        var prom = qry.then(query).then(function (res) {
          // If we don't have any results then maybe wait for the server to return
          if (res.length === 0 && !serverResults.$resolved) {
            return serverResults.$promise.then(function () {
              return refreshQuery();
            });
          } else {
            return res;
          }
        });

        if (forceServer) {
          prom = serverResults.$refresh(true);
        }

        return prom.then(function (res) {
          results.loading = false;
          return res;
        });
      }

      function extendResults(obj, noSanitize, retServer) {

        // Sanitize the object
        if (!noSanitize) {
          if (obj._q) {
            obj = obj._q;
          } else {
            obj = { find: obj };
          }
        }

        return qry.then(function (resolved) {
          var _qry = extendQuery(resolved, obj);
          return replace(_qry, retServer);
        });
      }

      function replace(_qry, retServer) {
        // Sync down to the serverquery
        var serverProm = serverResults.replace(_qry);

        // Do the query but replace the existing query
        var localProm = $q.when(_qry).then(normalizeQuery).then(function (normQry) {

          // We allow a query to resolve to something falsy - in which case we just
          // drop it
          if (!normQry) {
            return;
          }

          return qry.then(function (oldqry) {
            if (JSON.stringify(oldqry) !== JSON.stringify(normQry)) {
              // query is different - continue

              return query(normQry);
            }
          });
        });

        return retServer ? serverProm : localProm;
      }

      function next(num) {
        var promise;
        var extendSize;
        if (results.hasNext) {
          lastBatchSize = extendSize = num || lastBatchSize;
          var extendObj = {
            limit: currentLimit + extendSize
          };
          promise = extendResults(extendObj, true, !results.$hasNext);
        } else {
          var deferred = $q.defer();
          deferred.resolve();
          promise = deferred.promise;
        }

        return promise;
      }

      function prev(num) {
        var promise;
        var extendSize;
        if (results.hasPrev) {
          lastBatchSize = extendSize = num || lastBatchSize;
          var extendObj = {
            skip: Math.max(currentSkip - extendSize, 0),
            limit: currentLimit + extendSize
          };
          promise = extendResults(extendObj, true, !results.$hasPrev);
        } else {
          var deferred = $q.defer();
          deferred.resolve();
          promise = deferred.promise;
        }

        return promise;
      }

      // Event emitter 'inheritance'
      var emitter = new _events2['default'].EventEmitter();
      var eeprops = ['addListener', 'on', 'once', 'removeListener'];
      eeprops.forEach(function (prop) {
        results[prop] = function () {
          return emitter[prop].apply(emitter, arguments);
        };
      });

      results.$refresh = refreshQuery;
      results.extend = extendResults;
      results.replace = replace;
      results.get = get;
      results.next = next;
      results.prev = prev;
      results.$promise = refreshQuery();
      results.chain = chain;
      results.$Model = Resource;
      results.$emitter = emitter;
      results.$serverResults = serverResults;
      _queryTransforms2['default'].apply(results);

      return results;
    }

    var refreshTimer;
    LocalQueryList.refresh = function refresh() {

      // If we have a timer outstanding then just return - a refresh will happen soon.
      if (!refreshTimer) {
        refreshTimer = $timeout(doRefresh, 100);
      }

      return refreshTimer;

      function doRefresh() {
        _localQueries.forEach(function (res) {
          res.$refresh();
        });
        refreshTimer = null;
      }
    };

    /**
     * Server query list. The server makes sure we keep in sync
     * @param {[type]} qry      [description]
     * @param {[type]} limit    [description]
     * @param {[type]} Resource [description]
     */
    function ServerQueryList(qry, limit, Resource) {
      // Allow qry to be a promise
      qry = $q.when(qry).then(normalizeQuery).then(function (_qry) {
        if (limit) {
          _qry.limit = limit;
        }
        return _qry;
      });

      var emitPromise = null;
      var results = [];
      var currentLimit = 0;
      var currentSkip = 0;
      var lastBatchSize = 0;
      var qryId = null;
      var _pagingOpts = {};

      results.loading = true;

      function query(data, replaces) {
        // We only want to do one emit at a time (otherwise we could get into a bad state)
        if (_angular2['default'].isFunction(data)) {
          data = data();
        }

        // Store off the query - make sure its a promise
        qry = $q.when(data);

        return qry.then(function (data) {
          // If we have an existing emitPromise then wait for it to resolve before we run
          var promise;
          if (emitPromise) {
            promise = emitPromise.then(function () {
              return sock.query(data, replaces);
            });
          } else {
            emitPromise = promise = sock.query(data, replaces);
          }

          return promise;
        });
      }

      function newData(_qryId, response, force) {
        if (!response) {
          return;
        }

        var deferred = $q.defer();
        var ids = response.ids;
        var pagingOpts = response.pagingOpts;

        maybeNewQryId(_qryId);

        // So far we've only got the ids of the qry result - go and fetch the actual objects.
        // This mechanism saves bandwidth by only getting the object data once then listening
        // for changes to it
        //
        // If we are forcing we want to get both the old and new ids to check for any changes
        // deletions etc..
        var getIds = ids;
        if (force) {
          var oldIds = (0, _lodashPluck2['default'])(results, '_id');
          getIds = (0, _lodashUnion2['default'])(ids, oldIds);
        }

        Resource.get(getIds, force).$promise.then(function (ress) {
          var ressmap = {};
          ress.forEach(function (res) {
            ressmap[res._id] = res;
          });

          // We don't allow repeated ids so just iterate over the results
          var tmpResults = [];
          ids.forEach(function (id) {
            tmpResults.push(ressmap[id]);
          });

          // Do we need to do a transform?
          var rprom;
          if (_angular2['default'].isFunction(results.transform)) {
            rprom = $q.when(results.transform(tmpResults));
          } else {
            rprom = $q.when(tmpResults);
          }

          return rprom.then(function (transformed) {

            results.length = 0;
            transformed.forEach(function (res) {
              results.push(res);
            });

            // Since we now have data in our array store off limit data
            currentLimit = tmpResults.length;
            results.$skip = currentSkip = qry && qry.skip ? qry.skip : 0;
            lastBatchSize = lastBatchSize || tmpResults.length;
            _pagingOpts = pagingOpts;
            results.hasNext = pagingOpts.next != null;
            results.hasPrev = pagingOpts.prev != null;

            // Data has come back
            results.loading = false;

            results.$emitter.emit('update', results);

            deferred.resolve(results);
          });
        });

        return deferred.promise;
      }

      function maybeNewQryId(_qryId) {
        if (qryId !== _qryId) {

          var qryList;
          if (qryId) {
            // Update the qrylist (do we want to delete the old one?)
            qryList = _serverQueries[qryId] = (0, _lodashWithout2['default'])(_serverQueries[qryId], results);
            // If there are no members left in the query list then delete it
            if (qryList.length === 0) {
              delete _serverQueries[qryId];
            }
          }

          // Move the results to the new list
          qryId = _qryId;
          qryList = _serverQueries[qryId];
          if (!qryList) {
            qryList = _serverQueries[qryId] = [];
          }

          // Put the results into the new query list
          if (! ~qryList.indexOf(results)) {
            qryList.push(results);
          }
        }
      }

      function refreshQuery(force) {
        var req = query(qry);
        var promise = req.then(function (res) {

          // If we get no response (the app could be offline) then just resolve with
          // the existing results
          if (_angular2['default'].isUndefined(res)) {
            results.loading = false;
            return results;
          }

          var _qryId = res.qryId;
          var response = res.data;

          return newData(_qryId, response, force);
        });
        return promise;
      }

      function replace(_qry) {
        // Do the query but replace the existing query
        return $q.when(_qry).then(normalizeQuery).then(function (normQry) {

          // We allow a query to resolve to something falsy - in which case we just
          // drop it
          if (!normQry) {
            return;
          }

          return qry.then(function (oldqry) {
            if (JSON.stringify(oldqry) !== JSON.stringify(normQry)) {
              // query is different - continue
              var req = query(normQry, qryId);

              var promise = req.then(function (res) {
                // If we get no response (the app could be offline) then just resolve with
                // the existing results
                if (_angular2['default'].isUndefined(res)) {
                  results.loading = false;
                  return results;
                }

                // We do have a response. Continue
                var _qryId = res.qryId;
                var data = res.data;

                return newData(_qryId, data);
              });

              return promise;
            }
          });
        });
      }

      function extendResults(obj, noSanitize) {

        // Sanitize the object
        if (!noSanitize) {
          if (obj._q) {
            obj = obj._q;
          } else {
            obj = { find: obj };
          }
        }

        return qry.then(function (resolved) {
          var _qry = extendQuery(resolved, obj);
          return replace(_qry);
        });
      }

      function next(num) {
        var promise;
        var extendSize;
        if (_pagingOpts.next) {
          lastBatchSize = extendSize = num || lastBatchSize;
          var extendObj = {
            limit: currentLimit + extendSize
          };
          promise = extendResults(extendObj, true);
        } else {
          var deferred = $q.defer();
          deferred.resolve();
          promise = deferred.promise;
        }

        return promise;
      }

      function prev(num) {
        var promise;
        var extendSize;
        if (_pagingOpts.prev) {
          lastBatchSize = extendSize = num || lastBatchSize;
          var extendObj = {
            skip: Math.max(currentSkip - extendSize, 0),
            limit: currentLimit + extendSize
          };
          promise = extendResults(extendObj, true);
        } else {
          var deferred = $q.defer();
          deferred.resolve();
          promise = deferred.promise;
        }

        return promise;
      }

      function get() {
        return Resource.get.apply(Resource, arguments);
      }

      function chain(Model, qryFn) {
        return Chain(results, Model, qryFn);
      }

      results.$newData = newData;
      results.$refresh = refreshQuery;
      results.extend = extendResults;
      results.replace = replace;
      results.get = get;
      results.next = next;
      results.prev = prev;
      results.$promise = refreshQuery().then(function (res) {
        results.$resolved = true;
        return res;
      });
      results.$resolved = false;
      results.chain = chain;
      results.$Model = Resource;
      results.$emitter = new _events2['default'].EventEmitter();
      results.$skip = 0;

      _queryTransforms2['default'].apply(results);

      return results;
    }

    return db ? LocalQueryList : ServerQueryList;
  }

  return QueryFactory;
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,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RCxlQUFPLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQztBQUN6QixlQUFPLEdBQUcsQ0FBQztPQUNaLENBQUMsQ0FBQztBQUNILGFBQU8sQ0FBQyxTQUFTLEdBQUcsS0FBSyxDQUFDO0FBQzFCLGFBQU8sQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBQ3RCLGFBQU8sQ0FBQyxNQUFNLEdBQUcsUUFBUSxDQUFDO0FBQzFCLGFBQU8sQ0FBQyxRQUFRLEdBQUcsSUFBSSxvQkFBTyxZQUFZLEVBQUUsQ0FBQztBQUM3QyxhQUFPLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQzs7QUFFbEIsbUNBQWdCLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQzs7QUFFL0IsYUFBTyxPQUFPLENBQUM7S0FDaEI7O0FBRUQsV0FBTyxFQUFFLEdBQUcsY0FBYyxHQUFHLGVBQWUsQ0FBQztHQUM5Qzs7QUFFRCxTQUFPLFlBQVksQ0FBQztDQUNyQiIsImZpbGUiOiJxdWVyeS5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBldmVudHMgZnJvbSAnZXZlbnRzJztcbmltcG9ydCBjbG9uZSBmcm9tICdsb2Rhc2guY2xvbmUnO1xuaW1wb3J0IGlzRW1wdHkgZnJvbSAnbG9kYXNoLmlzZW1wdHknO1xuaW1wb3J0IHZhbHVlcyBmcm9tICdsb2Rhc2gudmFsdWVzJztcbmltcG9ydCBmbGF0dGVuIGZyb20gJ2xvZGFzaC5mbGF0dGVuJztcbmltcG9ydCB1bmlxIGZyb20gJ2xvZGFzaC51bmlxJztcbmltcG9ydCBwbHVjayBmcm9tICdsb2Rhc2gucGx1Y2snO1xuaW1wb3J0IHVuaW9uIGZyb20gJ2xvZGFzaC51bmlvbic7XG5pbXBvcnQgd2l0aG91dCBmcm9tICdsb2Rhc2gud2l0aG91dCc7XG5pbXBvcnQgYW5ndWxhciBmcm9tICdhbmd1bGFyJztcblxuaW1wb3J0IHF1ZXJ5VHJhbnNmb3JtcyBmcm9tICcuL3F1ZXJ5LXRyYW5zZm9ybXMnO1xuXG4vLyBUaGVzZSBhcmUgdGhlIG9wZXJhdG9ycyBuZWRiIHN1cHBvcnRzXG52YXIgc2ltcGxlT3BlcmF0b3JzID0ge1xuICAnJGx0JzogdHJ1ZSxcbiAgJyRsdGUnOiB0cnVlLFxuICAnJGd0JzogdHJ1ZSxcbiAgJyRndGUnOiB0cnVlLFxuICAnJGluJzogdHJ1ZSxcbiAgJyRuaW4nOiB0cnVlLFxuICAnJG5lJzogdHJ1ZSxcbiAgJyRleGlzdHMnOiB0cnVlLFxuICAnJHJlZ2V4JzogdHJ1ZSxcbiAgJyRzaXplJzogdHJ1ZSxcbiAgJyRvcic6IHRydWUsXG4gICckYW5kJzogdHJ1ZSxcbiAgJyRub3QnOiB0cnVlXG59O1xuXG5mdW5jdGlvbiBub3JtYWxpemVRdWVyeShxcnkpIHtcbiAgaWYgKCFxcnkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocXJ5Ll9xKSB7XG4gICAgcmV0dXJuIHFyeS5fcTtcbiAgfSBlbHNlIGlmIChxcnkuZmluZCkge1xuICAgIHJldHVybiBxcnk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHtmaW5kOiBxcnl9O1xuICB9XG59XG5cbi8vIFJldHVybnMgdHJ1ZSBpZiBpdCBpcyBhIHNpbXBsZSBxdWVyeSB0aGF0IHdlIGNhbiBwcm9jZXNzIHdpdGggbmVkYlxuZnVuY3Rpb24gcXJ5SXNTaW1wbGUocXJ5KSB7XG4gIHZhciBzaW1wbGUgPSB0cnVlO1xuXG4gIGlmIChBcnJheS5pc0FycmF5KHFyeSkpIHtcbiAgICBxcnkuZm9yRWFjaChmdW5jdGlvbih2YWwpIHtcbiAgICAgIHZhciBrb3NoZXIgPSBxcnlJc1NpbXBsZSh2YWwpO1xuICAgICAgaWYgKCFrb3NoZXIpIHtcbiAgICAgICAgc2ltcGxlID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSBlbHNlIGlmIChhbmd1bGFyLmlzT2JqZWN0KHFyeSkpIHtcbiAgICBmb3IgKHZhciBrZXkgaW4gcXJ5KSB7XG4gICAgICB2YXIgdmFsID0gcXJ5W2tleV07XG4gICAgICAvLyBUaGUga2V5IGlzIGZpbmUgaWYgaXQgZG9lc24ndCBiZWdpbiB3aXRoICQgb3IgaXMgYSBzaW1wbGUgb3BlcmF0b3JcbiAgICAgIHZhciBrb3NoZXJLZXkgPSAoa2V5WzBdICE9PSAnJCcpIHx8IHNpbXBsZU9wZXJhdG9yc1trZXldO1xuXG4gICAgICBpZiAoIWtvc2hlcktleSkge1xuICAgICAgICBzaW1wbGUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIHZhciB2YWxLb3NoZXIgPSBxcnlJc1NpbXBsZSh2YWwpO1xuXG4gICAgICBpZiAoIXZhbEtvc2hlcikge1xuICAgICAgICBzaW1wbGUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHNpbXBsZTtcbn1cblxuLy8gQ29udmVydCBhbnkgX2lkIHNlYXJjaGVzIHRvIF9faWQgKHdoaWNoIGlzIHdoZXJlIG91ciBpZCBtb3ZlZCB0bylcbmZ1bmN0aW9uIF9jcmVhdGVEYkZpbmQocXJ5KSB7XG4gIGlmIChBcnJheS5pc0FycmF5KHFyeSkpIHtcbiAgICBxcnkuZm9yRWFjaChmdW5jdGlvbih2YWwpIHtcbiAgICAgIF9jcmVhdGVEYkZpbmQodmFsKTtcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChhbmd1bGFyLmlzT2JqZWN0KHFyeSkpIHtcbiAgICBmb3IgKHZhciBrZXkgaW4gcXJ5KSB7XG4gICAgICB2YXIgdmFsID0gcXJ5W2tleV07XG5cbiAgICAgIC8vIENvbnZlcnQgdGhlIF9pZCB0byBfX2lkIHNlYXJjaGVzXG4gICAgICBpZiAoa2V5ID09PSAnX2lkJykge1xuICAgICAgICBxcnkuX19pZCA9IHZhbDtcbiAgICAgICAgZGVsZXRlIHFyeS5faWQ7XG4gICAgICB9XG5cbiAgICAgIF9jcmVhdGVEYkZpbmQodmFsKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlRGJGaW5kKHFyeSkge1xuICAvLyBDb252ZXJ0cyB0aGUgcXVlcnkgaW50byB0aGUgZm9ybSByZXF1aXJlZCBmb3IgYSBkYiBzZWFyY2guIEZpcnN0IGNsb25lIHRoZSBvYmplY3RcbiAgcXJ5ID0gY2xvbmUocXJ5LCB0cnVlKTtcbiAgX2NyZWF0ZURiRmluZChxcnkpO1xuICByZXR1cm4gcXJ5O1xufVxuXG5mdW5jdGlvbiBleHRlbmRRdWVyeShxcnkxLCBxcnkyKSB7XG4gIC8vIENhbGMgdGhlIG5ldyBxdWVyeSB0aGF0IHdlIHdhbnRcbiAgdmFyIF9xcnkgPSBjbG9uZShxcnkxLCB0cnVlKTtcbiAgWydsaW1pdCcsICdza2lwJywgJ3NvcnQnXS5mb3JFYWNoKGZ1bmN0aW9uKHByb3ApIHtcbiAgICBpZiAocXJ5Mltwcm9wXSkge1xuICAgICAgX3FyeVtwcm9wXSA9IHFyeTJbcHJvcF07XG4gICAgfVxuICB9KTtcblxuICBpZiAoIWlzRW1wdHkocXJ5Mi5maW5kKSkge1xuICAgIC8vIFdhbnQgdG8gb3IgdG9nZXRoZXIgLSBidXQgaXMgdGhlIHRvcGxldmVsIGFscmVhZHkgYW4gb3I/IChhbmQgb25seSBhbiBvcilcbiAgICB2YXIgZXhpc3RpbmdPciA9IGZhbHNlO1xuICAgIGlmIChfcXJ5LmZpbmQuJG9yKSB7XG4gICAgICB2YXIgdmFsaWQgPSB0cnVlO1xuICAgICAgZm9yICh2YXIga2V5IGluIF9xcnkuZmluZCkge1xuICAgICAgICBpZiAoa2V5ICE9PSAnJG9yJykge1xuICAgICAgICAgIHZhbGlkID0gZmFsc2U7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGV4aXN0aW5nT3IgPSB2YWxpZDtcbiAgICB9XG5cbiAgICBpZiAoZXhpc3RpbmdPcikge1xuICAgICAgX3FyeS5maW5kID0gY2xvbmUoX3FyeS5maW5kKTtcbiAgICB9IGVsc2Uge1xuICAgICAgX3FyeS5maW5kID0geyRvcjogW19xcnkuZmluZF19O1xuICAgIH1cblxuICAgIF9xcnkuZmluZC4kb3IucHVzaChxcnkyLmZpbmQpO1xuICB9XG5cbiAgcmV0dXJuIF9xcnk7XG59XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCRyb290U2NvcGUsICRxLCAkdGltZW91dCwgJGluamVjdG9yLCBDaGFpbikge1xuICAnbmdJbmplY3QnO1xuXG4gIGZ1bmN0aW9uIFF1ZXJ5RmFjdG9yeSh1cmwsIHJvb3RLZXksIHJvb3RLZXlQbHVyYWwsIGRiKSB7XG4gICAgdmFyIHNvY2tldCA9ICRpbmplY3Rvci5nZXQoJ3NvY2tldCcpO1xuICAgIHZhciBzb2NrID0gc29ja2V0KHVybCwgcm9vdEtleSwgcm9vdEtleVBsdXJhbCk7XG5cbiAgICAvLyBPYmplY3QgaG9sZGluZyBxdWVyaWVzIChrZXlzIGFyZSB0aGUgcXVlcnkgaWRzLCB2YWx1ZXMgYXJlIGFycmF5cyBvZiBhcnJheXMpXG4gICAgdmFyIF9zZXJ2ZXJRdWVyaWVzID0ge307XG4gICAgdmFyIF9sb2NhbFF1ZXJpZXMgPSBbXTtcblxuICAgIC8vIElmIHRoZSBzb2NrZXQgcmVzZXRzIG9yIGNvbm5lY3RzIHRoZW4gcmVmZXRjaCBldmVyeXRoaW5nXG4gICAgc29jay5vbigncmVzZXQnLCBmdW5jdGlvbigpIHtcbiAgICAgIHJlZnJlc2hRdWVyaWVzKCk7XG4gICAgfSk7XG4gICAgc29jay5vbignY29ubmVjdGVkJywgZnVuY3Rpb24oKSB7XG4gICAgICByZWZyZXNoUXVlcmllcygpO1xuICAgIH0pO1xuXG4gICAgLy8gTGlzdGVuIGZvciBtb2RpZmllZCBxdWVyaWVzXG4gICAgc29jay5vbignbW9kaWZpZWQgcXVlcnknLCBmdW5jdGlvbihxcnlJZCwgZGF0YSkge1xuICAgICAgdmFyIHFyeXMgPSBfc2VydmVyUXVlcmllc1txcnlJZF07XG4gICAgICBpZiAocXJ5cykge1xuICAgICAgICBxcnlzLmZvckVhY2goZnVuY3Rpb24ocXJ5KSB7XG4gICAgICAgICAgcXJ5LiRuZXdEYXRhKHFyeUlkLCBkYXRhKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBmdW5jdGlvbiByZWZyZXNoUXVlcmllcygpIHtcbiAgICAgIHZhciByZXN1bHRzU2V0ID0gdW5pcShmbGF0dGVuKHZhbHVlcyhfc2VydmVyUXVlcmllcyksIHRydWUpKTtcbiAgICAgIHJlc3VsdHNTZXQuZm9yRWFjaChmdW5jdGlvbihyZXN1bHRzKSB7XG4gICAgICAgIHJlc3VsdHMuJHJlZnJlc2goKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIExvY2FsIFF1ZXJ5IExpc3RcbiAgICAgKiBAcGFyYW0ge1t0eXBlXX0gcXJ5ICAgICAgW2Rlc2NyaXB0aW9uXVxuICAgICAqIEBwYXJhbSB7W3R5cGVdfSBsaW1pdCAgICBbZGVzY3JpcHRpb25dXG4gICAgICogQHBhcmFtIHtbdHlwZV19IFJlc291cmNlIFtkZXNjcmlwdGlvbl1cbiAgICAgKiBAcGFyYW0ge1t0eXBlXX0gdG9SZXMgICAgW2Rlc2NyaXB0aW9uXVxuICAgICAqXG4gICAgICogU3RyYXRlZ3kgLSB3ZSBydW4gdGhlIHF1ZXJ5IG9uIHRoZSBzZXJ2ZXIuIEhvd2V2ZXIgaWYgd2UgY2FuIGRlYWwgd2l0aCBpdCBsb2NhbGx5ICh2aWFcbiAgICAgKiBuZWRiKSB0aGVuIGRvIHNvLiBJZiB0aGUgcXVlcnkgYXQgYW55IHRpbWUgYmVjb21lcyBtb3JlIGNvbXBsaWNhdGVkIHdlIGp1c3QgZmFsbCB0aHJvdWdoXG4gICAgICogdG8gdGhlIHNlcnZlciB2ZXJzaW9uXG4gICAgICovXG4gICAgZnVuY3Rpb24gTG9jYWxRdWVyeUxpc3QocXJ5LCBsaW1pdCwgUmVzb3VyY2UsIHRvUmVzKSB7XG4gICAgICAvLyBBbGxvdyBxcnkgdG8gYmUgYSBwcm9taXNlLCBhbmQgd2UgcmV0dXJuIHRoZSByYXcgKG5vbiBfcSBiaXQpXG4gICAgICBxcnkgPSAkcS53aGVuKHFyeSkudGhlbihub3JtYWxpemVRdWVyeSkudGhlbihmdW5jdGlvbihfcXJ5KSB7XG4gICAgICAgIGlmIChsaW1pdCkge1xuICAgICAgICAgIF9xcnkubGltaXQgPSBsaW1pdDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gX3FyeTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBHZW5lcmF0ZSB0aGUgU2VydmVyUXVlcnkuIFdlIGRvIHRoaXMgc28gd2UgaGF2ZSBzb21ldGhpbmcgdG8gZmFsbCBiYWNrIG9uXG4gICAgICAvLyBhbmQgYWxzbyBzbyB0aGF0IHdlIHdpbGwgKG9yIHNob3VsZCEpIGdldCBub3RpZmllZCBvZiBjaGFuZ2VzIGZyb20gdGhlIHNlcnZlciBpZlxuICAgICAgLy8gc29tZW9uZSBlbHNlIGNyZWF0ZXMgb3IgcmVtb3ZlcyBzb21ldGhpbmcgdGhhdCBzaG91bGQgZ28gaW4gdGhlc2UgcmVzdWx0c1xuICAgICAgdmFyIHNlcnZlclJlc3VsdHMgPSBTZXJ2ZXJRdWVyeUxpc3QocXJ5LCBsaW1pdCwgUmVzb3VyY2UpO1xuXG4gICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgICAgX2xvY2FsUXVlcmllcy5wdXNoKHJlc3VsdHMpO1xuICAgICAgdmFyIGN1cnJlbnRMaW1pdCA9IDA7XG4gICAgICB2YXIgY3VycmVudFNraXAgPSAwO1xuICAgICAgdmFyIGxhc3RCYXRjaFNpemUgPSAwO1xuICAgICAgdmFyIGZhbGxiYWNrID0gZmFsc2U7XG5cbiAgICAgIHJlc3VsdHMubG9hZGluZyA9IHRydWU7XG5cbiAgICAgIC8vIFdoZW4gdGhlIHNlcnZlciByZXN1bHRzIGFyZSB1cGRhdGVkIHdlIHdhbnQgdG8gY2hlY2sgcGFnaW5nIG9wdGlvbnMgYW5kIGFwcGx5XG4gICAgICAvLyB0aGVtIHRvIG91ciByZXN1bHRzXG4gICAgICBzZXJ2ZXJSZXN1bHRzLiRlbWl0dGVyLm9uKCd1cGRhdGUnLCBzeW5jRnJvbVNlcnZlcik7XG5cbiAgICAgIGZ1bmN0aW9uIHN5bmNGcm9tU2VydmVyKCkge1xuICAgICAgICByZXN1bHRzLmhhc05leHQgPSBzZXJ2ZXJSZXN1bHRzLmhhc05leHQ7XG4gICAgICAgIHJlc3VsdHMuaGFzUHJldiA9IHNlcnZlclJlc3VsdHMuaGFzUHJldjtcblxuICAgICAgICAvLyBJZiB3ZSBhcmUgZmFsbGluZyBiYWNrIHRoZW4gc2V0IHVwIGFuZCBjb3B5IG91ciB2YXJpb3VzIHByb3BlcnRpZXMgYWNyb3NzXG4gICAgICAgIGlmIChmYWxsYmFjaykge1xuICAgICAgICAgIHJlc3VsdHMuJGhhc05leHQgPSBmYWxzZTtcbiAgICAgICAgICByZXN1bHRzLiRoYXNQcmV2ID0gZmFsc2U7XG4gICAgICAgICAgcmVzdWx0cy5sZW5ndGggPSAwO1xuICAgICAgICAgIHNlcnZlclJlc3VsdHMuZm9yRWFjaChmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAgIHJlc3VsdHMucHVzaChyZXMpO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgY3VycmVudExpbWl0ID0gcmVzdWx0cy5sZW5ndGg7XG4gICAgICAgICAgY3VycmVudFNraXAgPSByZXN1bHRzLiRza2lwO1xuICAgICAgICAgIGxhc3RCYXRjaFNpemUgPSBsYXN0QmF0Y2hTaXplIHx8IHJlc3VsdHMubGVuZ3RoO1xuICAgICAgICB9XG4gICAgICB9XG5cblxuICAgICAgZnVuY3Rpb24gZ2V0KCkge1xuICAgICAgICByZXR1cm4gUmVzb3VyY2UuZ2V0LmFwcGx5KFJlc291cmNlLCBhcmd1bWVudHMpO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBjaGFpbihNb2RlbCwgcXJ5Rm4pIHtcbiAgICAgICAgcmV0dXJuIENoYWluKHJlc3VsdHMsIE1vZGVsLCBxcnlGbik7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHF1ZXJ5KF9xcnkpIHtcblxuICAgICAgICAvLyBTdG9yZSBvZmYgdGhlIHFyeSBtYWtpbmcgc3VyZSBpdHMgYSBwcm9taXNlXG4gICAgICAgIHFyeSA9ICRxLndoZW4oX3FyeSk7XG5cbiAgICAgICAgZmFsbGJhY2sgPSAhcXJ5SXNTaW1wbGUoX3FyeSk7XG5cbiAgICAgICAgLy8gSWYgd2UgYXJlIGZhbGxpbmdiYWNrIHRoZW4ganVzdCByZXNvbHZlIHdpdGggb3VyIHJlc3VsdHMuIFRoZSBzZXJ2ZXIgc2hvdWxkXG4gICAgICAgIC8vIGRvIHRoZSByZXN0LlxuICAgICAgICBpZiAoZmFsbGJhY2spIHtcbiAgICAgICAgICAvLyBXZSB3YW50IHRvIHJldHVybiB0aGUgc2VydmVyJ3MgcHJvbWlzZSBoZXJlIHNvIHRoYXQgcGVvcGxlIHdpbGwgYmUgbm90aWZpZWRcbiAgICAgICAgICAvLyB3aGVuIHRoZSByZXN1bHRzIGFyZSBhY3R1YWxseSBsb2FkZWRcbiAgICAgICAgICB2YXIgcHJvbTtcbiAgICAgICAgICBpZiAoIXNlcnZlclJlc3VsdHMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgICBwcm9tID0gc2VydmVyUmVzdWx0cy4kcHJvbWlzZS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwcm9tID0gJHEud2hlbihyZXN1bHRzKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gcHJvbTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgIHZhciBmaW5kID0gY3JlYXRlRGJGaW5kKF9xcnkuZmluZCk7XG4gICAgICAgIHZhciBsaW1pdCA9IF9xcnkubGltaXQ7XG4gICAgICAgIHZhciBza2lwID0gX3FyeS5za2lwO1xuICAgICAgICB2YXIgc29ydCA9IF9xcnkuc29ydDtcblxuICAgICAgICB2YXIgY3VyID0gZGIuZmluZChmaW5kKTtcblxuICAgICAgICBpZiAoc29ydCkge1xuICAgICAgICAgIGN1ciA9IGN1ci5zb3J0KHNvcnQpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChza2lwKSB7XG4gICAgICAgICAgY3VyID0gY3VyLnNraXAoc2tpcCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGxpbWl0KSB7XG4gICAgICAgICAgLy8gV2UgZ28gKyAxIHNvIHdlIGNhbiB0ZWxsIGlmIHRoZXJlIGFyZSBhbnkgbW9yZSByZXN1bHRzXG4gICAgICAgICAgY3VyID0gY3VyLmxpbWl0KGxpbWl0ICsgMSk7XG4gICAgICAgIH1cblxuICAgICAgICBjdXIuZXhlYyhmdW5jdGlvbihlcnIsIGRvY3MpIHtcbiAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KGVycik7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gV2UgY2FuIHNldCB0aGUgaGFzTmV4dCBhbmQgaGFzUHJldiB2YWx1ZXMgdG8gdHJ1ZSBoZXJlIGlmIHdlIGtub3cgdGhlcmVcbiAgICAgICAgICAgIC8vIGFyZSBzb21lLiBIb3dldmVyIG9ubHkgdGhlIHNlcnZlciBoYXMgdGhlIGRlZmluaXRpdmUgYWJpbGl0eSB0byBzYXlcbiAgICAgICAgICAgIC8vIHRoZXJlIGFyZW50IGFueVxuICAgICAgICAgICAgcmVzdWx0cy4kaGFzTmV4dCA9IGZhbHNlO1xuICAgICAgICAgICAgcmVzdWx0cy4kaGFzUHJldiA9IGZhbHNlO1xuICAgICAgICAgICAgaWYgKGxpbWl0ICYmIGRvY3MubGVuZ3RoID4gbGltaXQpIHtcbiAgICAgICAgICAgICAgLy8gV2UgaGF2ZSBtb3JlIHJlc3VsdHMgdG8gZmV0Y2hcbiAgICAgICAgICAgICAgcmVzdWx0cy5oYXNOZXh0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgcmVzdWx0cy4kaGFzTmV4dCA9IHRydWU7XG5cbiAgICAgICAgICAgICAgLy8gVHJpbSB0aGUgcmVzdWx0cyBkb3duIHRvIHNpemVcbiAgICAgICAgICAgICAgZG9jcy5sZW5ndGggLT0gMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHNraXApIHtcbiAgICAgICAgICAgICAgcmVzdWx0cy5oYXNQcmV2ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgcmVzdWx0cy4kaGFzUHJldiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIENhbGN1bGF0ZSBwYWdpbmcgb3B0aW9uc1xuICAgICAgICAgICAgY3VycmVudExpbWl0ID0gZG9jcy5sZW5ndGg7XG4gICAgICAgICAgICBjdXJyZW50U2tpcCA9IHNraXAgfHwgMDtcbiAgICAgICAgICAgIGxhc3RCYXRjaFNpemUgPSBsYXN0QmF0Y2hTaXplIHx8IGRvY3MubGVuZ3RoO1xuXG4gICAgICAgICAgICAvLyBHbyB0byByZXNvdXJjZSB0eXBlc1xuICAgICAgICAgICAgdmFyIHRtcFJlc3VsdHMgPSBkb2NzLm1hcCh0b1Jlcyk7XG5cbiAgICAgICAgICAgIC8vIERvIHdlIG5lZWQgdG8gZG8gYSB0cmFuc2Zvcm0/XG4gICAgICAgICAgICB2YXIgcnByb207XG4gICAgICAgICAgICBpZiAoYW5ndWxhci5pc0Z1bmN0aW9uKHJlc3VsdHMudHJhbnNmb3JtKSkge1xuICAgICAgICAgICAgICBycHJvbSA9ICRxLndoZW4ocmVzdWx0cy50cmFuc2Zvcm0odG1wUmVzdWx0cykpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcnByb20gPSAkcS53aGVuKHRtcFJlc3VsdHMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcnByb20udGhlbihmdW5jdGlvbih0cmFuc2Zvcm1lZCkge1xuICAgICAgICAgICAgICAvLyBQdXQgdGhlIHJlc291cmNlcyBpbnRvIHRoZSBsaXN0XG4gICAgICAgICAgICAgIHJlc3VsdHMubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgdHJhbnNmb3JtZWQuZm9yRWFjaChmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAgICAgICByZXN1bHRzLnB1c2gocmVzKTtcbiAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgcmVzdWx0cy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCByZXN1bHRzKTtcblxuICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHJlc3VsdHMpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiByZWZyZXNoUXVlcnkoZm9yY2VTZXJ2ZXIpIHtcbiAgICAgICAgLy8gUGVyZm9ybSBvdXIgcXVlcnlcbiAgICAgICAgdmFyIHByb20gPSBxcnkudGhlbihxdWVyeSkudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAvLyBJZiB3ZSBkb24ndCBoYXZlIGFueSByZXN1bHRzIHRoZW4gbWF5YmUgd2FpdCBmb3IgdGhlIHNlcnZlciB0byByZXR1cm5cbiAgICAgICAgICBpZiAoKHJlcy5sZW5ndGggPT09IDAgJiYgIXNlcnZlclJlc3VsdHMuJHJlc29sdmVkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHNlcnZlclJlc3VsdHMuJHByb21pc2UudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlZnJlc2hRdWVyeSgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoZm9yY2VTZXJ2ZXIpIHtcbiAgICAgICAgICBwcm9tID0gc2VydmVyUmVzdWx0cy4kcmVmcmVzaCh0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwcm9tLnRoZW4oZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgcmVzdWx0cy5sb2FkaW5nID0gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGV4dGVuZFJlc3VsdHMob2JqLCBub1Nhbml0aXplLCByZXRTZXJ2ZXIpIHtcblxuICAgICAgICAvLyBTYW5pdGl6ZSB0aGUgb2JqZWN0XG4gICAgICAgIGlmICghbm9TYW5pdGl6ZSkge1xuICAgICAgICAgIGlmIChvYmouX3EpIHtcbiAgICAgICAgICAgIG9iaiA9IG9iai5fcTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb2JqID0ge2ZpbmQ6IG9ian07XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHFyeS50aGVuKGZ1bmN0aW9uKHJlc29sdmVkKSB7XG4gICAgICAgICAgdmFyIF9xcnkgPSBleHRlbmRRdWVyeShyZXNvbHZlZCwgb2JqKTtcbiAgICAgICAgICByZXR1cm4gcmVwbGFjZShfcXJ5LCByZXRTZXJ2ZXIpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcmVwbGFjZShfcXJ5LCByZXRTZXJ2ZXIpIHtcbiAgICAgICAgLy8gU3luYyBkb3duIHRvIHRoZSBzZXJ2ZXJxdWVyeVxuICAgICAgICB2YXIgc2VydmVyUHJvbSA9IHNlcnZlclJlc3VsdHMucmVwbGFjZShfcXJ5KTtcblxuICAgICAgICAvLyBEbyB0aGUgcXVlcnkgYnV0IHJlcGxhY2UgdGhlIGV4aXN0aW5nIHF1ZXJ5XG4gICAgICAgIHZhciBsb2NhbFByb20gPSAkcS53aGVuKF9xcnkpLnRoZW4obm9ybWFsaXplUXVlcnkpLnRoZW4oZnVuY3Rpb24obm9ybVFyeSkge1xuXG4gICAgICAgICAgLy8gV2UgYWxsb3cgYSBxdWVyeSB0byByZXNvbHZlIHRvIHNvbWV0aGluZyBmYWxzeSAtIGluIHdoaWNoIGNhc2Ugd2UganVzdFxuICAgICAgICAgIC8vIGRyb3AgaXRcbiAgICAgICAgICBpZiAoIW5vcm1RcnkpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gcXJ5LnRoZW4oZnVuY3Rpb24ob2xkcXJ5KSB7XG4gICAgICAgICAgICBpZiAoSlNPTi5zdHJpbmdpZnkob2xkcXJ5KSAhPT0gSlNPTi5zdHJpbmdpZnkobm9ybVFyeSkpIHtcbiAgICAgICAgICAgICAgLy8gcXVlcnkgaXMgZGlmZmVyZW50IC0gY29udGludWVcblxuICAgICAgICAgICAgICByZXR1cm4gcXVlcnkobm9ybVFyeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiByZXRTZXJ2ZXIgPyBzZXJ2ZXJQcm9tIDogbG9jYWxQcm9tO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBuZXh0KG51bSkge1xuICAgICAgICB2YXIgcHJvbWlzZTtcbiAgICAgICAgdmFyIGV4dGVuZFNpemU7XG4gICAgICAgIGlmIChyZXN1bHRzLmhhc05leHQpIHtcbiAgICAgICAgICBsYXN0QmF0Y2hTaXplID0gZXh0ZW5kU2l6ZSA9IG51bSB8fCBsYXN0QmF0Y2hTaXplO1xuICAgICAgICAgIHZhciBleHRlbmRPYmogPSB7XG4gICAgICAgICAgICBsaW1pdDogY3VycmVudExpbWl0ICsgZXh0ZW5kU2l6ZVxuICAgICAgICAgIH07XG4gICAgICAgICAgcHJvbWlzZSA9IGV4dGVuZFJlc3VsdHMoZXh0ZW5kT2JqLCB0cnVlLCAhcmVzdWx0cy4kaGFzTmV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgcHJvbWlzZSA9IGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcHJldihudW0pIHtcbiAgICAgICAgdmFyIHByb21pc2U7XG4gICAgICAgIHZhciBleHRlbmRTaXplO1xuICAgICAgICBpZiAocmVzdWx0cy5oYXNQcmV2KSB7XG4gICAgICAgICAgbGFzdEJhdGNoU2l6ZSA9IGV4dGVuZFNpemUgPSBudW0gfHwgbGFzdEJhdGNoU2l6ZTtcbiAgICAgICAgICB2YXIgZXh0ZW5kT2JqID0ge1xuICAgICAgICAgICAgc2tpcDogTWF0aC5tYXgoY3VycmVudFNraXAgLSBleHRlbmRTaXplLCAwKSxcbiAgICAgICAgICAgIGxpbWl0OiBjdXJyZW50TGltaXQgKyBleHRlbmRTaXplXG4gICAgICAgICAgfTtcbiAgICAgICAgICBwcm9taXNlID0gZXh0ZW5kUmVzdWx0cyhleHRlbmRPYmosIHRydWUsICFyZXN1bHRzLiRoYXNQcmV2KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoKTtcbiAgICAgICAgICBwcm9taXNlID0gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwcm9taXNlO1xuICAgICAgfVxuXG4gICAgICAvLyBFdmVudCBlbWl0dGVyICdpbmhlcml0YW5jZSdcbiAgICAgIHZhciBlbWl0dGVyID0gbmV3IGV2ZW50cy5FdmVudEVtaXR0ZXIoKTtcbiAgICAgIHZhciBlZXByb3BzID0gW1xuICAgICAgICAnYWRkTGlzdGVuZXInLFxuICAgICAgICAnb24nLFxuICAgICAgICAnb25jZScsXG4gICAgICAgICdyZW1vdmVMaXN0ZW5lcidcbiAgICAgIF07XG4gICAgICBlZXByb3BzLmZvckVhY2goZnVuY3Rpb24ocHJvcCkge1xuICAgICAgICByZXN1bHRzW3Byb3BdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgcmV0dXJuIGVtaXR0ZXJbcHJvcF0uYXBwbHkoZW1pdHRlciwgYXJndW1lbnRzKTtcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuXG4gICAgICByZXN1bHRzLiRyZWZyZXNoID0gcmVmcmVzaFF1ZXJ5O1xuICAgICAgcmVzdWx0cy5leHRlbmQgPSBleHRlbmRSZXN1bHRzO1xuICAgICAgcmVzdWx0cy5yZXBsYWNlID0gcmVwbGFjZTtcbiAgICAgIHJlc3VsdHMuZ2V0ID0gZ2V0O1xuICAgICAgcmVzdWx0cy5uZXh0ID0gbmV4dDtcbiAgICAgIHJlc3VsdHMucHJldiA9IHByZXY7XG4gICAgICByZXN1bHRzLiRwcm9taXNlID0gcmVmcmVzaFF1ZXJ5KCk7XG4gICAgICByZXN1bHRzLmNoYWluID0gY2hhaW47XG4gICAgICByZXN1bHRzLiRNb2RlbCA9IFJlc291cmNlO1xuICAgICAgcmVzdWx0cy4kZW1pdHRlciA9IGVtaXR0ZXI7XG4gICAgICByZXN1bHRzLiRzZXJ2ZXJSZXN1bHRzID0gc2VydmVyUmVzdWx0cztcbiAgICAgIHF1ZXJ5VHJhbnNmb3Jtcy5hcHBseShyZXN1bHRzKTtcblxuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuXG4gICAgdmFyIHJlZnJlc2hUaW1lcjtcbiAgICBMb2NhbFF1ZXJ5TGlzdC5yZWZyZXNoID0gZnVuY3Rpb24gcmVmcmVzaCgpIHtcblxuICAgICAgLy8gSWYgd2UgaGF2ZSBhIHRpbWVyIG91dHN0YW5kaW5nIHRoZW4ganVzdCByZXR1cm4gLSBhIHJlZnJlc2ggd2lsbCBoYXBwZW4gc29vbi5cbiAgICAgIGlmICghcmVmcmVzaFRpbWVyKSB7XG4gICAgICAgIHJlZnJlc2hUaW1lciA9ICR0aW1lb3V0KGRvUmVmcmVzaCwgMTAwKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlZnJlc2hUaW1lcjtcblxuICAgICAgZnVuY3Rpb24gZG9SZWZyZXNoKCkge1xuICAgICAgICBfbG9jYWxRdWVyaWVzLmZvckVhY2goZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgcmVzLiRyZWZyZXNoKCk7XG4gICAgICAgIH0pO1xuICAgICAgICByZWZyZXNoVGltZXIgPSBudWxsO1xuICAgICAgfVxuICAgIH07XG5cbiAgICAvKipcbiAgICAgKiBTZXJ2ZXIgcXVlcnkgbGlzdC4gVGhlIHNlcnZlciBtYWtlcyBzdXJlIHdlIGtlZXAgaW4gc3luY1xuICAgICAqIEBwYXJhbSB7W3R5cGVdfSBxcnkgICAgICBbZGVzY3JpcHRpb25dXG4gICAgICogQHBhcmFtIHtbdHlwZV19IGxpbWl0ICAgIFtkZXNjcmlwdGlvbl1cbiAgICAgKiBAcGFyYW0ge1t0eXBlXX0gUmVzb3VyY2UgW2Rlc2NyaXB0aW9uXVxuICAgICAqL1xuICAgIGZ1bmN0aW9uIFNlcnZlclF1ZXJ5TGlzdChxcnksIGxpbWl0LCBSZXNvdXJjZSkge1xuICAgICAgLy8gQWxsb3cgcXJ5IHRvIGJlIGEgcHJvbWlzZVxuICAgICAgcXJ5ID0gJHEud2hlbihxcnkpLnRoZW4obm9ybWFsaXplUXVlcnkpLnRoZW4oZnVuY3Rpb24oX3FyeSkge1xuICAgICAgICBpZiAobGltaXQpIHtcbiAgICAgICAgICBfcXJ5LmxpbWl0ID0gbGltaXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIF9xcnk7XG4gICAgICB9KTtcblxuICAgICAgdmFyIGVtaXRQcm9taXNlID0gbnVsbDtcbiAgICAgIHZhciByZXN1bHRzID0gW107XG4gICAgICB2YXIgY3VycmVudExpbWl0ID0gMDtcbiAgICAgIHZhciBjdXJyZW50U2tpcCA9IDA7XG4gICAgICB2YXIgbGFzdEJhdGNoU2l6ZSA9IDA7XG4gICAgICB2YXIgcXJ5SWQgPSBudWxsO1xuICAgICAgdmFyIF9wYWdpbmdPcHRzID0ge307XG5cbiAgICAgIHJlc3VsdHMubG9hZGluZyA9IHRydWU7XG5cblxuICAgICAgZnVuY3Rpb24gcXVlcnkoZGF0YSwgcmVwbGFjZXMpIHtcbiAgICAgICAgLy8gV2Ugb25seSB3YW50IHRvIGRvIG9uZSBlbWl0IGF0IGEgdGltZSAob3RoZXJ3aXNlIHdlIGNvdWxkIGdldCBpbnRvIGEgYmFkIHN0YXRlKVxuICAgICAgICBpZiAoYW5ndWxhci5pc0Z1bmN0aW9uKGRhdGEpKSB7XG4gICAgICAgICAgZGF0YSA9IGRhdGEoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFN0b3JlIG9mZiB0aGUgcXVlcnkgLSBtYWtlIHN1cmUgaXRzIGEgcHJvbWlzZVxuICAgICAgICBxcnkgPSAkcS53aGVuKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiBxcnkudGhlbihmdW5jdGlvbihkYXRhKSB7XG4gICAgICAgICAgLy8gSWYgd2UgaGF2ZSBhbiBleGlzdGluZyBlbWl0UHJvbWlzZSB0aGVuIHdhaXQgZm9yIGl0IHRvIHJlc29sdmUgYmVmb3JlIHdlIHJ1blxuICAgICAgICAgIHZhciBwcm9taXNlO1xuICAgICAgICAgIGlmIChlbWl0UHJvbWlzZSkge1xuICAgICAgICAgICAgcHJvbWlzZSA9IGVtaXRQcm9taXNlLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgIHJldHVybiBzb2NrLnF1ZXJ5KGRhdGEsIHJlcGxhY2VzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBlbWl0UHJvbWlzZSA9IHByb21pc2UgPSBzb2NrLnF1ZXJ5KGRhdGEsIHJlcGxhY2VzKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIG5ld0RhdGEoX3FyeUlkLCByZXNwb25zZSwgZm9yY2UpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgIHZhciBpZHMgPSByZXNwb25zZS5pZHM7XG4gICAgICAgIHZhciBwYWdpbmdPcHRzID0gcmVzcG9uc2UucGFnaW5nT3B0cztcblxuICAgICAgICBtYXliZU5ld1FyeUlkKF9xcnlJZCk7XG5cbiAgICAgICAgLy8gU28gZmFyIHdlJ3ZlIG9ubHkgZ290IHRoZSBpZHMgb2YgdGhlIHFyeSByZXN1bHQgLSBnbyBhbmQgZmV0Y2ggdGhlIGFjdHVhbCBvYmplY3RzLlxuICAgICAgICAvLyBUaGlzIG1lY2hhbmlzbSBzYXZlcyBiYW5kd2lkdGggYnkgb25seSBnZXR0aW5nIHRoZSBvYmplY3QgZGF0YSBvbmNlIHRoZW4gbGlzdGVuaW5nXG4gICAgICAgIC8vIGZvciBjaGFuZ2VzIHRvIGl0XG4gICAgICAgIC8vXG4gICAgICAgIC8vIElmIHdlIGFyZSBmb3JjaW5nIHdlIHdhbnQgdG8gZ2V0IGJvdGggdGhlIG9sZCBhbmQgbmV3IGlkcyB0byBjaGVjayBmb3IgYW55IGNoYW5nZXNcbiAgICAgICAgLy8gZGVsZXRpb25zIGV0Yy4uXG4gICAgICAgIHZhciBnZXRJZHMgPSBpZHM7XG4gICAgICAgIGlmIChmb3JjZSkge1xuICAgICAgICAgIHZhciBvbGRJZHMgPSBwbHVjayhyZXN1bHRzLCAnX2lkJyk7XG4gICAgICAgICAgZ2V0SWRzID0gdW5pb24oaWRzLCBvbGRJZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgUmVzb3VyY2UuZ2V0KGdldElkcywgZm9yY2UpLiRwcm9taXNlLnRoZW4oZnVuY3Rpb24ocmVzcykge1xuICAgICAgICAgIHZhciByZXNzbWFwID0ge307XG4gICAgICAgICAgcmVzcy5mb3JFYWNoKGZ1bmN0aW9uKHJlcykge1xuICAgICAgICAgICAgcmVzc21hcFtyZXMuX2lkXSA9IHJlcztcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIC8vIFdlIGRvbid0IGFsbG93IHJlcGVhdGVkIGlkcyBzbyBqdXN0IGl0ZXJhdGUgb3ZlciB0aGUgcmVzdWx0c1xuICAgICAgICAgIHZhciB0bXBSZXN1bHRzID0gW107XG4gICAgICAgICAgaWRzLmZvckVhY2goZnVuY3Rpb24oaWQpIHtcbiAgICAgICAgICAgIHRtcFJlc3VsdHMucHVzaChyZXNzbWFwW2lkXSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICAvLyBEbyB3ZSBuZWVkIHRvIGRvIGEgdHJhbnNmb3JtP1xuICAgICAgICAgIHZhciBycHJvbTtcbiAgICAgICAgICBpZiAoYW5ndWxhci5pc0Z1bmN0aW9uKHJlc3VsdHMudHJhbnNmb3JtKSkge1xuICAgICAgICAgICAgcnByb20gPSAkcS53aGVuKHJlc3VsdHMudHJhbnNmb3JtKHRtcFJlc3VsdHMpKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcnByb20gPSAkcS53aGVuKHRtcFJlc3VsdHMpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBycHJvbS50aGVuKGZ1bmN0aW9uKHRyYW5zZm9ybWVkKSB7XG5cbiAgICAgICAgICAgIHJlc3VsdHMubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIHRyYW5zZm9ybWVkLmZvckVhY2goZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgICAgIHJlc3VsdHMucHVzaChyZXMpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIFNpbmNlIHdlIG5vdyBoYXZlIGRhdGEgaW4gb3VyIGFycmF5IHN0b3JlIG9mZiBsaW1pdCBkYXRhXG4gICAgICAgICAgICBjdXJyZW50TGltaXQgPSB0bXBSZXN1bHRzLmxlbmd0aDtcbiAgICAgICAgICAgIHJlc3VsdHMuJHNraXAgPSBjdXJyZW50U2tpcCA9IChxcnkgJiYgcXJ5LnNraXApID8gcXJ5LnNraXAgOiAwO1xuICAgICAgICAgICAgbGFzdEJhdGNoU2l6ZSA9IGxhc3RCYXRjaFNpemUgfHwgdG1wUmVzdWx0cy5sZW5ndGg7XG4gICAgICAgICAgICBfcGFnaW5nT3B0cyA9IHBhZ2luZ09wdHM7XG4gICAgICAgICAgICByZXN1bHRzLmhhc05leHQgPSAocGFnaW5nT3B0cy5uZXh0ICE9IG51bGwpO1xuICAgICAgICAgICAgcmVzdWx0cy5oYXNQcmV2ID0gKHBhZ2luZ09wdHMucHJldiAhPSBudWxsKTtcblxuICAgICAgICAgICAgLy8gRGF0YSBoYXMgY29tZSBiYWNrXG4gICAgICAgICAgICByZXN1bHRzLmxvYWRpbmcgPSBmYWxzZTtcblxuICAgICAgICAgICAgcmVzdWx0cy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCByZXN1bHRzKTtcblxuICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXN1bHRzKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIG1heWJlTmV3UXJ5SWQoX3FyeUlkKSB7XG4gICAgICAgIGlmIChxcnlJZCAhPT0gX3FyeUlkKSB7XG5cbiAgICAgICAgICB2YXIgcXJ5TGlzdDtcbiAgICAgICAgICBpZiAocXJ5SWQpIHtcbiAgICAgICAgICAgIC8vIFVwZGF0ZSB0aGUgcXJ5bGlzdCAoZG8gd2Ugd2FudCB0byBkZWxldGUgdGhlIG9sZCBvbmU/KVxuICAgICAgICAgICAgcXJ5TGlzdCA9IF9zZXJ2ZXJRdWVyaWVzW3FyeUlkXSA9IHdpdGhvdXQoX3NlcnZlclF1ZXJpZXNbcXJ5SWRdLCByZXN1bHRzKTtcbiAgICAgICAgICAgIC8vIElmIHRoZXJlIGFyZSBubyBtZW1iZXJzIGxlZnQgaW4gdGhlIHF1ZXJ5IGxpc3QgdGhlbiBkZWxldGUgaXRcbiAgICAgICAgICAgIGlmIChxcnlMaXN0Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICBkZWxldGUgX3NlcnZlclF1ZXJpZXNbcXJ5SWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIE1vdmUgdGhlIHJlc3VsdHMgdG8gdGhlIG5ldyBsaXN0XG4gICAgICAgICAgcXJ5SWQgPSBfcXJ5SWQ7XG4gICAgICAgICAgcXJ5TGlzdCA9IF9zZXJ2ZXJRdWVyaWVzW3FyeUlkXTtcbiAgICAgICAgICBpZiAoIXFyeUxpc3QpIHtcbiAgICAgICAgICAgIHFyeUxpc3QgPSBfc2VydmVyUXVlcmllc1txcnlJZF0gPSBbXTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBQdXQgdGhlIHJlc3VsdHMgaW50byB0aGUgbmV3IHF1ZXJ5IGxpc3RcbiAgICAgICAgICBpZiAoIX5xcnlMaXN0LmluZGV4T2YocmVzdWx0cykpIHtcbiAgICAgICAgICAgIHFyeUxpc3QucHVzaChyZXN1bHRzKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcmVmcmVzaFF1ZXJ5KGZvcmNlKSB7XG4gICAgICAgIHZhciByZXEgPSBxdWVyeShxcnkpO1xuICAgICAgICB2YXIgcHJvbWlzZSA9IHJlcS50aGVuKGZ1bmN0aW9uKHJlcykge1xuXG4gICAgICAgICAgLy8gSWYgd2UgZ2V0IG5vIHJlc3BvbnNlICh0aGUgYXBwIGNvdWxkIGJlIG9mZmxpbmUpIHRoZW4ganVzdCByZXNvbHZlIHdpdGhcbiAgICAgICAgICAvLyB0aGUgZXhpc3RpbmcgcmVzdWx0c1xuICAgICAgICAgIGlmIChhbmd1bGFyLmlzVW5kZWZpbmVkKHJlcykpIHtcbiAgICAgICAgICAgIHJlc3VsdHMubG9hZGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdmFyIF9xcnlJZCA9IHJlcy5xcnlJZDtcbiAgICAgICAgICB2YXIgcmVzcG9uc2UgPSByZXMuZGF0YTtcblxuICAgICAgICAgIHJldHVybiBuZXdEYXRhKF9xcnlJZCwgcmVzcG9uc2UsIGZvcmNlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBwcm9taXNlO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiByZXBsYWNlKF9xcnkpIHtcbiAgICAgICAgLy8gRG8gdGhlIHF1ZXJ5IGJ1dCByZXBsYWNlIHRoZSBleGlzdGluZyBxdWVyeVxuICAgICAgICByZXR1cm4gJHEud2hlbihfcXJ5KS50aGVuKG5vcm1hbGl6ZVF1ZXJ5KS50aGVuKGZ1bmN0aW9uKG5vcm1RcnkpIHtcblxuICAgICAgICAgIC8vIFdlIGFsbG93IGEgcXVlcnkgdG8gcmVzb2x2ZSB0byBzb21ldGhpbmcgZmFsc3kgLSBpbiB3aGljaCBjYXNlIHdlIGp1c3RcbiAgICAgICAgICAvLyBkcm9wIGl0XG4gICAgICAgICAgaWYgKCFub3JtUXJ5KSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHFyeS50aGVuKGZ1bmN0aW9uKG9sZHFyeSkge1xuICAgICAgICAgICAgaWYgKEpTT04uc3RyaW5naWZ5KG9sZHFyeSkgIT09IEpTT04uc3RyaW5naWZ5KG5vcm1RcnkpKSB7XG4gICAgICAgICAgICAgIC8vIHF1ZXJ5IGlzIGRpZmZlcmVudCAtIGNvbnRpbnVlXG4gICAgICAgICAgICAgIHZhciByZXEgPSBxdWVyeShub3JtUXJ5LCBxcnlJZCk7XG5cbiAgICAgICAgICAgICAgdmFyIHByb21pc2UgPSByZXEudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAgICAgICAvLyBJZiB3ZSBnZXQgbm8gcmVzcG9uc2UgKHRoZSBhcHAgY291bGQgYmUgb2ZmbGluZSkgdGhlbiBqdXN0IHJlc29sdmUgd2l0aFxuICAgICAgICAgICAgICAgIC8vIHRoZSBleGlzdGluZyByZXN1bHRzXG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNVbmRlZmluZWQocmVzKSkge1xuICAgICAgICAgICAgICAgICAgcmVzdWx0cy5sb2FkaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvLyBXZSBkbyBoYXZlIGEgcmVzcG9uc2UuIENvbnRpbnVlXG4gICAgICAgICAgICAgICAgdmFyIF9xcnlJZCA9IHJlcy5xcnlJZDtcbiAgICAgICAgICAgICAgICB2YXIgZGF0YSA9IHJlcy5kYXRhO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ld0RhdGEoX3FyeUlkLCBkYXRhKTtcbiAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGV4dGVuZFJlc3VsdHMob2JqLCBub1Nhbml0aXplKSB7XG5cbiAgICAgICAgLy8gU2FuaXRpemUgdGhlIG9iamVjdFxuICAgICAgICBpZiAoIW5vU2FuaXRpemUpIHtcbiAgICAgICAgICBpZiAob2JqLl9xKSB7XG4gICAgICAgICAgICBvYmogPSBvYmouX3E7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9iaiA9IHtmaW5kOiBvYmp9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBxcnkudGhlbihmdW5jdGlvbihyZXNvbHZlZCkge1xuICAgICAgICAgIHZhciBfcXJ5ID0gZXh0ZW5kUXVlcnkocmVzb2x2ZWQsIG9iaik7XG4gICAgICAgICAgcmV0dXJuIHJlcGxhY2UoX3FyeSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBuZXh0KG51bSkge1xuICAgICAgICB2YXIgcHJvbWlzZTtcbiAgICAgICAgdmFyIGV4dGVuZFNpemU7XG4gICAgICAgIGlmIChfcGFnaW5nT3B0cy5uZXh0KSB7XG4gICAgICAgICAgbGFzdEJhdGNoU2l6ZSA9IGV4dGVuZFNpemUgPSBudW0gfHwgbGFzdEJhdGNoU2l6ZTtcbiAgICAgICAgICB2YXIgZXh0ZW5kT2JqID0ge1xuICAgICAgICAgICAgbGltaXQ6IGN1cnJlbnRMaW1pdCArIGV4dGVuZFNpemVcbiAgICAgICAgICB9O1xuICAgICAgICAgIHByb21pc2UgPSBleHRlbmRSZXN1bHRzKGV4dGVuZE9iaiwgdHJ1ZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgcHJvbWlzZSA9IGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcHJldihudW0pIHtcbiAgICAgICAgdmFyIHByb21pc2U7XG4gICAgICAgIHZhciBleHRlbmRTaXplO1xuICAgICAgICBpZiAoX3BhZ2luZ09wdHMucHJldikge1xuICAgICAgICAgIGxhc3RCYXRjaFNpemUgPSBleHRlbmRTaXplID0gbnVtIHx8IGxhc3RCYXRjaFNpemU7XG4gICAgICAgICAgdmFyIGV4dGVuZE9iaiA9IHtcbiAgICAgICAgICAgIHNraXA6IE1hdGgubWF4KGN1cnJlbnRTa2lwIC0gZXh0ZW5kU2l6ZSwgMCksXG4gICAgICAgICAgICBsaW1pdDogY3VycmVudExpbWl0ICsgZXh0ZW5kU2l6ZVxuICAgICAgICAgIH07XG4gICAgICAgICAgcHJvbWlzZSA9IGV4dGVuZFJlc3VsdHMoZXh0ZW5kT2JqLCB0cnVlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoKTtcbiAgICAgICAgICBwcm9taXNlID0gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBwcm9taXNlO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBnZXQoKSB7XG4gICAgICAgIHJldHVybiBSZXNvdXJjZS5nZXQuYXBwbHkoUmVzb3VyY2UsIGFyZ3VtZW50cyk7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGNoYWluKE1vZGVsLCBxcnlGbikge1xuICAgICAgICByZXR1cm4gQ2hhaW4ocmVzdWx0cywgTW9kZWwsIHFyeUZuKTtcbiAgICAgIH1cblxuICAgICAgcmVzdWx0cy4kbmV3RGF0YSA9IG5ld0RhdGE7XG4gICAgICByZXN1bHRzLiRyZWZyZXNoID0gcmVmcmVzaFF1ZXJ5O1xuICAgICAgcmVzdWx0cy5leHRlbmQgPSBleHRlbmRSZXN1bHRzO1xuICAgICAgcmVzdWx0cy5yZXBsYWNlID0gcmVwbGFjZTtcbiAgICAgIHJlc3VsdHMuZ2V0ID0gZ2V0O1xuICAgICAgcmVzdWx0cy5uZXh0ID0gbmV4dDtcbiAgICAgIHJlc3VsdHMucHJldiA9IHByZXY7XG4gICAgICByZXN1bHRzLiRwcm9taXNlID0gcmVmcmVzaFF1ZXJ5KCkudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgcmVzdWx0cy4kcmVzb2x2ZWQgPSB0cnVlO1xuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfSk7XG4gICAgICByZXN1bHRzLiRyZXNvbHZlZCA9IGZhbHNlO1xuICAgICAgcmVzdWx0cy5jaGFpbiA9IGNoYWluO1xuICAgICAgcmVzdWx0cy4kTW9kZWwgPSBSZXNvdXJjZTtcbiAgICAgIHJlc3VsdHMuJGVtaXR0ZXIgPSBuZXcgZXZlbnRzLkV2ZW50RW1pdHRlcigpO1xuICAgICAgcmVzdWx0cy4kc2tpcCA9IDA7XG5cbiAgICAgIHF1ZXJ5VHJhbnNmb3Jtcy5hcHBseShyZXN1bHRzKTtcblxuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRiID8gTG9jYWxRdWVyeUxpc3QgOiBTZXJ2ZXJRdWVyeUxpc3Q7XG4gIH1cblxuICByZXR1cm4gUXVlcnlGYWN0b3J5O1xufVxuIl0sInNvdXJjZVJvb3QiOiIvc291cmNlLyJ9
