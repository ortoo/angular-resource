import clone from 'lodash.clone';
import isEmpty from 'lodash.isempty';
import pluck from 'lodash.pluck';
import union from 'lodash.union';
import angular from 'angular';

import ArrayEmitter from './array-emitter.js';

function normalizeQuery(qry) {
  if (!qry) {
    return;
  }

  if (qry._q) {
    return qry._q;
  } else if (qry.find) {
    return qry;
  } else {
    return {find: qry};
  }
}

function extendQuery(qry1, qry2) {
  // Calc the new query that we want
  var _qry = clone(qry1, true);
  ['limit', 'skip', 'sort'].forEach(function(prop) {
    if (qry2[prop]) {
      _qry[prop] = qry2[prop];
    }
  });

  if (!isEmpty(qry2.find)) {
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
      _qry.find = clone(_qry.find);
    } else {
      _qry.find = {$or: [_qry.find]};
    }

    _qry.find.$or.push(qry2.find);
  }

  return _qry;
}

export default function($rootScope, $q, $timeout, $injector, Chain) {
  'ngInject';

  function QueryFactory(url, rootKey, rootKeyPlural, db) {
    var socket = $injector.get('socket');
    var sock = socket(url, rootKey, rootKeyPlural);

    // Object holding queries (keys are the query ids, values are arrays of arrays)
    var _localQueries = [];

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
      qry = $q.when(qry).then(normalizeQuery).then(function(_qry) {
        if (limit) {
          _qry.limit = limit;
        }
        return _qry;
      });

      // Generate the ServerQuery. We do this so we have something to fall back on
      // and also so that we will (or should!) get notified of changes from the server if
      // someone else creates or removes something that should go in these results
      var serverResults = ServerQueryList(qry, limit, Resource);

      var results = new ArrayEmitter();
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
          serverResults.forEach(function(res) {
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

        fallback = !db.qryIsSimple(_qry);

        // If we are fallingback then just resolve with our results. The server should
        // do the rest.
        if (fallback) {
          // We want to return the server's promise here so that people will be notified
          // when the results are actually loaded
          var prom;
          if (!serverResults.$resolved) {
            prom = serverResults.$promise.then(function() {
              return results;
            });
          } else {
            prom = $q.when(results);
          }

          return prom;
        }

        return db.query(_qry).then(function(ids) {

          // We can set the hasNext and hasPrev values to true here if we know there
          // are some. However only the server has the definitive ability to say
          // there arent any
          results.$hasNext = false;
          results.$hasPrev = false;
          if (limit && ids.length > limit) {
            // We have more results to fetch
            results.hasNext = true;
            results.$hasNext = true;

            // Trim the results down to size
            ids.length -= 1;
          }

          var skip = _qry.skip;

          if (skip) {
            results.hasPrev = true;
            results.$hasPrev = true;
          }

          // Calculate paging options
          currentLimit = ids.length;
          currentSkip = skip || 0;
          lastBatchSize = lastBatchSize || ids.length;

          // Go to resource types
          var tmpResults = ids.map(toRes);

          // Do we need to do a transform?
          var rprom;
          if (angular.isFunction(results.transform)) {
            rprom = $q.when(results.transform(tmpResults));
          } else {
            rprom = $q.when(tmpResults);
          }

          return rprom.then(function(transformed) {
            // Put the resources into the list
            var old = results.slice();
            results.length = 0;
            transformed.forEach(function(res) {
              results.push(res);
            });

            results.$emitter.emit('update', results, old);

            return results;
          });
        });

      }

      function refreshQuery(forceServer) {
        // Perform our query
        var prom = qry.then(query).then(function(res) {
          // If we don't have any results then maybe wait for the server to return
          if ((res.length === 0 && !serverResults.$resolved)) {
            return serverResults.$promise.then(function() {
              return refreshQuery();
            });
          } else {
            return res;
          }
        });

        if (forceServer) {
          prom = serverResults.$refresh(true);
        }

        return prom.then(function(res) {
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
            obj = {find: obj};
          }
        }

        return qry.then(function(resolved) {
          var _qry = extendQuery(resolved, obj);
          return replace(_qry, retServer);
        });
      }

      function replace(_qry, retServer) {
        // Sync down to the serverquery
        var serverProm = serverResults.replace(_qry);

        // Do the query but replace the existing query
        var localProm = $q.when(_qry).then(normalizeQuery).then(function(normQry) {

          // We allow a query to resolve to something falsy - in which case we just
          // drop it
          if (!normQry) {
            return;
          }

          return qry.then(function(oldqry) {
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

      results.$refresh = refreshQuery;
      results.extend = extendResults;
      results.replace = replace;
      results.get = get;
      results.next = next;
      results.prev = prev;
      results.$promise = refreshQuery();
      results.chain = chain;
      results.$Model = Resource;
      results.$serverResults = serverResults;

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
        _localQueries.forEach(function(res) {
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
      qry = $q.when(qry).then(normalizeQuery).then(function(_qry) {
        if (limit) {
          _qry.limit = limit;
        }
        return _qry;
      });

      var emitPromise = null;
      var results = new ArrayEmitter();
      var currentLimit = 0;
      var currentSkip = 0;
      var lastBatchSize = 0;
      var _pagingOpts = {};

      results.loading = true;


      function query(data) {
        // We only want to do one emit at a time (otherwise we could get into a bad state)
        if (angular.isFunction(data)) {
          data = data();
        }

        // Store off the query - make sure its a promise
        qry = $q.when(data);

        return qry.then(function(data) {
          // If we have an existing emitPromise then wait for it to resolve before we run
          var promise;
          if (emitPromise) {
            promise = emitPromise.then(function() {
              return sock.query(data);
            });
          } else {
            emitPromise = promise = sock.query(data);
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

        // So far we've only got the ids of the qry result - go and fetch the actual objects.
        // This mechanism saves bandwidth by only getting the object data once then listening
        // for changes to it
        //
        // If we are forcing we want to get both the old and new ids to check for any changes
        // deletions etc..
        var getIds = ids;
        if (force) {
          var oldIds = pluck(results, '_id');
          getIds = union(ids, oldIds);
        }

        Resource.get(getIds, force).$promise.then(function(ress) {
          var ressmap = {};
          ress.forEach(function(res) {
            ressmap[res._id] = res;
          });

          // We don't allow repeated ids so just iterate over the results
          var tmpResults = [];
          ids.forEach(function(id) {
            tmpResults.push(ressmap[id]);
          });

          // Do we need to do a transform?
          var rprom;
          if (angular.isFunction(results.transform)) {
            rprom = $q.when(results.transform(tmpResults));
          } else {
            rprom = $q.when(tmpResults);
          }

          return rprom.then(function(transformed) {

            results.length = 0;
            transformed.forEach(function(res) {
              results.push(res);
            });

            // Since we now have data in our array store off limit data
            currentLimit = tmpResults.length;
            results.$skip = currentSkip = (qry && qry.skip) ? qry.skip : 0;
            lastBatchSize = lastBatchSize || tmpResults.length;
            _pagingOpts = pagingOpts;
            results.hasNext = (pagingOpts.next != null);
            results.hasPrev = (pagingOpts.prev != null);

            // Data has come back
            results.loading = false;

            results.$emitter.emit('update', results);

            deferred.resolve(results);
          });
        });

        return deferred.promise;
      }

      function refreshQuery(force) {
        var req = query(qry);
        var promise = req.then(function(res) {

          // If we get no response (the app could be offline) then just resolve with
          // the existing results
          if (angular.isUndefined(res)) {
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
        return $q.when(_qry).then(normalizeQuery).then(function(normQry) {

          // We allow a query to resolve to something falsy - in which case we just
          // drop it
          if (!normQry) {
            return;
          }

          return qry.then(function(oldqry) {
            if (JSON.stringify(oldqry) !== JSON.stringify(normQry)) {
              // query is different - continue
              var req = query(normQry);

              var promise = req.then(function(res) {
                // If we get no response (the app could be offline) then just resolve with
                // the existing results
                if (angular.isUndefined(res)) {
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
            obj = {find: obj};
          }
        }

        return qry.then(function(resolved) {
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
      results.$promise = refreshQuery().then(function(res) {
        results.$resolved = true;
        return res;
      });
      results.$resolved = false;
      results.chain = chain;
      results.$Model = Resource;
      results.$skip = 0;

      return results;
    }

    return db ? LocalQueryList : ServerQueryList;
  }

  return QueryFactory;
}
