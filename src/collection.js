import ArrayEmitter from './array-emitter';
import isFunction from 'lodash.isfunction';
import isEqual from 'lodash.isequal';

// Recursively follows a property that links to the same model.
// For now rather obtusively just redraw from the seeds when anything changes.
export default function($q, $rootScope, Chain) {
  'ngInject';

  function Collection(Resource, seeds, relationOrQuery) {
    var nodes = new ArrayEmitter();
    var watches = [];
    var collecting = false;
    var recollect = false;

    var deferred = $q.defer();

    nodes.$promise = deferred.promise;
    nodes.$resolved = false;
    nodes.chain = chain;

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

      if (isFunction(relationOrQuery)) {
        return collectRecursiveByQuery(start);
      } else {
        return collectRecursiveByProp(start);
      }
    }

    function collectRecursiveByQuery(start) {
      var unseen = start.filter(model => !~nodes.indexOf(model));

      for (let model of unseen) {
        nodes.push(model);
      }

      return $q.resolve(relationOrQuery(unseen)).then(function(qry) {
        return Resource.query(qry).$promise.then(function(results) {
          // Listen for changes
          results.on('update', watchChanged);
          watches.push(function() {
            results.removeListener('update', watchChanged);
          });

          return collectRecursiveByQuery(results);
        });
      });
    }

    function collectRecursiveByProp(start) {
      var proms = [];
      var relation = relationOrQuery;
      start.forEach(function(model) {
        var deps = model[relation];

        // Don't do anything if we have seen this before
        if (!~nodes.indexOf(model)) {

          // Push this node, and watch it for changes
          nodes.push(model);
          var dereg = $rootScope.$watch(function() {
            return model[relation];
          }, watchChanged);
          watches.push(dereg);

          // If there are dependecies then go and fetch them
          if (deps && deps.length > 0) {
            var prom = Resource.get(deps).$promise;
            prom = prom.then(function(next) {
              return collectRecursiveByProp(next);
            });
            proms.push(prom);
          }
        }
      });

      return $q.all(proms);
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
