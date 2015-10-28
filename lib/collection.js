'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _events = require('events');

var _events2 = _interopRequireDefault(_events);

var _queryTransforms = require('./query-transforms');

var _queryTransforms2 = _interopRequireDefault(_queryTransforms);

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
    _queryTransforms2['default'].apply(nodes);

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
//# sourceMappingURL=data:application/json;base64,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QztXQUN4QixFQUFFLFlBQVksQ0FBQyxDQUFDO0FBQ2pCLGlCQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDOzs7QUFHcEIsY0FBSSxJQUFJLElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7QUFDM0IsZ0JBQUksSUFBSSxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQ3ZDLGdCQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFTLElBQUksRUFBRTtBQUM5QixxQkFBTyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQzthQUMvQixDQUFDLENBQUM7QUFDSCxpQkFBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztXQUNsQjtTQUNGO09BQ0YsQ0FBQyxDQUFDOztBQUVILGFBQU8sRUFBRSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztLQUN0Qjs7O0FBR0QsY0FBVSxDQUFDLGdCQUFnQixDQUFDLFlBQVc7QUFDckMsYUFBTyxLQUFLLENBQUM7S0FDZCxFQUFFLFlBQVksQ0FBQyxDQUFDOzs7QUFHakIsaUJBQWEsRUFBRSxDQUFDOztBQUVoQixXQUFPLEtBQUssQ0FBQztHQUNkOztBQUVELFNBQU8sVUFBVSxDQUFDO0NBQ25CIiwiZmlsZSI6ImNvbGxlY3Rpb24uanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZXZlbnRzIGZyb20gJ2V2ZW50cyc7XG5pbXBvcnQgcXVlcnlUcmFuc2Zvcm1zIGZyb20gJy4vcXVlcnktdHJhbnNmb3Jtcyc7XG5cbi8vIFJlY3Vyc2l2ZWx5IGZvbGxvd3MgYSBwcm9wZXJ0eSB0aGF0IGxpbmtzIHRvIHRoZSBzYW1lIG1vZGVsLlxuLy8gRm9yIG5vdyByYXRoZXIgb2J0dXNpdmVseSBqdXN0IHJlZHJhdyBmcm9tIHRoZSBzZWVkcyB3aGVuIGFueXRoaW5nIGNoYW5nZXMuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbigkcSwgJHJvb3RTY29wZSwgQ2hhaW4pIHtcbiAgJ25nSW5qZWN0JztcblxuICBmdW5jdGlvbiBDb2xsZWN0aW9uKFJlc291cmNlLCBzZWVkcywgcmVsYXRpb24pIHtcbiAgICB2YXIgbm9kZXMgPSBbXTtcbiAgICB2YXIgd2F0Y2hlcyA9IFtdO1xuICAgIHZhciBjb2xsZWN0aW5nID0gZmFsc2U7XG4gICAgdmFyIHJlY29sbGVjdCA9IGZhbHNlO1xuXG4gICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcblxuICAgIG5vZGVzLiRwcm9taXNlID0gZGVmZXJyZWQucHJvbWlzZTtcbiAgICBub2Rlcy4kcmVzb2x2ZWQgPSBmYWxzZTtcbiAgICBub2Rlcy4kZW1pdHRlciA9IG5ldyBldmVudHMuRXZlbnRFbWl0dGVyKCk7XG4gICAgbm9kZXMuY2hhaW4gPSBjaGFpbjtcbiAgICBxdWVyeVRyYW5zZm9ybXMuYXBwbHkobm9kZXMpO1xuXG4gICAgZnVuY3Rpb24gY2hhaW4oTW9kZWwsIHFyeUZuKSB7XG4gICAgICByZXR1cm4gQ2hhaW4obm9kZXMsIE1vZGVsLCBxcnlGbik7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2xlYXIoKSB7XG4gICAgICBub2Rlcy5sZW5ndGggPSAwO1xuICAgICAgd2F0Y2hlcy5mb3JFYWNoKGZ1bmN0aW9uKGRlcmVnKSB7XG4gICAgICAgIGRlcmVnKCk7XG4gICAgICB9KTtcbiAgICAgIHdhdGNoZXMgPSBbXTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiB3YXRjaENoYW5nZWQobmV3VmFsLCBvbGRWYWwpIHtcbiAgICAgIGlmIChvbGRWYWwgIT09IG5ld1ZhbCkge1xuICAgICAgICBydW5Db2xsZWN0aW9uKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcnVuQ29sbGVjdGlvbigpIHtcbiAgICAgIGlmICghY29sbGVjdGluZykge1xuICAgICAgICByZWNvbGxlY3QgPSBmYWxzZTtcbiAgICAgICAgY29sbGVjdGluZyA9IHRydWU7XG4gICAgICAgIGNsZWFyKCk7XG4gICAgICAgIGNvbGxlY3RSZWN1cnNpdmUoc2VlZHMpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgY29sbGVjdGluZyA9IGZhbHNlO1xuXG4gICAgICAgICAgaWYgKHJlY29sbGVjdCkge1xuICAgICAgICAgICAgcnVuQ29sbGVjdGlvbigpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBOb3RpZnkgdGhhdCB3ZSd2ZSB1cGRhdGVkIGFuZCBzZXR0bGVkXG4gICAgICAgICAgICBub2Rlcy4kZW1pdHRlci5lbWl0KCd1cGRhdGUnLCBub2Rlcyk7XG5cbiAgICAgICAgICAgIGlmICghbm9kZXMuJHJlc29sdmVkKSB7XG4gICAgICAgICAgICAgIG5vZGVzLiRyZXNvbHZlZCA9IHRydWU7XG4gICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUobm9kZXMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBXZSdyZSBydW5uaW5nIC0gcmVydW4gb25jZSB3ZSBhcmUgZG9uZVxuICAgICAgICByZWNvbGxlY3QgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNvbGxlY3RSZWN1cnNpdmUoc3RhcnQpIHtcbiAgICAgIHZhciBwcm9tcyA9IFtdO1xuICAgICAgc3RhcnQuZm9yRWFjaChmdW5jdGlvbihtb2RlbCkge1xuICAgICAgICB2YXIgZGVwcyA9IG1vZGVsW3JlbGF0aW9uXTtcblxuICAgICAgICAvLyBEb24ndCBkbyBhbnl0aGluZyBpZiB3ZSBoYXZlIHNlZW4gdGhpcyBiZWZvcmVcbiAgICAgICAgaWYgKCF+bm9kZXMuaW5kZXhPZihtb2RlbCkpIHtcblxuICAgICAgICAgIC8vIFB1c2ggdGhpcyBub2RlLCBhbmQgd2F0Y2ggaXQgZm9yIGNoYW5nZXNcbiAgICAgICAgICBub2Rlcy5wdXNoKG1vZGVsKTtcbiAgICAgICAgICB2YXIgZGVyZWcgPSAkcm9vdFNjb3BlLiR3YXRjaChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHJldHVybiBtb2RlbFtyZWxhdGlvbl07XG4gICAgICAgICAgfSwgd2F0Y2hDaGFuZ2VkKTtcbiAgICAgICAgICB3YXRjaGVzLnB1c2goZGVyZWcpO1xuXG4gICAgICAgICAgLy8gSWYgdGhlcmUgYXJlIGRlcGVuZGVjaWVzIHRoZW4gZ28gYW5kIGZldGNoIHRoZW1cbiAgICAgICAgICBpZiAoZGVwcyAmJiBkZXBzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHZhciBwcm9tID0gUmVzb3VyY2UuZ2V0KGRlcHMpLiRwcm9taXNlO1xuICAgICAgICAgICAgcHJvbSA9IHByb20udGhlbihmdW5jdGlvbihuZXh0KSB7XG4gICAgICAgICAgICAgIHJldHVybiBjb2xsZWN0UmVjdXJzaXZlKG5leHQpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBwcm9tcy5wdXNoKHByb20pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiAkcS5hbGwocHJvbXMpO1xuICAgIH1cblxuICAgIC8vIFdhdGNoIHRoZSBzZWVkcyBmb3IgY2hhbmdlc1xuICAgICRyb290U2NvcGUuJHdhdGNoQ29sbGVjdGlvbihmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBzZWVkcztcbiAgICB9LCB3YXRjaENoYW5nZWQpO1xuXG4gICAgLy8gRG8gYW4gaW5pdGlhbCBjb2xsZWN0aW9uIHJ1blxuICAgIHJ1bkNvbGxlY3Rpb24oKTtcblxuICAgIHJldHVybiBub2RlcztcbiAgfVxuXG4gIHJldHVybiBDb2xsZWN0aW9uO1xufVxuIl0sInNvdXJjZVJvb3QiOiIvc291cmNlLyJ9
