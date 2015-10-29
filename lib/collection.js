'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _events = require('events');

var _events2 = _interopRequireDefault(_events);

var _queryTransforms = require('./query-transforms');

var queryTransforms = _interopRequireWildcard(_queryTransforms);

// Recursively follows a property that links to the same model.
// For now rather obtusively just redraw from the seeds when anything changes.

exports['default'] = function ($q, $rootScope, Chain) {
  'ngInject';

  function Collection(Resource, seeds, relation) {
    var nodes = [];
    var watches = [];
    var collecting = false;
    var recollect = false;

    var deferred = $q.defer();

    nodes.$promise = deferred.promise;
    nodes.$resolved = false;
    nodes.$emitter = new _events2['default'].EventEmitter();
    nodes.chain = chain;
    queryTransforms.apply(nodes);

    function chain(Model, qryFn) {
      return Chain(nodes, Model, qryFn);
    }

    function clear() {
      nodes.length = 0;
      watches.forEach(function (dereg) {
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
        collectRecursive(seeds).then(function () {
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
      start.forEach(function (model) {
        var deps = model[relation];

        // Don't do anything if we have seen this before
        if (! ~nodes.indexOf(model)) {

          // Push this node, and watch it for changes
          nodes.push(model);
          var dereg = $rootScope.$watch(function () {
            return model[relation];
          }, watchChanged);
          watches.push(dereg);

          // If there are dependecies then go and fetch them
          if (deps && deps.length > 0) {
            var prom = Resource.get(deps).$promise;
            prom = prom.then(function (next) {
              return collectRecursive(next);
            });
            proms.push(prom);
          }
        }
      });

      return $q.all(proms);
    }

    // Watch the seeds for changes
    $rootScope.$watchCollection(function () {
      return seeds;
    }, watchChanged);

    // Do an initial collection run
    runCollection();

    return nodes;
  }

  return Collection;
};

module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,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QyxRQUFRLENBQUMsQ0FBQztXQUN4QixFQUFFLFlBQVksQ0FBQyxDQUFDO0FBQ2pCLGlCQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDOzs7QUFHcEIsY0FBSSxJQUFJLElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7QUFDM0IsZ0JBQUksSUFBSSxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQ3ZDLGdCQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFTLElBQUksRUFBRTtBQUM5QixxQkFBTyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQzthQUMvQixDQUFDLENBQUM7QUFDSCxpQkFBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztXQUNsQjtTQUNGO09BQ0YsQ0FBQyxDQUFDOztBQUVILGFBQU8sRUFBRSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztLQUN0Qjs7O0FBR0QsY0FBVSxDQUFDLGdCQUFnQixDQUFDLFlBQVc7QUFDckMsYUFBTyxLQUFLLENBQUM7S0FDZCxFQUFFLFlBQVksQ0FBQyxDQUFDOzs7QUFHakIsaUJBQWEsRUFBRSxDQUFDOztBQUVoQixXQUFPLEtBQUssQ0FBQztHQUNkOztBQUVELFNBQU8sVUFBVSxDQUFDO0NBQ25CIiwiZmlsZSI6ImNvbGxlY3Rpb24uanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZXZlbnRzIGZyb20gJ2V2ZW50cyc7XG5pbXBvcnQgKiBhcyBxdWVyeVRyYW5zZm9ybXMgZnJvbSAnLi9xdWVyeS10cmFuc2Zvcm1zJztcblxuLy8gUmVjdXJzaXZlbHkgZm9sbG93cyBhIHByb3BlcnR5IHRoYXQgbGlua3MgdG8gdGhlIHNhbWUgbW9kZWwuXG4vLyBGb3Igbm93IHJhdGhlciBvYnR1c2l2ZWx5IGp1c3QgcmVkcmF3IGZyb20gdGhlIHNlZWRzIHdoZW4gYW55dGhpbmcgY2hhbmdlcy5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uKCRxLCAkcm9vdFNjb3BlLCBDaGFpbikge1xuICAnbmdJbmplY3QnO1xuXG4gIGZ1bmN0aW9uIENvbGxlY3Rpb24oUmVzb3VyY2UsIHNlZWRzLCByZWxhdGlvbikge1xuICAgIHZhciBub2RlcyA9IFtdO1xuICAgIHZhciB3YXRjaGVzID0gW107XG4gICAgdmFyIGNvbGxlY3RpbmcgPSBmYWxzZTtcbiAgICB2YXIgcmVjb2xsZWN0ID0gZmFsc2U7XG5cbiAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuXG4gICAgbm9kZXMuJHByb21pc2UgPSBkZWZlcnJlZC5wcm9taXNlO1xuICAgIG5vZGVzLiRyZXNvbHZlZCA9IGZhbHNlO1xuICAgIG5vZGVzLiRlbWl0dGVyID0gbmV3IGV2ZW50cy5FdmVudEVtaXR0ZXIoKTtcbiAgICBub2Rlcy5jaGFpbiA9IGNoYWluO1xuICAgIHF1ZXJ5VHJhbnNmb3Jtcy5hcHBseShub2Rlcyk7XG5cbiAgICBmdW5jdGlvbiBjaGFpbihNb2RlbCwgcXJ5Rm4pIHtcbiAgICAgIHJldHVybiBDaGFpbihub2RlcywgTW9kZWwsIHFyeUZuKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjbGVhcigpIHtcbiAgICAgIG5vZGVzLmxlbmd0aCA9IDA7XG4gICAgICB3YXRjaGVzLmZvckVhY2goZnVuY3Rpb24oZGVyZWcpIHtcbiAgICAgICAgZGVyZWcoKTtcbiAgICAgIH0pO1xuICAgICAgd2F0Y2hlcyA9IFtdO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHdhdGNoQ2hhbmdlZChuZXdWYWwsIG9sZFZhbCkge1xuICAgICAgaWYgKG9sZFZhbCAhPT0gbmV3VmFsKSB7XG4gICAgICAgIHJ1bkNvbGxlY3Rpb24oKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW5Db2xsZWN0aW9uKCkge1xuICAgICAgaWYgKCFjb2xsZWN0aW5nKSB7XG4gICAgICAgIHJlY29sbGVjdCA9IGZhbHNlO1xuICAgICAgICBjb2xsZWN0aW5nID0gdHJ1ZTtcbiAgICAgICAgY2xlYXIoKTtcbiAgICAgICAgY29sbGVjdFJlY3Vyc2l2ZShzZWVkcykudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICBjb2xsZWN0aW5nID0gZmFsc2U7XG5cbiAgICAgICAgICBpZiAocmVjb2xsZWN0KSB7XG4gICAgICAgICAgICBydW5Db2xsZWN0aW9uKCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIE5vdGlmeSB0aGF0IHdlJ3ZlIHVwZGF0ZWQgYW5kIHNldHRsZWRcbiAgICAgICAgICAgIG5vZGVzLiRlbWl0dGVyLmVtaXQoJ3VwZGF0ZScsIG5vZGVzKTtcblxuICAgICAgICAgICAgaWYgKCFub2Rlcy4kcmVzb2x2ZWQpIHtcbiAgICAgICAgICAgICAgbm9kZXMuJHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShub2Rlcyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFdlJ3JlIHJ1bm5pbmcgLSByZXJ1biBvbmNlIHdlIGFyZSBkb25lXG4gICAgICAgIHJlY29sbGVjdCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY29sbGVjdFJlY3Vyc2l2ZShzdGFydCkge1xuICAgICAgdmFyIHByb21zID0gW107XG4gICAgICBzdGFydC5mb3JFYWNoKGZ1bmN0aW9uKG1vZGVsKSB7XG4gICAgICAgIHZhciBkZXBzID0gbW9kZWxbcmVsYXRpb25dO1xuXG4gICAgICAgIC8vIERvbid0IGRvIGFueXRoaW5nIGlmIHdlIGhhdmUgc2VlbiB0aGlzIGJlZm9yZVxuICAgICAgICBpZiAoIX5ub2Rlcy5pbmRleE9mKG1vZGVsKSkge1xuXG4gICAgICAgICAgLy8gUHVzaCB0aGlzIG5vZGUsIGFuZCB3YXRjaCBpdCBmb3IgY2hhbmdlc1xuICAgICAgICAgIG5vZGVzLnB1c2gobW9kZWwpO1xuICAgICAgICAgIHZhciBkZXJlZyA9ICRyb290U2NvcGUuJHdhdGNoKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgcmV0dXJuIG1vZGVsW3JlbGF0aW9uXTtcbiAgICAgICAgICB9LCB3YXRjaENoYW5nZWQpO1xuICAgICAgICAgIHdhdGNoZXMucHVzaChkZXJlZyk7XG5cbiAgICAgICAgICAvLyBJZiB0aGVyZSBhcmUgZGVwZW5kZWNpZXMgdGhlbiBnbyBhbmQgZmV0Y2ggdGhlbVxuICAgICAgICAgIGlmIChkZXBzICYmIGRlcHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgdmFyIHByb20gPSBSZXNvdXJjZS5nZXQoZGVwcykuJHByb21pc2U7XG4gICAgICAgICAgICBwcm9tID0gcHJvbS50aGVuKGZ1bmN0aW9uKG5leHQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvbGxlY3RSZWN1cnNpdmUobmV4dCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHByb21zLnB1c2gocHJvbSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuICRxLmFsbChwcm9tcyk7XG4gICAgfVxuXG4gICAgLy8gV2F0Y2ggdGhlIHNlZWRzIGZvciBjaGFuZ2VzXG4gICAgJHJvb3RTY29wZS4kd2F0Y2hDb2xsZWN0aW9uKGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIHNlZWRzO1xuICAgIH0sIHdhdGNoQ2hhbmdlZCk7XG5cbiAgICAvLyBEbyBhbiBpbml0aWFsIGNvbGxlY3Rpb24gcnVuXG4gICAgcnVuQ29sbGVjdGlvbigpO1xuXG4gICAgcmV0dXJuIG5vZGVzO1xuICB9XG5cbiAgcmV0dXJuIENvbGxlY3Rpb247XG59XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
