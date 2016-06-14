var ArrayProto = Array.prototype;

// Make the standard ES5 array transformations work as expected...
export function apply(qry, $q) {

  // These methods create new arrays
  ['filter', 'map', 'slice'].forEach(newArrayTransform);

  ['reverse', 'sort', 'splice'].forEach(inPlaceTransform);

  qry.concat = concat;

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

  function concat(...args) {
    var newArr = [];
    var qries = args.filter((obj) => (Array.isArray(obj) && obj.$emitter));
    qries.push(qry);
    qries.forEach((_qry) => {
      _qry.$emitter.on('update', updateConcat);
    });

    updateConcat();

    // Setup the next, prev etc
    ['hasNext', 'hasPrev'].forEach(function(key) {
      Object.defineProperty(newArr, key, {
        get: function() {
          return qries.some((_qry) => _qry[key]);
        }
      });
    });

    ['next', 'prev'].forEach(function(key) {
      newArr[key] = function(...args) {
        return $q.all(qries.map((_qry) => _qry[key](...args))).then(function() {
          return newArr;
        });
      };
    });

    function updateConcat() {
      var concatted = qry.concat(...args);
      newArr.length = 0;
      newArr.push(...concatted);
    }
  }
}
