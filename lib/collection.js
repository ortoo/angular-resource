var events = require('events');
var queryTransforms = require('./query-transforms');

// Recursively follows a property that links to the same model.
// For now rather obtusively just redraw from the seeds when anything changes.
module.exports = angular.module('or2.resource')
  .factory('resource.collection', [
    '$q',
    '$rootScope',
    'resource.chain',
    function($q, $rootScope, Chain) {

      function Collection(Resource, seeds, relation) {
        var nodes = [];
        var watches = [];
        var collecting = false;
        var recollect = false;

        var deferred = $q.defer();

        nodes.$promise = deferred.promise;
        nodes.$resolved = false;
        nodes.$emitter = new events.EventEmitter();
        nodes.chain = chain;
        queryTransforms.apply(nodes);

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
          if (oldVal !== newVal) {
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
          var proms = [];
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
                  return collectRecursive(next);
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
  ]);
