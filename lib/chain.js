'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

exports['default'] = function ($q) {
  'ngInject';

  // Chain a query into a new one (when the query updates so does the new query)
  function Chain(origQry, Model, qryFn) {
    var initialSync = false;

    if (!qryFn) {
      qryFn = Model;
      Model = origQry.$Model;
    }

    // Make sure we have at least finished an initial load before generating the
    // query object
    var _qry = origQry.$promise.then(function () {
      initialSync = true;
      return qryFn(origQry);
    });
    var newqry = Model.query(_qry);

    // Watch our results. If they change then reattempt the query
    origQry.$emitter.on('update', function (newRes) {
      // Only do this if we have initially synced
      if (initialSync) {
        newqry.replace(qryFn(newRes));
      }
    });

    return newqry;
  }

  function all(origQueries, Model, qryFn) {
    var newqry;
    var proms = [];
    var initialSync;
    var allqries;
    origQueries.forEach(function (origQry) {
      proms.push(origQry.$promise);
      origQry.$emitter.on('update', function () {
        if (initialSync) {
          newqry.replace(qryFn(allqries));
        }
      });
    });

    newqry = Model.query($q.all(proms).then(function (res) {
      initialSync = true;
      allqries = res;
      return qryFn(res);
    }));

    return newqry;
  }

  Chain.all = all;

  return Chain;
};

