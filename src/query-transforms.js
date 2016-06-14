import EventEmitter from 'events';

var ArrayProto = Array.prototype;

// Make the standard ES5 array transformations work as expected...
export function apply(qry) {

  // These methods create new arrays
  ['filter', 'map', 'slice'].forEach(newArrayTransform);

  ['reverse', 'sort', 'splice'].forEach(inPlaceTransform);

  qry.concat = concat;

  function inPlaceTransform(name) {
    qry[name] = function() {
      var qry = this;
      var transformArgs = arguments;
      qry.$emitter.on('update', function() {
        ArrayProto[name].apply(qry, transformArgs);
      });

      ArrayProto[name].apply(qry, transformArgs);
      return qry;
    };
  }

  function newArrayTransform(name) {
    qry[name] = function(...args) {
      var qry = this;
      var newArr = ArrayEmitter();
      newArr.$emitter = new EventEmitter();
      qry.$emitter.on('update', function() {
        updateNewArr(ArrayProto[name].apply(qry, args));
        newArr.$emitter.emit('update', newArr);
      });

      updateNewArr(ArrayProto[name].apply(qry, args));

      function updateNewArr(arr) {
        newArr.length = 0;
        for (var i = 0; i < arr.length; i++) {
          newArr.push(arr[i]);
        }
      }

      return newArr;
    };
  }

  function concat(...args) {
    var qry = this;
    var newArr = ArrayEmitter();
    var qries = [qry, ...args].filter((obj) => (Array.isArray(obj) && obj.$emitter));
    qries.forEach((_qry) => {
      _qry.$emitter.on('update', function() {
        updateConcat();
        newArr.$emitter.emit('update', newArr);
      });
    });

    updateConcat();

    return newArr;

    function updateConcat() {
      var concatted = qry.concat(...args);
      newArr.length = 0;
      newArr.push(...concatted);
    }
  }
}

function ArrayEmitter() {
  var arr = [];
  arr.$emitter = new EventEmitter();

  ['on', 'once', 'addListener', 'removeListener'].forEach(function(key) {
    arr[key] = arr.$emitter[key].bind(arr.$emitter);
  });

  // Stick on the various methods
  apply(arr);

  return arr;
}
