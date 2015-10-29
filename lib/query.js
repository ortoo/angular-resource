'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

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

var queryTransforms = _interopRequireWildcard(_queryTransforms);

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
      queryTransforms.apply(results);

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

      queryTransforms.apply(results);

      return results;
    }

    return db ? LocalQueryList : ServerQueryList;
  }

  return QueryFactory;
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,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UyxHQUFHLEVBQUU7QUFDbkQsZUFBTyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUM7QUFDekIsZUFBTyxHQUFHLENBQUM7T0FDWixDQUFDLENBQUM7QUFDSCxhQUFPLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQztBQUMxQixhQUFPLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztBQUN0QixhQUFPLENBQUMsTUFBTSxHQUFHLFFBQVEsQ0FBQztBQUMxQixhQUFPLENBQUMsUUFBUSxHQUFHLElBQUksb0JBQU8sWUFBWSxFQUFFLENBQUM7QUFDN0MsYUFBTyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUM7O0FBRWxCLHFCQUFlLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDOztBQUUvQixhQUFPLE9BQU8sQ0FBQztLQUNoQjs7QUFFRCxXQUFPLEVBQUUsR0FBRyxjQUFjLEdBQUcsZUFBZSxDQUFDO0dBQzlDOztBQUVELFNBQU8sWUFBWSxDQUFDO0NBQ3JCIiwiZmlsZSI6InF1ZXJ5LmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGV2ZW50cyBmcm9tICdldmVudHMnO1xuaW1wb3J0IGNsb25lIGZyb20gJ2xvZGFzaC5jbG9uZSc7XG5pbXBvcnQgaXNFbXB0eSBmcm9tICdsb2Rhc2guaXNlbXB0eSc7XG5pbXBvcnQgdmFsdWVzIGZyb20gJ2xvZGFzaC52YWx1ZXMnO1xuaW1wb3J0IGZsYXR0ZW4gZnJvbSAnbG9kYXNoLmZsYXR0ZW4nO1xuaW1wb3J0IHVuaXEgZnJvbSAnbG9kYXNoLnVuaXEnO1xuaW1wb3J0IHBsdWNrIGZyb20gJ2xvZGFzaC5wbHVjayc7XG5pbXBvcnQgdW5pb24gZnJvbSAnbG9kYXNoLnVuaW9uJztcbmltcG9ydCB3aXRob3V0IGZyb20gJ2xvZGFzaC53aXRob3V0JztcbmltcG9ydCBhbmd1bGFyIGZyb20gJ2FuZ3VsYXInO1xuXG5pbXBvcnQgKiBhcyBxdWVyeVRyYW5zZm9ybXMgZnJvbSAnLi9xdWVyeS10cmFuc2Zvcm1zJztcblxuLy8gVGhlc2UgYXJlIHRoZSBvcGVyYXRvcnMgbmVkYiBzdXBwb3J0c1xudmFyIHNpbXBsZU9wZXJhdG9ycyA9IHtcbiAgJyRsdCc6IHRydWUsXG4gICckbHRlJzogdHJ1ZSxcbiAgJyRndCc6IHRydWUsXG4gICckZ3RlJzogdHJ1ZSxcbiAgJyRpbic6IHRydWUsXG4gICckbmluJzogdHJ1ZSxcbiAgJyRuZSc6IHRydWUsXG4gICckZXhpc3RzJzogdHJ1ZSxcbiAgJyRyZWdleCc6IHRydWUsXG4gICckc2l6ZSc6IHRydWUsXG4gICckb3InOiB0cnVlLFxuICAnJGFuZCc6IHRydWUsXG4gICckbm90JzogdHJ1ZVxufTtcblxuZnVuY3Rpb24gbm9ybWFsaXplUXVlcnkocXJ5KSB7XG4gIGlmICghcXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHFyeS5fcSkge1xuICAgIHJldHVybiBxcnkuX3E7XG4gIH0gZWxzZSBpZiAocXJ5LmZpbmQpIHtcbiAgICByZXR1cm4gcXJ5O1xuICB9IGVsc2Uge1xuICAgIHJldHVybiB7ZmluZDogcXJ5fTtcbiAgfVxufVxuXG4vLyBSZXR1cm5zIHRydWUgaWYgaXQgaXMgYSBzaW1wbGUgcXVlcnkgdGhhdCB3ZSBjYW4gcHJvY2VzcyB3aXRoIG5lZGJcbmZ1bmN0aW9uIHFyeUlzU2ltcGxlKHFyeSkge1xuICB2YXIgc2ltcGxlID0gdHJ1ZTtcblxuICBpZiAoQXJyYXkuaXNBcnJheShxcnkpKSB7XG4gICAgcXJ5LmZvckVhY2goZnVuY3Rpb24odmFsKSB7XG4gICAgICB2YXIga29zaGVyID0gcXJ5SXNTaW1wbGUodmFsKTtcbiAgICAgIGlmICgha29zaGVyKSB7XG4gICAgICAgIHNpbXBsZSA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0gZWxzZSBpZiAoYW5ndWxhci5pc09iamVjdChxcnkpKSB7XG4gICAgZm9yICh2YXIga2V5IGluIHFyeSkge1xuICAgICAgdmFyIHZhbCA9IHFyeVtrZXldO1xuICAgICAgLy8gVGhlIGtleSBpcyBmaW5lIGlmIGl0IGRvZXNuJ3QgYmVnaW4gd2l0aCAkIG9yIGlzIGEgc2ltcGxlIG9wZXJhdG9yXG4gICAgICB2YXIga29zaGVyS2V5ID0gKGtleVswXSAhPT0gJyQnKSB8fCBzaW1wbGVPcGVyYXRvcnNba2V5XTtcblxuICAgICAgaWYgKCFrb3NoZXJLZXkpIHtcbiAgICAgICAgc2ltcGxlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICB2YXIgdmFsS29zaGVyID0gcXJ5SXNTaW1wbGUodmFsKTtcblxuICAgICAgaWYgKCF2YWxLb3NoZXIpIHtcbiAgICAgICAgc2ltcGxlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBzaW1wbGU7XG59XG5cbi8vIENvbnZlcnQgYW55IF9pZCBzZWFyY2hlcyB0byBfX2lkICh3aGljaCBpcyB3aGVyZSBvdXIgaWQgbW92ZWQgdG8pXG5mdW5jdGlvbiBfY3JlYXRlRGJGaW5kKHFyeSkge1xuICBpZiAoQXJyYXkuaXNBcnJheShxcnkpKSB7XG4gICAgcXJ5LmZvckVhY2goZnVuY3Rpb24odmFsKSB7XG4gICAgICBfY3JlYXRlRGJGaW5kKHZhbCk7XG4gICAgfSk7XG4gIH0gZWxzZSBpZiAoYW5ndWxhci5pc09iamVjdChxcnkpKSB7XG4gICAgZm9yICh2YXIga2V5IGluIHFyeSkge1xuICAgICAgdmFyIHZhbCA9IHFyeVtrZXldO1xuXG4gICAgICAvLyBDb252ZXJ0IHRoZSBfaWQgdG8gX19pZCBzZWFyY2hlc1xuICAgICAgaWYgKGtleSA9PT0gJ19pZCcpIHtcbiAgICAgICAgcXJ5Ll9faWQgPSB2YWw7XG4gICAgICAgIGRlbGV0ZSBxcnkuX2lkO1xuICAgICAgfVxuXG4gICAgICBfY3JlYXRlRGJGaW5kKHZhbCk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZURiRmluZChxcnkpIHtcbiAgLy8gQ29udmVydHMgdGhlIHF1ZXJ5IGludG8gdGhlIGZvcm0gcmVxdWlyZWQgZm9yIGEgZGIgc2VhcmNoLiBGaXJzdCBjbG9uZSB0aGUgb2JqZWN0XG4gIHFyeSA9IGNsb25lKHFyeSwgdHJ1ZSk7XG4gIF9jcmVhdGVEYkZpbmQocXJ5KTtcbiAgcmV0dXJuIHFyeTtcbn1cblxuZnVuY3Rpb24gZXh0ZW5kUXVlcnkocXJ5MSwgcXJ5Mikge1xuICAvLyBDYWxjIHRoZSBuZXcgcXVlcnkgdGhhdCB3ZSB3YW50XG4gIHZhciBfcXJ5ID0gY2xvbmUocXJ5MSwgdHJ1ZSk7XG4gIFsnbGltaXQnLCAnc2tpcCcsICdzb3J0J10uZm9yRWFjaChmdW5jdGlvbihwcm9wKSB7XG4gICAgaWYgKHFyeTJbcHJvcF0pIHtcbiAgICAgIF9xcnlbcHJvcF0gPSBxcnkyW3Byb3BdO1xuICAgIH1cbiAgfSk7XG5cbiAgaWYgKCFpc0VtcHR5KHFyeTIuZmluZCkpIHtcbiAgICAvLyBXYW50IHRvIG9yIHRvZ2V0aGVyIC0gYnV0IGlzIHRoZSB0b3BsZXZlbCBhbHJlYWR5IGFuIG9yPyAoYW5kIG9ubHkgYW4gb3IpXG4gICAgdmFyIGV4aXN0aW5nT3IgPSBmYWxzZTtcbiAgICBpZiAoX3FyeS5maW5kLiRvcikge1xuICAgICAgdmFyIHZhbGlkID0gdHJ1ZTtcbiAgICAgIGZvciAodmFyIGtleSBpbiBfcXJ5LmZpbmQpIHtcbiAgICAgICAgaWYgKGtleSAhPT0gJyRvcicpIHtcbiAgICAgICAgICB2YWxpZCA9IGZhbHNlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBleGlzdGluZ09yID0gdmFsaWQ7XG4gICAgfVxuXG4gICAgaWYgKGV4aXN0aW5nT3IpIHtcbiAgICAgIF9xcnkuZmluZCA9IGNsb25lKF9xcnkuZmluZCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIF9xcnkuZmluZCA9IHskb3I6IFtfcXJ5LmZpbmRdfTtcbiAgICB9XG5cbiAgICBfcXJ5LmZpbmQuJG9yLnB1c2gocXJ5Mi5maW5kKTtcbiAgfVxuXG4gIHJldHVybiBfcXJ5O1xufVxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbigkcm9vdFNjb3BlLCAkcSwgJHRpbWVvdXQsICRpbmplY3RvciwgQ2hhaW4pIHtcbiAgJ25nSW5qZWN0JztcblxuICBmdW5jdGlvbiBRdWVyeUZhY3RvcnkodXJsLCByb290S2V5LCByb290S2V5UGx1cmFsLCBkYikge1xuICAgIHZhciBzb2NrZXQgPSAkaW5qZWN0b3IuZ2V0KCdzb2NrZXQnKTtcbiAgICB2YXIgc29jayA9IHNvY2tldCh1cmwsIHJvb3RLZXksIHJvb3RLZXlQbHVyYWwpO1xuXG4gICAgLy8gT2JqZWN0IGhvbGRpbmcgcXVlcmllcyAoa2V5cyBhcmUgdGhlIHF1ZXJ5IGlkcywgdmFsdWVzIGFyZSBhcnJheXMgb2YgYXJyYXlzKVxuICAgIHZhciBfc2VydmVyUXVlcmllcyA9IHt9O1xuICAgIHZhciBfbG9jYWxRdWVyaWVzID0gW107XG5cbiAgICAvLyBJZiB0aGUgc29ja2V0IHJlc2V0cyBvciBjb25uZWN0cyB0aGVuIHJlZmV0Y2ggZXZlcnl0aGluZ1xuICAgIHNvY2sub24oJ3Jlc2V0JywgZnVuY3Rpb24oKSB7XG4gICAgICByZWZyZXNoUXVlcmllcygpO1xuICAgIH0pO1xuICAgIHNvY2sub24oJ2Nvbm5lY3RlZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgcmVmcmVzaFF1ZXJpZXMoKTtcbiAgICB9KTtcblxuICAgIC8vIExpc3RlbiBmb3IgbW9kaWZpZWQgcXVlcmllc1xuICAgIHNvY2sub24oJ21vZGlmaWVkIHF1ZXJ5JywgZnVuY3Rpb24ocXJ5SWQsIGRhdGEpIHtcbiAgICAgIHZhciBxcnlzID0gX3NlcnZlclF1ZXJpZXNbcXJ5SWRdO1xuICAgICAgaWYgKHFyeXMpIHtcbiAgICAgICAgcXJ5cy5mb3JFYWNoKGZ1bmN0aW9uKHFyeSkge1xuICAgICAgICAgIHFyeS4kbmV3RGF0YShxcnlJZCwgZGF0YSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgZnVuY3Rpb24gcmVmcmVzaFF1ZXJpZXMoKSB7XG4gICAgICB2YXIgcmVzdWx0c1NldCA9IHVuaXEoZmxhdHRlbih2YWx1ZXMoX3NlcnZlclF1ZXJpZXMpLCB0cnVlKSk7XG4gICAgICByZXN1bHRzU2V0LmZvckVhY2goZnVuY3Rpb24ocmVzdWx0cykge1xuICAgICAgICByZXN1bHRzLiRyZWZyZXNoKCk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBMb2NhbCBRdWVyeSBMaXN0XG4gICAgICogQHBhcmFtIHtbdHlwZV19IHFyeSAgICAgIFtkZXNjcmlwdGlvbl1cbiAgICAgKiBAcGFyYW0ge1t0eXBlXX0gbGltaXQgICAgW2Rlc2NyaXB0aW9uXVxuICAgICAqIEBwYXJhbSB7W3R5cGVdfSBSZXNvdXJjZSBbZGVzY3JpcHRpb25dXG4gICAgICogQHBhcmFtIHtbdHlwZV19IHRvUmVzICAgIFtkZXNjcmlwdGlvbl1cbiAgICAgKlxuICAgICAqIFN0cmF0ZWd5IC0gd2UgcnVuIHRoZSBxdWVyeSBvbiB0aGUgc2VydmVyLiBIb3dldmVyIGlmIHdlIGNhbiBkZWFsIHdpdGggaXQgbG9jYWxseSAodmlhXG4gICAgICogbmVkYikgdGhlbiBkbyBzby4gSWYgdGhlIHF1ZXJ5IGF0IGFueSB0aW1lIGJlY29tZXMgbW9yZSBjb21wbGljYXRlZCB3ZSBqdXN0IGZhbGwgdGhyb3VnaFxuICAgICAqIHRvIHRoZSBzZXJ2ZXIgdmVyc2lvblxuICAgICAqL1xuICAgIGZ1bmN0aW9uIExvY2FsUXVlcnlMaXN0KHFyeSwgbGltaXQsIFJlc291cmNlLCB0b1Jlcykge1xuICAgICAgLy8gQWxsb3cgcXJ5IHRvIGJlIGEgcHJvbWlzZSwgYW5kIHdlIHJldHVybiB0aGUgcmF3IChub24gX3EgYml0KVxuICAgICAgcXJ5ID0gJHEud2hlbihxcnkpLnRoZW4obm9ybWFsaXplUXVlcnkpLnRoZW4oZnVuY3Rpb24oX3FyeSkge1xuICAgICAgICBpZiAobGltaXQpIHtcbiAgICAgICAgICBfcXJ5LmxpbWl0ID0gbGltaXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIF9xcnk7XG4gICAgICB9KTtcblxuICAgICAgLy8gR2VuZXJhdGUgdGhlIFNlcnZlclF1ZXJ5LiBXZSBkbyB0aGlzIHNvIHdlIGhhdmUgc29tZXRoaW5nIHRvIGZhbGwgYmFjayBvblxuICAgICAgLy8gYW5kIGFsc28gc28gdGhhdCB3ZSB3aWxsIChvciBzaG91bGQhKSBnZXQgbm90aWZpZWQgb2YgY2hhbmdlcyBmcm9tIHRoZSBzZXJ2ZXIgaWZcbiAgICAgIC8vIHNvbWVvbmUgZWxzZSBjcmVhdGVzIG9yIHJlbW92ZXMgc29tZXRoaW5nIHRoYXQgc2hvdWxkIGdvIGluIHRoZXNlIHJlc3VsdHNcbiAgICAgIHZhciBzZXJ2ZXJSZXN1bHRzID0gU2VydmVyUXVlcnlMaXN0KHFyeSwgbGltaXQsIFJlc291cmNlKTtcblxuICAgICAgdmFyIHJlc3VsdHMgPSBbXTtcbiAgICAgIF9sb2NhbFF1ZXJpZXMucHVzaChyZXN1bHRzKTtcbiAgICAgIHZhciBjdXJyZW50TGltaXQgPSAwO1xuICAgICAgdmFyIGN1cnJlbnRTa2lwID0gMDtcbiAgICAgIHZhciBsYXN0QmF0Y2hTaXplID0gMDtcbiAgICAgIHZhciBmYWxsYmFjayA9IGZhbHNlO1xuXG4gICAgICByZXN1bHRzLmxvYWRpbmcgPSB0cnVlO1xuXG4gICAgICAvLyBXaGVuIHRoZSBzZXJ2ZXIgcmVzdWx0cyBhcmUgdXBkYXRlZCB3ZSB3YW50IHRvIGNoZWNrIHBhZ2luZyBvcHRpb25zIGFuZCBhcHBseVxuICAgICAgLy8gdGhlbSB0byBvdXIgcmVzdWx0c1xuICAgICAgc2VydmVyUmVzdWx0cy4kZW1pdHRlci5vbigndXBkYXRlJywgc3luY0Zyb21TZXJ2ZXIpO1xuXG4gICAgICBmdW5jdGlvbiBzeW5jRnJvbVNlcnZlcigpIHtcbiAgICAgICAgcmVzdWx0cy5oYXNOZXh0ID0gc2VydmVyUmVzdWx0cy5oYXNOZXh0O1xuICAgICAgICByZXN1bHRzLmhhc1ByZXYgPSBzZXJ2ZXJSZXN1bHRzLmhhc1ByZXY7XG5cbiAgICAgICAgLy8gSWYgd2UgYXJlIGZhbGxpbmcgYmFjayB0aGVuIHNldCB1cCBhbmQgY29weSBvdXIgdmFyaW91cyBwcm9wZXJ0aWVzIGFjcm9zc1xuICAgICAgICBpZiAoZmFsbGJhY2spIHtcbiAgICAgICAgICByZXN1bHRzLiRoYXNOZXh0ID0gZmFsc2U7XG4gICAgICAgICAgcmVzdWx0cy4kaGFzUHJldiA9IGZhbHNlO1xuICAgICAgICAgIHJlc3VsdHMubGVuZ3RoID0gMDtcbiAgICAgICAgICBzZXJ2ZXJSZXN1bHRzLmZvckVhY2goZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgICByZXN1bHRzLnB1c2gocmVzKTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGN1cnJlbnRMaW1pdCA9IHJlc3VsdHMubGVuZ3RoO1xuICAgICAgICAgIGN1cnJlbnRTa2lwID0gcmVzdWx0cy4kc2tpcDtcbiAgICAgICAgICBsYXN0QmF0Y2hTaXplID0gbGFzdEJhdGNoU2l6ZSB8fCByZXN1bHRzLmxlbmd0aDtcbiAgICAgICAgfVxuICAgICAgfVxuXG5cbiAgICAgIGZ1bmN0aW9uIGdldCgpIHtcbiAgICAgICAgcmV0dXJuIFJlc291cmNlLmdldC5hcHBseShSZXNvdXJjZSwgYXJndW1lbnRzKTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gY2hhaW4oTW9kZWwsIHFyeUZuKSB7XG4gICAgICAgIHJldHVybiBDaGFpbihyZXN1bHRzLCBNb2RlbCwgcXJ5Rm4pO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBxdWVyeShfcXJ5KSB7XG5cbiAgICAgICAgLy8gU3RvcmUgb2ZmIHRoZSBxcnkgbWFraW5nIHN1cmUgaXRzIGEgcHJvbWlzZVxuICAgICAgICBxcnkgPSAkcS53aGVuKF9xcnkpO1xuXG4gICAgICAgIGZhbGxiYWNrID0gIXFyeUlzU2ltcGxlKF9xcnkpO1xuXG4gICAgICAgIC8vIElmIHdlIGFyZSBmYWxsaW5nYmFjayB0aGVuIGp1c3QgcmVzb2x2ZSB3aXRoIG91ciByZXN1bHRzLiBUaGUgc2VydmVyIHNob3VsZFxuICAgICAgICAvLyBkbyB0aGUgcmVzdC5cbiAgICAgICAgaWYgKGZhbGxiYWNrKSB7XG4gICAgICAgICAgLy8gV2Ugd2FudCB0byByZXR1cm4gdGhlIHNlcnZlcidzIHByb21pc2UgaGVyZSBzbyB0aGF0IHBlb3BsZSB3aWxsIGJlIG5vdGlmaWVkXG4gICAgICAgICAgLy8gd2hlbiB0aGUgcmVzdWx0cyBhcmUgYWN0dWFsbHkgbG9hZGVkXG4gICAgICAgICAgdmFyIHByb207XG4gICAgICAgICAgaWYgKCFzZXJ2ZXJSZXN1bHRzLiRyZXNvbHZlZCkge1xuICAgICAgICAgICAgcHJvbSA9IHNlcnZlclJlc3VsdHMuJHByb21pc2UudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvbSA9ICRxLndoZW4ocmVzdWx0cyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHByb207XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICB2YXIgZmluZCA9IGNyZWF0ZURiRmluZChfcXJ5LmZpbmQpO1xuICAgICAgICB2YXIgbGltaXQgPSBfcXJ5LmxpbWl0O1xuICAgICAgICB2YXIgc2tpcCA9IF9xcnkuc2tpcDtcbiAgICAgICAgdmFyIHNvcnQgPSBfcXJ5LnNvcnQ7XG5cbiAgICAgICAgdmFyIGN1ciA9IGRiLmZpbmQoZmluZCk7XG5cbiAgICAgICAgaWYgKHNvcnQpIHtcbiAgICAgICAgICBjdXIgPSBjdXIuc29ydChzb3J0KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2tpcCkge1xuICAgICAgICAgIGN1ciA9IGN1ci5za2lwKHNraXApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChsaW1pdCkge1xuICAgICAgICAgIC8vIFdlIGdvICsgMSBzbyB3ZSBjYW4gdGVsbCBpZiB0aGVyZSBhcmUgYW55IG1vcmUgcmVzdWx0c1xuICAgICAgICAgIGN1ciA9IGN1ci5saW1pdChsaW1pdCArIDEpO1xuICAgICAgICB9XG5cbiAgICAgICAgY3VyLmV4ZWMoZnVuY3Rpb24oZXJyLCBkb2NzKSB7XG4gICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdChlcnIpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIFdlIGNhbiBzZXQgdGhlIGhhc05leHQgYW5kIGhhc1ByZXYgdmFsdWVzIHRvIHRydWUgaGVyZSBpZiB3ZSBrbm93IHRoZXJlXG4gICAgICAgICAgICAvLyBhcmUgc29tZS4gSG93ZXZlciBvbmx5IHRoZSBzZXJ2ZXIgaGFzIHRoZSBkZWZpbml0aXZlIGFiaWxpdHkgdG8gc2F5XG4gICAgICAgICAgICAvLyB0aGVyZSBhcmVudCBhbnlcbiAgICAgICAgICAgIHJlc3VsdHMuJGhhc05leHQgPSBmYWxzZTtcbiAgICAgICAgICAgIHJlc3VsdHMuJGhhc1ByZXYgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChsaW1pdCAmJiBkb2NzLmxlbmd0aCA+IGxpbWl0KSB7XG4gICAgICAgICAgICAgIC8vIFdlIGhhdmUgbW9yZSByZXN1bHRzIHRvIGZldGNoXG4gICAgICAgICAgICAgIHJlc3VsdHMuaGFzTmV4dCA9IHRydWU7XG4gICAgICAgICAgICAgIHJlc3VsdHMuJGhhc05leHQgPSB0cnVlO1xuXG4gICAgICAgICAgICAgIC8vIFRyaW0gdGhlIHJlc3VsdHMgZG93biB0byBzaXplXG4gICAgICAgICAgICAgIGRvY3MubGVuZ3RoIC09IDE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChza2lwKSB7XG4gICAgICAgICAgICAgIHJlc3VsdHMuaGFzUHJldiA9IHRydWU7XG4gICAgICAgICAgICAgIHJlc3VsdHMuJGhhc1ByZXYgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBDYWxjdWxhdGUgcGFnaW5nIG9wdGlvbnNcbiAgICAgICAgICAgIGN1cnJlbnRMaW1pdCA9IGRvY3MubGVuZ3RoO1xuICAgICAgICAgICAgY3VycmVudFNraXAgPSBza2lwIHx8IDA7XG4gICAgICAgICAgICBsYXN0QmF0Y2hTaXplID0gbGFzdEJhdGNoU2l6ZSB8fCBkb2NzLmxlbmd0aDtcblxuICAgICAgICAgICAgLy8gR28gdG8gcmVzb3VyY2UgdHlwZXNcbiAgICAgICAgICAgIHZhciB0bXBSZXN1bHRzID0gZG9jcy5tYXAodG9SZXMpO1xuXG4gICAgICAgICAgICAvLyBEbyB3ZSBuZWVkIHRvIGRvIGEgdHJhbnNmb3JtP1xuICAgICAgICAgICAgdmFyIHJwcm9tO1xuICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNGdW5jdGlvbihyZXN1bHRzLnRyYW5zZm9ybSkpIHtcbiAgICAgICAgICAgICAgcnByb20gPSAkcS53aGVuKHJlc3VsdHMudHJhbnNmb3JtKHRtcFJlc3VsdHMpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJwcm9tID0gJHEud2hlbih0bXBSZXN1bHRzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJwcm9tLnRoZW4oZnVuY3Rpb24odHJhbnNmb3JtZWQpIHtcbiAgICAgICAgICAgICAgLy8gUHV0IHRoZSByZXNvdXJjZXMgaW50byB0aGUgbGlzdFxuICAgICAgICAgICAgICByZXN1bHRzLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgIHRyYW5zZm9ybWVkLmZvckVhY2goZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHJlcyk7XG4gICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgIHJlc3VsdHMuJGVtaXR0ZXIuZW1pdCgndXBkYXRlJywgcmVzdWx0cyk7XG5cbiAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXN1bHRzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcmVmcmVzaFF1ZXJ5KGZvcmNlU2VydmVyKSB7XG4gICAgICAgIC8vIFBlcmZvcm0gb3VyIHF1ZXJ5XG4gICAgICAgIHZhciBwcm9tID0gcXJ5LnRoZW4ocXVlcnkpLnRoZW4oZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgLy8gSWYgd2UgZG9uJ3QgaGF2ZSBhbnkgcmVzdWx0cyB0aGVuIG1heWJlIHdhaXQgZm9yIHRoZSBzZXJ2ZXIgdG8gcmV0dXJuXG4gICAgICAgICAgaWYgKChyZXMubGVuZ3RoID09PSAwICYmICFzZXJ2ZXJSZXN1bHRzLiRyZXNvbHZlZCkpIHtcbiAgICAgICAgICAgIHJldHVybiBzZXJ2ZXJSZXN1bHRzLiRwcm9taXNlLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgIHJldHVybiByZWZyZXNoUXVlcnkoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKGZvcmNlU2VydmVyKSB7XG4gICAgICAgICAgcHJvbSA9IHNlcnZlclJlc3VsdHMuJHJlZnJlc2godHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbS50aGVuKGZ1bmN0aW9uKHJlcykge1xuICAgICAgICAgIHJlc3VsdHMubG9hZGluZyA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBleHRlbmRSZXN1bHRzKG9iaiwgbm9TYW5pdGl6ZSwgcmV0U2VydmVyKSB7XG5cbiAgICAgICAgLy8gU2FuaXRpemUgdGhlIG9iamVjdFxuICAgICAgICBpZiAoIW5vU2FuaXRpemUpIHtcbiAgICAgICAgICBpZiAob2JqLl9xKSB7XG4gICAgICAgICAgICBvYmogPSBvYmouX3E7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG9iaiA9IHtmaW5kOiBvYmp9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBxcnkudGhlbihmdW5jdGlvbihyZXNvbHZlZCkge1xuICAgICAgICAgIHZhciBfcXJ5ID0gZXh0ZW5kUXVlcnkocmVzb2x2ZWQsIG9iaik7XG4gICAgICAgICAgcmV0dXJuIHJlcGxhY2UoX3FyeSwgcmV0U2VydmVyKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHJlcGxhY2UoX3FyeSwgcmV0U2VydmVyKSB7XG4gICAgICAgIC8vIFN5bmMgZG93biB0byB0aGUgc2VydmVycXVlcnlcbiAgICAgICAgdmFyIHNlcnZlclByb20gPSBzZXJ2ZXJSZXN1bHRzLnJlcGxhY2UoX3FyeSk7XG5cbiAgICAgICAgLy8gRG8gdGhlIHF1ZXJ5IGJ1dCByZXBsYWNlIHRoZSBleGlzdGluZyBxdWVyeVxuICAgICAgICB2YXIgbG9jYWxQcm9tID0gJHEud2hlbihfcXJ5KS50aGVuKG5vcm1hbGl6ZVF1ZXJ5KS50aGVuKGZ1bmN0aW9uKG5vcm1RcnkpIHtcblxuICAgICAgICAgIC8vIFdlIGFsbG93IGEgcXVlcnkgdG8gcmVzb2x2ZSB0byBzb21ldGhpbmcgZmFsc3kgLSBpbiB3aGljaCBjYXNlIHdlIGp1c3RcbiAgICAgICAgICAvLyBkcm9wIGl0XG4gICAgICAgICAgaWYgKCFub3JtUXJ5KSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHFyeS50aGVuKGZ1bmN0aW9uKG9sZHFyeSkge1xuICAgICAgICAgICAgaWYgKEpTT04uc3RyaW5naWZ5KG9sZHFyeSkgIT09IEpTT04uc3RyaW5naWZ5KG5vcm1RcnkpKSB7XG4gICAgICAgICAgICAgIC8vIHF1ZXJ5IGlzIGRpZmZlcmVudCAtIGNvbnRpbnVlXG5cbiAgICAgICAgICAgICAgcmV0dXJuIHF1ZXJ5KG5vcm1RcnkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcmV0U2VydmVyID8gc2VydmVyUHJvbSA6IGxvY2FsUHJvbTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gbmV4dChudW0pIHtcbiAgICAgICAgdmFyIHByb21pc2U7XG4gICAgICAgIHZhciBleHRlbmRTaXplO1xuICAgICAgICBpZiAocmVzdWx0cy5oYXNOZXh0KSB7XG4gICAgICAgICAgbGFzdEJhdGNoU2l6ZSA9IGV4dGVuZFNpemUgPSBudW0gfHwgbGFzdEJhdGNoU2l6ZTtcbiAgICAgICAgICB2YXIgZXh0ZW5kT2JqID0ge1xuICAgICAgICAgICAgbGltaXQ6IGN1cnJlbnRMaW1pdCArIGV4dGVuZFNpemVcbiAgICAgICAgICB9O1xuICAgICAgICAgIHByb21pc2UgPSBleHRlbmRSZXN1bHRzKGV4dGVuZE9iaiwgdHJ1ZSwgIXJlc3VsdHMuJGhhc05leHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZSgpO1xuICAgICAgICAgIHByb21pc2UgPSBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHByZXYobnVtKSB7XG4gICAgICAgIHZhciBwcm9taXNlO1xuICAgICAgICB2YXIgZXh0ZW5kU2l6ZTtcbiAgICAgICAgaWYgKHJlc3VsdHMuaGFzUHJldikge1xuICAgICAgICAgIGxhc3RCYXRjaFNpemUgPSBleHRlbmRTaXplID0gbnVtIHx8IGxhc3RCYXRjaFNpemU7XG4gICAgICAgICAgdmFyIGV4dGVuZE9iaiA9IHtcbiAgICAgICAgICAgIHNraXA6IE1hdGgubWF4KGN1cnJlbnRTa2lwIC0gZXh0ZW5kU2l6ZSwgMCksXG4gICAgICAgICAgICBsaW1pdDogY3VycmVudExpbWl0ICsgZXh0ZW5kU2l6ZVxuICAgICAgICAgIH07XG4gICAgICAgICAgcHJvbWlzZSA9IGV4dGVuZFJlc3VsdHMoZXh0ZW5kT2JqLCB0cnVlLCAhcmVzdWx0cy4kaGFzUHJldik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgcHJvbWlzZSA9IGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH1cblxuICAgICAgLy8gRXZlbnQgZW1pdHRlciAnaW5oZXJpdGFuY2UnXG4gICAgICB2YXIgZW1pdHRlciA9IG5ldyBldmVudHMuRXZlbnRFbWl0dGVyKCk7XG4gICAgICB2YXIgZWVwcm9wcyA9IFtcbiAgICAgICAgJ2FkZExpc3RlbmVyJyxcbiAgICAgICAgJ29uJyxcbiAgICAgICAgJ29uY2UnLFxuICAgICAgICAncmVtb3ZlTGlzdGVuZXInXG4gICAgICBdO1xuICAgICAgZWVwcm9wcy5mb3JFYWNoKGZ1bmN0aW9uKHByb3ApIHtcbiAgICAgICAgcmVzdWx0c1twcm9wXSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHJldHVybiBlbWl0dGVyW3Byb3BdLmFwcGx5KGVtaXR0ZXIsIGFyZ3VtZW50cyk7XG4gICAgICAgIH07XG4gICAgICB9KTtcblxuICAgICAgcmVzdWx0cy4kcmVmcmVzaCA9IHJlZnJlc2hRdWVyeTtcbiAgICAgIHJlc3VsdHMuZXh0ZW5kID0gZXh0ZW5kUmVzdWx0cztcbiAgICAgIHJlc3VsdHMucmVwbGFjZSA9IHJlcGxhY2U7XG4gICAgICByZXN1bHRzLmdldCA9IGdldDtcbiAgICAgIHJlc3VsdHMubmV4dCA9IG5leHQ7XG4gICAgICByZXN1bHRzLnByZXYgPSBwcmV2O1xuICAgICAgcmVzdWx0cy4kcHJvbWlzZSA9IHJlZnJlc2hRdWVyeSgpO1xuICAgICAgcmVzdWx0cy5jaGFpbiA9IGNoYWluO1xuICAgICAgcmVzdWx0cy4kTW9kZWwgPSBSZXNvdXJjZTtcbiAgICAgIHJlc3VsdHMuJGVtaXR0ZXIgPSBlbWl0dGVyO1xuICAgICAgcmVzdWx0cy4kc2VydmVyUmVzdWx0cyA9IHNlcnZlclJlc3VsdHM7XG4gICAgICBxdWVyeVRyYW5zZm9ybXMuYXBwbHkocmVzdWx0cyk7XG5cbiAgICAgIHJldHVybiByZXN1bHRzO1xuICAgIH1cblxuICAgIHZhciByZWZyZXNoVGltZXI7XG4gICAgTG9jYWxRdWVyeUxpc3QucmVmcmVzaCA9IGZ1bmN0aW9uIHJlZnJlc2goKSB7XG5cbiAgICAgIC8vIElmIHdlIGhhdmUgYSB0aW1lciBvdXRzdGFuZGluZyB0aGVuIGp1c3QgcmV0dXJuIC0gYSByZWZyZXNoIHdpbGwgaGFwcGVuIHNvb24uXG4gICAgICBpZiAoIXJlZnJlc2hUaW1lcikge1xuICAgICAgICByZWZyZXNoVGltZXIgPSAkdGltZW91dChkb1JlZnJlc2gsIDEwMCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZWZyZXNoVGltZXI7XG5cbiAgICAgIGZ1bmN0aW9uIGRvUmVmcmVzaCgpIHtcbiAgICAgICAgX2xvY2FsUXVlcmllcy5mb3JFYWNoKGZ1bmN0aW9uKHJlcykge1xuICAgICAgICAgIHJlcy4kcmVmcmVzaCgpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmVmcmVzaFRpbWVyID0gbnVsbDtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgLyoqXG4gICAgICogU2VydmVyIHF1ZXJ5IGxpc3QuIFRoZSBzZXJ2ZXIgbWFrZXMgc3VyZSB3ZSBrZWVwIGluIHN5bmNcbiAgICAgKiBAcGFyYW0ge1t0eXBlXX0gcXJ5ICAgICAgW2Rlc2NyaXB0aW9uXVxuICAgICAqIEBwYXJhbSB7W3R5cGVdfSBsaW1pdCAgICBbZGVzY3JpcHRpb25dXG4gICAgICogQHBhcmFtIHtbdHlwZV19IFJlc291cmNlIFtkZXNjcmlwdGlvbl1cbiAgICAgKi9cbiAgICBmdW5jdGlvbiBTZXJ2ZXJRdWVyeUxpc3QocXJ5LCBsaW1pdCwgUmVzb3VyY2UpIHtcbiAgICAgIC8vIEFsbG93IHFyeSB0byBiZSBhIHByb21pc2VcbiAgICAgIHFyeSA9ICRxLndoZW4ocXJ5KS50aGVuKG5vcm1hbGl6ZVF1ZXJ5KS50aGVuKGZ1bmN0aW9uKF9xcnkpIHtcbiAgICAgICAgaWYgKGxpbWl0KSB7XG4gICAgICAgICAgX3FyeS5saW1pdCA9IGxpbWl0O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBfcXJ5O1xuICAgICAgfSk7XG5cbiAgICAgIHZhciBlbWl0UHJvbWlzZSA9IG51bGw7XG4gICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgICAgdmFyIGN1cnJlbnRMaW1pdCA9IDA7XG4gICAgICB2YXIgY3VycmVudFNraXAgPSAwO1xuICAgICAgdmFyIGxhc3RCYXRjaFNpemUgPSAwO1xuICAgICAgdmFyIHFyeUlkID0gbnVsbDtcbiAgICAgIHZhciBfcGFnaW5nT3B0cyA9IHt9O1xuXG4gICAgICByZXN1bHRzLmxvYWRpbmcgPSB0cnVlO1xuXG5cbiAgICAgIGZ1bmN0aW9uIHF1ZXJ5KGRhdGEsIHJlcGxhY2VzKSB7XG4gICAgICAgIC8vIFdlIG9ubHkgd2FudCB0byBkbyBvbmUgZW1pdCBhdCBhIHRpbWUgKG90aGVyd2lzZSB3ZSBjb3VsZCBnZXQgaW50byBhIGJhZCBzdGF0ZSlcbiAgICAgICAgaWYgKGFuZ3VsYXIuaXNGdW5jdGlvbihkYXRhKSkge1xuICAgICAgICAgIGRhdGEgPSBkYXRhKCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBTdG9yZSBvZmYgdGhlIHF1ZXJ5IC0gbWFrZSBzdXJlIGl0cyBhIHByb21pc2VcbiAgICAgICAgcXJ5ID0gJHEud2hlbihkYXRhKTtcblxuICAgICAgICByZXR1cm4gcXJ5LnRoZW4oZnVuY3Rpb24oZGF0YSkge1xuICAgICAgICAgIC8vIElmIHdlIGhhdmUgYW4gZXhpc3RpbmcgZW1pdFByb21pc2UgdGhlbiB3YWl0IGZvciBpdCB0byByZXNvbHZlIGJlZm9yZSB3ZSBydW5cbiAgICAgICAgICB2YXIgcHJvbWlzZTtcbiAgICAgICAgICBpZiAoZW1pdFByb21pc2UpIHtcbiAgICAgICAgICAgIHByb21pc2UgPSBlbWl0UHJvbWlzZS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICByZXR1cm4gc29jay5xdWVyeShkYXRhLCByZXBsYWNlcyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZW1pdFByb21pc2UgPSBwcm9taXNlID0gc29jay5xdWVyeShkYXRhLCByZXBsYWNlcyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBuZXdEYXRhKF9xcnlJZCwgcmVzcG9uc2UsIGZvcmNlKSB7XG4gICAgICAgIGlmICghcmVzcG9uc2UpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICB2YXIgaWRzID0gcmVzcG9uc2UuaWRzO1xuICAgICAgICB2YXIgcGFnaW5nT3B0cyA9IHJlc3BvbnNlLnBhZ2luZ09wdHM7XG5cbiAgICAgICAgbWF5YmVOZXdRcnlJZChfcXJ5SWQpO1xuXG4gICAgICAgIC8vIFNvIGZhciB3ZSd2ZSBvbmx5IGdvdCB0aGUgaWRzIG9mIHRoZSBxcnkgcmVzdWx0IC0gZ28gYW5kIGZldGNoIHRoZSBhY3R1YWwgb2JqZWN0cy5cbiAgICAgICAgLy8gVGhpcyBtZWNoYW5pc20gc2F2ZXMgYmFuZHdpZHRoIGJ5IG9ubHkgZ2V0dGluZyB0aGUgb2JqZWN0IGRhdGEgb25jZSB0aGVuIGxpc3RlbmluZ1xuICAgICAgICAvLyBmb3IgY2hhbmdlcyB0byBpdFxuICAgICAgICAvL1xuICAgICAgICAvLyBJZiB3ZSBhcmUgZm9yY2luZyB3ZSB3YW50IHRvIGdldCBib3RoIHRoZSBvbGQgYW5kIG5ldyBpZHMgdG8gY2hlY2sgZm9yIGFueSBjaGFuZ2VzXG4gICAgICAgIC8vIGRlbGV0aW9ucyBldGMuLlxuICAgICAgICB2YXIgZ2V0SWRzID0gaWRzO1xuICAgICAgICBpZiAoZm9yY2UpIHtcbiAgICAgICAgICB2YXIgb2xkSWRzID0gcGx1Y2socmVzdWx0cywgJ19pZCcpO1xuICAgICAgICAgIGdldElkcyA9IHVuaW9uKGlkcywgb2xkSWRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIFJlc291cmNlLmdldChnZXRJZHMsIGZvcmNlKS4kcHJvbWlzZS50aGVuKGZ1bmN0aW9uKHJlc3MpIHtcbiAgICAgICAgICB2YXIgcmVzc21hcCA9IHt9O1xuICAgICAgICAgIHJlc3MuZm9yRWFjaChmdW5jdGlvbihyZXMpIHtcbiAgICAgICAgICAgIHJlc3NtYXBbcmVzLl9pZF0gPSByZXM7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICAvLyBXZSBkb24ndCBhbGxvdyByZXBlYXRlZCBpZHMgc28ganVzdCBpdGVyYXRlIG92ZXIgdGhlIHJlc3VsdHNcbiAgICAgICAgICB2YXIgdG1wUmVzdWx0cyA9IFtdO1xuICAgICAgICAgIGlkcy5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICAgICAgICB0bXBSZXN1bHRzLnB1c2gocmVzc21hcFtpZF0pO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgLy8gRG8gd2UgbmVlZCB0byBkbyBhIHRyYW5zZm9ybT9cbiAgICAgICAgICB2YXIgcnByb207XG4gICAgICAgICAgaWYgKGFuZ3VsYXIuaXNGdW5jdGlvbihyZXN1bHRzLnRyYW5zZm9ybSkpIHtcbiAgICAgICAgICAgIHJwcm9tID0gJHEud2hlbihyZXN1bHRzLnRyYW5zZm9ybSh0bXBSZXN1bHRzKSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJwcm9tID0gJHEud2hlbih0bXBSZXN1bHRzKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gcnByb20udGhlbihmdW5jdGlvbih0cmFuc2Zvcm1lZCkge1xuXG4gICAgICAgICAgICByZXN1bHRzLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICB0cmFuc2Zvcm1lZC5mb3JFYWNoKGZ1bmN0aW9uKHJlcykge1xuICAgICAgICAgICAgICByZXN1bHRzLnB1c2gocmVzKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBTaW5jZSB3ZSBub3cgaGF2ZSBkYXRhIGluIG91ciBhcnJheSBzdG9yZSBvZmYgbGltaXQgZGF0YVxuICAgICAgICAgICAgY3VycmVudExpbWl0ID0gdG1wUmVzdWx0cy5sZW5ndGg7XG4gICAgICAgICAgICByZXN1bHRzLiRza2lwID0gY3VycmVudFNraXAgPSAocXJ5ICYmIHFyeS5za2lwKSA/IHFyeS5za2lwIDogMDtcbiAgICAgICAgICAgIGxhc3RCYXRjaFNpemUgPSBsYXN0QmF0Y2hTaXplIHx8IHRtcFJlc3VsdHMubGVuZ3RoO1xuICAgICAgICAgICAgX3BhZ2luZ09wdHMgPSBwYWdpbmdPcHRzO1xuICAgICAgICAgICAgcmVzdWx0cy5oYXNOZXh0ID0gKHBhZ2luZ09wdHMubmV4dCAhPSBudWxsKTtcbiAgICAgICAgICAgIHJlc3VsdHMuaGFzUHJldiA9IChwYWdpbmdPcHRzLnByZXYgIT0gbnVsbCk7XG5cbiAgICAgICAgICAgIC8vIERhdGEgaGFzIGNvbWUgYmFja1xuICAgICAgICAgICAgcmVzdWx0cy5sb2FkaW5nID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHJlc3VsdHMuJGVtaXR0ZXIuZW1pdCgndXBkYXRlJywgcmVzdWx0cyk7XG5cbiAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUocmVzdWx0cyk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBtYXliZU5ld1FyeUlkKF9xcnlJZCkge1xuICAgICAgICBpZiAocXJ5SWQgIT09IF9xcnlJZCkge1xuXG4gICAgICAgICAgdmFyIHFyeUxpc3Q7XG4gICAgICAgICAgaWYgKHFyeUlkKSB7XG4gICAgICAgICAgICAvLyBVcGRhdGUgdGhlIHFyeWxpc3QgKGRvIHdlIHdhbnQgdG8gZGVsZXRlIHRoZSBvbGQgb25lPylcbiAgICAgICAgICAgIHFyeUxpc3QgPSBfc2VydmVyUXVlcmllc1txcnlJZF0gPSB3aXRob3V0KF9zZXJ2ZXJRdWVyaWVzW3FyeUlkXSwgcmVzdWx0cyk7XG4gICAgICAgICAgICAvLyBJZiB0aGVyZSBhcmUgbm8gbWVtYmVycyBsZWZ0IGluIHRoZSBxdWVyeSBsaXN0IHRoZW4gZGVsZXRlIGl0XG4gICAgICAgICAgICBpZiAocXJ5TGlzdC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgZGVsZXRlIF9zZXJ2ZXJRdWVyaWVzW3FyeUlkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBNb3ZlIHRoZSByZXN1bHRzIHRvIHRoZSBuZXcgbGlzdFxuICAgICAgICAgIHFyeUlkID0gX3FyeUlkO1xuICAgICAgICAgIHFyeUxpc3QgPSBfc2VydmVyUXVlcmllc1txcnlJZF07XG4gICAgICAgICAgaWYgKCFxcnlMaXN0KSB7XG4gICAgICAgICAgICBxcnlMaXN0ID0gX3NlcnZlclF1ZXJpZXNbcXJ5SWRdID0gW107XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUHV0IHRoZSByZXN1bHRzIGludG8gdGhlIG5ldyBxdWVyeSBsaXN0XG4gICAgICAgICAgaWYgKCF+cXJ5TGlzdC5pbmRleE9mKHJlc3VsdHMpKSB7XG4gICAgICAgICAgICBxcnlMaXN0LnB1c2gocmVzdWx0cyk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHJlZnJlc2hRdWVyeShmb3JjZSkge1xuICAgICAgICB2YXIgcmVxID0gcXVlcnkocXJ5KTtcbiAgICAgICAgdmFyIHByb21pc2UgPSByZXEudGhlbihmdW5jdGlvbihyZXMpIHtcblxuICAgICAgICAgIC8vIElmIHdlIGdldCBubyByZXNwb25zZSAodGhlIGFwcCBjb3VsZCBiZSBvZmZsaW5lKSB0aGVuIGp1c3QgcmVzb2x2ZSB3aXRoXG4gICAgICAgICAgLy8gdGhlIGV4aXN0aW5nIHJlc3VsdHNcbiAgICAgICAgICBpZiAoYW5ndWxhci5pc1VuZGVmaW5lZChyZXMpKSB7XG4gICAgICAgICAgICByZXN1bHRzLmxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHZhciBfcXJ5SWQgPSByZXMucXJ5SWQ7XG4gICAgICAgICAgdmFyIHJlc3BvbnNlID0gcmVzLmRhdGE7XG5cbiAgICAgICAgICByZXR1cm4gbmV3RGF0YShfcXJ5SWQsIHJlc3BvbnNlLCBmb3JjZSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcmVwbGFjZShfcXJ5KSB7XG4gICAgICAgIC8vIERvIHRoZSBxdWVyeSBidXQgcmVwbGFjZSB0aGUgZXhpc3RpbmcgcXVlcnlcbiAgICAgICAgcmV0dXJuICRxLndoZW4oX3FyeSkudGhlbihub3JtYWxpemVRdWVyeSkudGhlbihmdW5jdGlvbihub3JtUXJ5KSB7XG5cbiAgICAgICAgICAvLyBXZSBhbGxvdyBhIHF1ZXJ5IHRvIHJlc29sdmUgdG8gc29tZXRoaW5nIGZhbHN5IC0gaW4gd2hpY2ggY2FzZSB3ZSBqdXN0XG4gICAgICAgICAgLy8gZHJvcCBpdFxuICAgICAgICAgIGlmICghbm9ybVFyeSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBxcnkudGhlbihmdW5jdGlvbihvbGRxcnkpIHtcbiAgICAgICAgICAgIGlmIChKU09OLnN0cmluZ2lmeShvbGRxcnkpICE9PSBKU09OLnN0cmluZ2lmeShub3JtUXJ5KSkge1xuICAgICAgICAgICAgICAvLyBxdWVyeSBpcyBkaWZmZXJlbnQgLSBjb250aW51ZVxuICAgICAgICAgICAgICB2YXIgcmVxID0gcXVlcnkobm9ybVFyeSwgcXJ5SWQpO1xuXG4gICAgICAgICAgICAgIHZhciBwcm9taXNlID0gcmVxLnRoZW4oZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgICAgICAgICAgLy8gSWYgd2UgZ2V0IG5vIHJlc3BvbnNlICh0aGUgYXBwIGNvdWxkIGJlIG9mZmxpbmUpIHRoZW4ganVzdCByZXNvbHZlIHdpdGhcbiAgICAgICAgICAgICAgICAvLyB0aGUgZXhpc3RpbmcgcmVzdWx0c1xuICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzVW5kZWZpbmVkKHJlcykpIHtcbiAgICAgICAgICAgICAgICAgIHJlc3VsdHMubG9hZGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy8gV2UgZG8gaGF2ZSBhIHJlc3BvbnNlLiBDb250aW51ZVxuICAgICAgICAgICAgICAgIHZhciBfcXJ5SWQgPSByZXMucXJ5SWQ7XG4gICAgICAgICAgICAgICAgdmFyIGRhdGEgPSByZXMuZGF0YTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBuZXdEYXRhKF9xcnlJZCwgZGF0YSk7XG4gICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgIHJldHVybiBwcm9taXNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBleHRlbmRSZXN1bHRzKG9iaiwgbm9TYW5pdGl6ZSkge1xuXG4gICAgICAgIC8vIFNhbml0aXplIHRoZSBvYmplY3RcbiAgICAgICAgaWYgKCFub1Nhbml0aXplKSB7XG4gICAgICAgICAgaWYgKG9iai5fcSkge1xuICAgICAgICAgICAgb2JqID0gb2JqLl9xO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvYmogPSB7ZmluZDogb2JqfTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcXJ5LnRoZW4oZnVuY3Rpb24ocmVzb2x2ZWQpIHtcbiAgICAgICAgICB2YXIgX3FyeSA9IGV4dGVuZFF1ZXJ5KHJlc29sdmVkLCBvYmopO1xuICAgICAgICAgIHJldHVybiByZXBsYWNlKF9xcnkpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gbmV4dChudW0pIHtcbiAgICAgICAgdmFyIHByb21pc2U7XG4gICAgICAgIHZhciBleHRlbmRTaXplO1xuICAgICAgICBpZiAoX3BhZ2luZ09wdHMubmV4dCkge1xuICAgICAgICAgIGxhc3RCYXRjaFNpemUgPSBleHRlbmRTaXplID0gbnVtIHx8IGxhc3RCYXRjaFNpemU7XG4gICAgICAgICAgdmFyIGV4dGVuZE9iaiA9IHtcbiAgICAgICAgICAgIGxpbWl0OiBjdXJyZW50TGltaXQgKyBleHRlbmRTaXplXG4gICAgICAgICAgfTtcbiAgICAgICAgICBwcm9taXNlID0gZXh0ZW5kUmVzdWx0cyhleHRlbmRPYmosIHRydWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZSgpO1xuICAgICAgICAgIHByb21pc2UgPSBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHByZXYobnVtKSB7XG4gICAgICAgIHZhciBwcm9taXNlO1xuICAgICAgICB2YXIgZXh0ZW5kU2l6ZTtcbiAgICAgICAgaWYgKF9wYWdpbmdPcHRzLnByZXYpIHtcbiAgICAgICAgICBsYXN0QmF0Y2hTaXplID0gZXh0ZW5kU2l6ZSA9IG51bSB8fCBsYXN0QmF0Y2hTaXplO1xuICAgICAgICAgIHZhciBleHRlbmRPYmogPSB7XG4gICAgICAgICAgICBza2lwOiBNYXRoLm1heChjdXJyZW50U2tpcCAtIGV4dGVuZFNpemUsIDApLFxuICAgICAgICAgICAgbGltaXQ6IGN1cnJlbnRMaW1pdCArIGV4dGVuZFNpemVcbiAgICAgICAgICB9O1xuICAgICAgICAgIHByb21pc2UgPSBleHRlbmRSZXN1bHRzKGV4dGVuZE9iaiwgdHJ1ZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKCk7XG4gICAgICAgICAgcHJvbWlzZSA9IGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gZ2V0KCkge1xuICAgICAgICByZXR1cm4gUmVzb3VyY2UuZ2V0LmFwcGx5KFJlc291cmNlLCBhcmd1bWVudHMpO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBjaGFpbihNb2RlbCwgcXJ5Rm4pIHtcbiAgICAgICAgcmV0dXJuIENoYWluKHJlc3VsdHMsIE1vZGVsLCBxcnlGbik7XG4gICAgICB9XG5cbiAgICAgIHJlc3VsdHMuJG5ld0RhdGEgPSBuZXdEYXRhO1xuICAgICAgcmVzdWx0cy4kcmVmcmVzaCA9IHJlZnJlc2hRdWVyeTtcbiAgICAgIHJlc3VsdHMuZXh0ZW5kID0gZXh0ZW5kUmVzdWx0cztcbiAgICAgIHJlc3VsdHMucmVwbGFjZSA9IHJlcGxhY2U7XG4gICAgICByZXN1bHRzLmdldCA9IGdldDtcbiAgICAgIHJlc3VsdHMubmV4dCA9IG5leHQ7XG4gICAgICByZXN1bHRzLnByZXYgPSBwcmV2O1xuICAgICAgcmVzdWx0cy4kcHJvbWlzZSA9IHJlZnJlc2hRdWVyeSgpLnRoZW4oZnVuY3Rpb24ocmVzKSB7XG4gICAgICAgIHJlc3VsdHMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgIH0pO1xuICAgICAgcmVzdWx0cy4kcmVzb2x2ZWQgPSBmYWxzZTtcbiAgICAgIHJlc3VsdHMuY2hhaW4gPSBjaGFpbjtcbiAgICAgIHJlc3VsdHMuJE1vZGVsID0gUmVzb3VyY2U7XG4gICAgICByZXN1bHRzLiRlbWl0dGVyID0gbmV3IGV2ZW50cy5FdmVudEVtaXR0ZXIoKTtcbiAgICAgIHJlc3VsdHMuJHNraXAgPSAwO1xuXG4gICAgICBxdWVyeVRyYW5zZm9ybXMuYXBwbHkocmVzdWx0cyk7XG5cbiAgICAgIHJldHVybiByZXN1bHRzO1xuICAgIH1cblxuICAgIHJldHVybiBkYiA/IExvY2FsUXVlcnlMaXN0IDogU2VydmVyUXVlcnlMaXN0O1xuICB9XG5cbiAgcmV0dXJuIFF1ZXJ5RmFjdG9yeTtcbn1cbiJdLCJzb3VyY2VSb290IjoiL3NvdXJjZS8ifQ==
