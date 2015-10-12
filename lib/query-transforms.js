module.exports.apply = apply;

var ArrayProto = Array.prototype;

// Make the standard ES5 array transformations work as expected...
function apply(qry) {

  // These methods create new arrays
  ['filter', 'map', 'slice'].forEach(newArrayTransform);

  ['reverse', 'sort', 'splice'].forEach(inPlaceTransform);

  function inPlaceTransform(name) {
    qry[name] = function() {
      var transformArgs = arguments;
      qry.$emitter.on('update', function() {
        ArrayProto[name].apply(qry, transformArgs);
      });

      ArrayProto[name].apply(qry, transformArgs);
      return qry;
    };
  }

  function newArrayTransform(name) {
    qry[name] = function() {
      var newArr = [];
      var transformArgs = arguments;
      qry.$emitter.on('update', function() {
        updateNewArr(ArrayProto[name].apply(qry, transformArgs));
      });

      updateNewArr(ArrayProto[name].apply(qry, transformArgs));

      function updateNewArr(arr) {
        newArr.length = 0;
        for (var i = 0; i < arr.length; i++) {
          newArr.push(arr[i]);
        }
      }

      return newArr;
    };
  }
}