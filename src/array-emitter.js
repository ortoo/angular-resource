import EventEmitter from 'events';

var ArrayProto = Array.prototype;

export default ArrayEmitter;

// Make the standard ES5 array transformations work as expected...
function ArrayEmitter(...args) {

  // Need to generate an actual array here for proper behaviour (in a full ES6 environment we
  // should be able to subclass array. But alas)
  var arr = new Array(...args);

  // Non enumerable so that we can send the array over postMessage
  Object.defineProperty(arr, '$emitter', {
    enumerable: false,
    value: new EventEmitter()
  });

  // Generate our Array Emitter methods
  var ArrayEmitterMethods = {};
  ['on', 'once', 'addListener', 'removeListener'].forEach(function(key) {
    ArrayEmitterMethods[key] = {
      enumerable: false,
      value: function(...args) {
        return this.$emitter[key](...args);
      }
    };
  });

  // These methods create new arrays
  ['reverse', 'sort', 'splice'].forEach(function(key) {
    ArrayEmitterMethods[key] = {
      enumerable: false,
      value: function(...args) {
        this.$emitter.on('update', () => {
          ArrayProto[key].apply(this, args);
        });

        ArrayProto[key].apply(this, args);
        return this;
      }
    };
  });

  ['filter', 'map', 'slice'].forEach(function(key) {
    ArrayEmitterMethods[key] = {
      enumerable: false,
      value: function(...args) {
        var newArr = new ArrayEmitter();
        this.$emitter.on('update', () => {
          updateNewArr(ArrayProto[key].apply(this, args));
          newArr.$emitter.emit('update', newArr);
        });

        updateNewArr(ArrayProto[key].apply(this, args));

        function updateNewArr(arr) {
          newArr.length = 0;
          for (var i = 0; i < arr.length; i++) {
            newArr.push(arr[i]);
          }
        }

        return newArr;
      }
    };
  });

  ArrayEmitterMethods.concat = {
    enumerable: false,
    value: function(...args) {
      var newArr = new ArrayEmitter();
      var allArrs = [this, ...args];
      var qries = allArrs.filter((obj) => (Array.isArray(obj) && obj.$emitter));
      qries.forEach((_qry) => {
        _qry.$emitter.on('update', () => {
          updateConcat();
          newArr.$emitter.emit('update', newArr);
        });
      });

      updateConcat();

      return newArr;

      function updateConcat() {
        var concatted = ArrayProto.concat.call(...allArrs);
        newArr.length = 0;
        newArr.push(...concatted);
      }
    }
  };

  Object.defineProperties(arr, ArrayEmitterMethods);

  return arr;
}