;
module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNoYWluLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztxQkFBZSxVQUFTLEVBQUUsRUFBRTtBQUMxQixZQUFVLENBQUM7OztBQUdYLFdBQVMsS0FBSyxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFO0FBQ3BDLFFBQUksV0FBVyxHQUFHLEtBQUssQ0FBQzs7QUFFeEIsUUFBSSxDQUFDLEtBQUssRUFBRTtBQUNWLFdBQUssR0FBRyxLQUFLLENBQUM7QUFDZCxXQUFLLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQztLQUN4Qjs7OztBQUlELFFBQUksSUFBSSxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLFlBQVc7QUFDMUMsaUJBQVcsR0FBRyxJQUFJLENBQUM7QUFDbkIsYUFBTyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7S0FDdkIsQ0FBQyxDQUFDO0FBQ0gsUUFBSSxNQUFNLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQzs7O0FBRy9CLFdBQU8sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLFFBQVEsRUFBRSxVQUFTLE1BQU0sRUFBRTs7QUFFN0MsVUFBSSxXQUFXLEVBQUU7QUFDZixjQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO09BQy9CO0tBQ0YsQ0FBQyxDQUFDOztBQUVILFdBQU8sTUFBTSxDQUFDO0dBQ2Y7O0FBRUQsV0FBUyxHQUFHLENBQUMsV0FBVyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUU7QUFDdEMsUUFBSSxNQUFNLENBQUM7QUFDWCxRQUFJLEtBQUssR0FBRyxFQUFFLENBQUM7QUFDZixRQUFJLFdBQVcsQ0FBQztBQUNoQixRQUFJLFFBQVEsQ0FBQztBQUNiLGVBQVcsQ0FBQyxPQUFPLENBQUMsVUFBUyxPQUFPLEVBQUU7QUFDcEMsV0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDN0IsYUFBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsUUFBUSxFQUFFLFlBQVc7QUFDdkMsWUFBSSxXQUFXLEVBQUU7QUFDZixnQkFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztTQUNqQztPQUNGLENBQUMsQ0FBQztLQUNKLENBQUMsQ0FBQzs7QUFFSCxVQUFNLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFTLEdBQUcsRUFBRTtBQUNwRCxpQkFBVyxHQUFHLElBQUksQ0FBQztBQUNuQixjQUFRLEdBQUcsR0FBRyxDQUFDO0FBQ2YsYUFBTyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7S0FDbkIsQ0FBQyxDQUFDLENBQUM7O0FBRUosV0FBTyxNQUFNLENBQUM7R0FDZjs7QUFFRCxPQUFLLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQzs7QUFFaEIsU0FBTyxLQUFLLENBQUM7Q0FDZDs7QUFBQSxDQUFDIiwiZmlsZSI6ImNoYWluLmpzIiwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24oJHEpIHtcbiAgJ25nSW5qZWN0JztcblxuICAvLyBDaGFpbiBhIHF1ZXJ5IGludG8gYSBuZXcgb25lICh3aGVuIHRoZSBxdWVyeSB1cGRhdGVzIHNvIGRvZXMgdGhlIG5ldyBxdWVyeSlcbiAgZnVuY3Rpb24gQ2hhaW4ob3JpZ1FyeSwgTW9kZWwsIHFyeUZuKSB7XG4gICAgdmFyIGluaXRpYWxTeW5jID0gZmFsc2U7XG5cbiAgICBpZiAoIXFyeUZuKSB7XG4gICAgICBxcnlGbiA9IE1vZGVsO1xuICAgICAgTW9kZWwgPSBvcmlnUXJ5LiRNb2RlbDtcbiAgICB9XG5cbiAgICAvLyBNYWtlIHN1cmUgd2UgaGF2ZSBhdCBsZWFzdCBmaW5pc2hlZCBhbiBpbml0aWFsIGxvYWQgYmVmb3JlIGdlbmVyYXRpbmcgdGhlXG4gICAgLy8gcXVlcnkgb2JqZWN0XG4gICAgdmFyIF9xcnkgPSBvcmlnUXJ5LiRwcm9taXNlLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICBpbml0aWFsU3luYyA9IHRydWU7XG4gICAgICByZXR1cm4gcXJ5Rm4ob3JpZ1FyeSk7XG4gICAgfSk7XG4gICAgdmFyIG5ld3FyeSA9IE1vZGVsLnF1ZXJ5KF9xcnkpO1xuXG4gICAgLy8gV2F0Y2ggb3VyIHJlc3VsdHMuIElmIHRoZXkgY2hhbmdlIHRoZW4gcmVhdHRlbXB0IHRoZSBxdWVyeVxuICAgIG9yaWdRcnkuJGVtaXR0ZXIub24oJ3VwZGF0ZScsIGZ1bmN0aW9uKG5ld1Jlcykge1xuICAgICAgLy8gT25seSBkbyB0aGlzIGlmIHdlIGhhdmUgaW5pdGlhbGx5IHN5bmNlZFxuICAgICAgaWYgKGluaXRpYWxTeW5jKSB7XG4gICAgICAgIG5ld3FyeS5yZXBsYWNlKHFyeUZuKG5ld1JlcykpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIG5ld3FyeTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFsbChvcmlnUXVlcmllcywgTW9kZWwsIHFyeUZuKSB7XG4gICAgdmFyIG5ld3FyeTtcbiAgICB2YXIgcHJvbXMgPSBbXTtcbiAgICB2YXIgaW5pdGlhbFN5bmM7XG4gICAgdmFyIGFsbHFyaWVzO1xuICAgIG9yaWdRdWVyaWVzLmZvckVhY2goZnVuY3Rpb24ob3JpZ1FyeSkge1xuICAgICAgcHJvbXMucHVzaChvcmlnUXJ5LiRwcm9taXNlKTtcbiAgICAgIG9yaWdRcnkuJGVtaXR0ZXIub24oJ3VwZGF0ZScsIGZ1bmN0aW9uKCkge1xuICAgICAgICBpZiAoaW5pdGlhbFN5bmMpIHtcbiAgICAgICAgICBuZXdxcnkucmVwbGFjZShxcnlGbihhbGxxcmllcykpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIG5ld3FyeSA9IE1vZGVsLnF1ZXJ5KCRxLmFsbChwcm9tcykudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICAgIGluaXRpYWxTeW5jID0gdHJ1ZTtcbiAgICAgIGFsbHFyaWVzID0gcmVzO1xuICAgICAgcmV0dXJuIHFyeUZuKHJlcyk7XG4gICAgfSkpO1xuXG4gICAgcmV0dXJuIG5ld3FyeTtcbiAgfVxuXG4gIENoYWluLmFsbCA9IGFsbDtcblxuICByZXR1cm4gQ2hhaW47XG59O1xuIl0sInNvdXJjZVJvb3QiOiIvc291cmNlLyJ9
