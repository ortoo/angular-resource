import ArrayEmitter from './array-emitter';
import isEqual from 'lodash.isequal';

import angular from 'angular';

const isFunction = angular.isFunction;
const isString = angular.isString;

// Recursively follows a property that links to the same model.
// For now rather obtusively just redraw from the seeds when anything changes.
export default function($q, $rootScope, Chain) {
  'ngInject';

  function Collection(Resource, seeds, searcher) {
    var nodes = new ArrayEmitter();
    var watches = [];
    var collecting = false;
    var recollect = false;

    var deferred = $q.defer();

    nodes.$promise = deferred.promise;
    nodes.$resolved = false;
    nodes.chain = chain;

    if (!isFunction(searcher)) {
      searcher = propSearcher(searcher);
    }

    function chain(Model, qryFn) {
      return Chain(nodes, Model, qryFn);
    }

    function clear() {
      nodes.length = 0;
      watches.forEach(function(dereg) {
        dereg();
      });
      watches = [];
    }

    function watchChanged(newVal, oldVal) {
      if (!isEqual(oldVal, newVal)) {
        runCollection();
      }
    }

    function runCollection() {
      if (!collecting) {
        recollect = false;
        collecting = true;
        clear();
        collectRecursive(seeds).then(function() {
          collecting = false;

          if (recollect) {
            runCollection();
          } else {
            // Notify that we've updated and settled
            nodes.$emitter.emit('update', nodes);

            if (!nodes.$resolved) {
              nodes.$resolved = true;
              deferred.resolve(nodes);
            }
          }
        });
      } else {
        // We're running - rerun once we are done
        recollect = true;
      }
    }

    function collectRecursive(start) {
      if (!Array.isArray(start)) {
        start = [start];
      }

      var unseen = start.filter(model => !~nodes.indexOf(model));

      if (unseen.length === 0) {
        return $q.resolve();
      }

      for (let model of unseen) {
        nodes.push(model);
      }

      var origSearcherRes = searcher(unseen);

      return $q.resolve(origSearcherRes).then(function(result) {
        // Result could either be an array of ids, or the objects themselves
        if (result && isString(result[0])) {
          // Ids
          return Resource.get(result).$promise;
        } else {
          return $q.resolve(result);
        }
      }).then(function(results) {
        // If our result array is an event emitter then we listen on the update event,
        // if it's been produced synchronously then put a watch on.
        if (isFunction(results.on)) {
          results.on('update', watchChanged);
          watches.push(function() {
            results.removeListener('update', watchChanged);
          });
        } else if (Array.isArray(origSearcherRes)) {
          var dereg = $rootScope.$watchCollection(function() {
            return searcher(unseen);
          }, watchChanged);
          watches.push(dereg);
        }

        return collectRecursive(results);
      });
    }

    function propSearcher(prop) {
      return function searcher(models) {
        return models.reduce(function (arr, model) {
          return arr.concat(model[prop] || []);
        }, []);
      };
    }

    // Watch the seeds for changes
    $rootScope.$watchCollection(function() {
      return seeds;
    }, watchChanged);

    // Do an initial collection run
    runCollection();

    return nodes;
  }

  return Collection;
}
