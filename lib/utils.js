'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.convertJsonDates = convertJsonDates;
exports.toJSON = toJSON;
exports.diff = diff;
exports.applyPatch = applyPatch;
exports.mergeObjects = mergeObjects;
exports.forEachVal = forEachVal;
exports.toJsonReplacer = toJsonReplacer;
exports.fromJsonReviver = fromJsonReviver;
exports.toObject = toObject;
exports.removeResValues = removeResValues;
exports.setResValues = setResValues;
exports.persistentStorageKey = persistentStorageKey;
exports.advancedStorage = advancedStorage;
exports.uuid = uuid;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _jiff = require('jiff');

var _jiff2 = _interopRequireDefault(_jiff);

var _moment = require('moment');

var _moment2 = _interopRequireDefault(_moment);

var _lodashClone = require('lodash.clone');

var _lodashClone2 = _interopRequireDefault(_lodashClone);

var _lodashPluck = require('lodash.pluck');

var _lodashPluck2 = _interopRequireDefault(_lodashPluck);

var _angular = require('angular');

var _angular2 = _interopRequireDefault(_angular);

var hiddenKeyRegex = /^\$+/;

var TIMESTAMP_RE = /^(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+)|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d)|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d)$/;

function convertJsonDates(jsonData) {
  var outObj;
  if (Array.isArray(jsonData)) {
    outObj = [];
  } else {
    outObj = {};
  }
  for (var key in jsonData) {
    var val = jsonData[key];
    var res = val;
    if (_angular2['default'].isString(val)) {
      // The value is a string - does it match any of our things we want to convert
      if (TIMESTAMP_RE.test(val)) {
        // We're probably a timestamp
        var dt = (0, _moment2['default'])(val);
        if (dt.isValid()) {
          res = dt.toDate();
        }
      }
    } else if (Array.isArray(val) || _angular2['default'].isObject(val)) {
      res = convertJsonDates(val);
    }

    outObj[key] = res;
  }

  return outObj;
}

function toJSON(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function diff(obj1, obj2) {
  obj1 = toJSON(obj1);
  obj2 = toJSON(obj2);

  return _jiff2['default'].diff(obj1, obj2);
}

function applyPatch(res, patch) {
  // Go to JSON - don't do anything with dates
  var obj = JSON.parse(JSON.stringify(res, toJsonReplacer));
  obj = _jiff2['default'].patch(patch, obj);

  // Go back to dates etc
  obj = convertJsonDates(obj);

  removeResValues(res);
  setResValues(res, obj);
}

function mergeObjects(mine, old, yours) {

  // Make copies - we might modify the objects if ids dont exist
  mine = (0, _lodashClone2['default'])(mine);
  old = (0, _lodashClone2['default'])(old);

  // First sort out _id's. We could have a new id if one doesn't exist on mine and old
  if (!mine._id && !old._id && yours._id) {
    mine._id = yours._id;
    old._id = yours._id;
  }

  // We also need to convert into and out of dates
  mine = toJSON(mine);
  old = toJSON(old);
  yours = toJSON(yours);

  var yourpatch = _jiff2['default'].diff(old, yours);
  var mypatch = _jiff2['default'].diff(old, mine);

  var mypaths = (0, _lodashPluck2['default'])(mypatch, 'path');
  var patch = yourpatch.filter(function (patchval) {
    return ! ~mypaths.indexOf(patchval.path);
  });

  var patched = _jiff2['default'].patch(patch, mine);
  return convertJsonDates(patched);
}

function forEachVal(res, cb) {
  for (var key in res) {
    if (!hiddenKeyRegex.test(key)) {
      if (!cb(res, key)) {
        break;
      }
    }
  }
}

function toJsonReplacer(key, value) {
  var val = value;
  if (_angular2['default'].isString(key) && key.charAt(0) === '$') {
    val = undefined;
  }

  return val;
}

function fromJsonReviver(key, value) {
  var val = value;
  if (_angular2['default'].isString(value) && TIMESTAMP_RE.test(value)) {
    var dt = (0, _moment2['default'])(value);
    if (dt.isValid()) {
      val = dt.toDate();
    }
  }

  return val;
}

function toObject(res) {
  // The toJsonReplacer gets rid of attributes beginning with $ and the fromJsonReviver
  // converts date strings back into dates
  var str = JSON.stringify(res, toJsonReplacer);

  try {
    return JSON.parse(str, fromJsonReviver);
  } catch (err) {
    // Older versions of IE8 throw 'Out of stack space' errors if we use a reviver function
    // due to the bug described here: http://support.microsoft.com/kb/976662. Everyone hates
    // IE
    if (err.message === 'Out of stack space') {
      return convertJsonDates(JSON.parse(str));
    }

    throw err;
  }
}

function removeResValues(res) {
  forEachVal(res, function (val, key) {
    delete res[key];
  });
}

function setResValues(res, vals) {
  for (var key in vals) {
    res[key] = vals[key];
  }
}

function persistentStorageKey(url) {
  return 'or2ws:' + url;
}

function advancedStorage($localForage) {
  return $localForage.driver() !== 'localStorageWrapper';
}

// lifted from here -> http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript/2117523#2117523

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0,
        v = c == 'x' ? r : r & 0x3 | 0x8;
    return v.toString(16);
  });
}
//# sourceMappingURL=data:application/json;base64,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Q0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFDO0FBQ3JDLE9BQUssSUFBSSxHQUFHLElBQUksSUFBSSxFQUFFO0FBQ3BCLE9BQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7R0FDdEI7Q0FDRjs7QUFFTSxTQUFTLG9CQUFvQixDQUFDLEdBQUcsRUFBRTtBQUN4QyxTQUFPLFFBQVEsR0FBRyxHQUFHLENBQUM7Q0FDdkI7O0FBRU0sU0FBUyxlQUFlLENBQUMsWUFBWSxFQUFFO0FBQzVDLFNBQU8sWUFBWSxDQUFDLE1BQU0sRUFBRSxLQUFLLHFCQUFxQixDQUFDO0NBQ3hEOzs7O0FBR00sU0FBUyxJQUFJLEdBQUc7QUFDckIsU0FBTyxzQ0FBc0MsQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLFVBQVMsQ0FBQyxFQUFFO0FBQ3pFLFFBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsR0FBQyxFQUFFLEdBQUMsQ0FBQztRQUFFLENBQUMsR0FBRyxDQUFDLElBQUksR0FBRyxHQUFHLENBQUMsR0FBSSxDQUFDLEdBQUMsR0FBRyxHQUFDLEdBQUcsQUFBQyxDQUFDO0FBQzNELFdBQU8sQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQztHQUN2QixDQUFDLENBQUM7Q0FDSiIsImZpbGUiOiJ1dGlscy5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBqaWZmIGZyb20gJ2ppZmYnO1xuaW1wb3J0IG1vbWVudCBmcm9tICdtb21lbnQnO1xuXG5pbXBvcnQgY2xvbmUgZnJvbSAnbG9kYXNoLmNsb25lJztcbmltcG9ydCBwbHVjayBmcm9tICdsb2Rhc2gucGx1Y2snO1xuXG5pbXBvcnQgYW5ndWxhciBmcm9tICdhbmd1bGFyJztcblxudmFyIGhpZGRlbktleVJlZ2V4ID0gL15cXCQrLztcblxudmFyIFRJTUVTVEFNUF9SRSA9IC9eKFxcZHs0fS1bMDFdXFxkLVswLTNdXFxkVFswLTJdXFxkOlswLTVdXFxkOlswLTVdXFxkXFwuXFxkKyl8KFxcZHs0fS1bMDFdXFxkLVswLTNdXFxkVFswLTJdXFxkOlswLTVdXFxkOlswLTVdXFxkKXwoXFxkezR9LVswMV1cXGQtWzAtM11cXGRUWzAtMl1cXGQ6WzAtNV1cXGQpJC87XG5cbmV4cG9ydCBmdW5jdGlvbiBjb252ZXJ0SnNvbkRhdGVzKGpzb25EYXRhKSB7XG4gIHZhciBvdXRPYmo7XG4gIGlmIChBcnJheS5pc0FycmF5KGpzb25EYXRhKSkge1xuICAgIG91dE9iaiA9IFtdO1xuICB9IGVsc2Uge1xuICAgIG91dE9iaiA9IHt9O1xuICB9XG4gIGZvciAodmFyIGtleSBpbiBqc29uRGF0YSkge1xuICAgIHZhciB2YWwgPSBqc29uRGF0YVtrZXldO1xuICAgIHZhciByZXMgPSB2YWw7XG4gICAgaWYgKGFuZ3VsYXIuaXNTdHJpbmcodmFsKSkge1xuICAgICAgLy8gVGhlIHZhbHVlIGlzIGEgc3RyaW5nIC0gZG9lcyBpdCBtYXRjaCBhbnkgb2Ygb3VyIHRoaW5ncyB3ZSB3YW50IHRvIGNvbnZlcnRcbiAgICAgIGlmIChUSU1FU1RBTVBfUkUudGVzdCh2YWwpKSB7XG4gICAgICAgIC8vIFdlJ3JlIHByb2JhYmx5IGEgdGltZXN0YW1wXG4gICAgICAgIHZhciBkdCA9IG1vbWVudCh2YWwpO1xuICAgICAgICBpZiAoZHQuaXNWYWxpZCgpKSB7XG4gICAgICAgICAgcmVzID0gZHQudG9EYXRlKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsKSB8fCBhbmd1bGFyLmlzT2JqZWN0KHZhbCkpIHtcbiAgICAgIHJlcyA9IGNvbnZlcnRKc29uRGF0ZXModmFsKTtcbiAgICB9XG5cbiAgICBvdXRPYmpba2V5XSA9IHJlcztcbiAgfVxuXG4gIHJldHVybiBvdXRPYmo7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0b0pTT04ob2JqKSB7XG4gIHJldHVybiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KG9iaikpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGlmZihvYmoxLCBvYmoyKSB7XG4gIG9iajEgPSB0b0pTT04ob2JqMSk7XG4gIG9iajIgPSB0b0pTT04ob2JqMik7XG5cbiAgcmV0dXJuIGppZmYuZGlmZihvYmoxLCBvYmoyKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2gocmVzLCBwYXRjaCkge1xuICAvLyBHbyB0byBKU09OIC0gZG9uJ3QgZG8gYW55dGhpbmcgd2l0aCBkYXRlc1xuICB2YXIgb2JqID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShyZXMsIHRvSnNvblJlcGxhY2VyKSk7XG4gIG9iaiA9IGppZmYucGF0Y2gocGF0Y2gsIG9iaik7XG5cbiAgLy8gR28gYmFjayB0byBkYXRlcyBldGNcbiAgb2JqID0gY29udmVydEpzb25EYXRlcyhvYmopO1xuXG4gIHJlbW92ZVJlc1ZhbHVlcyhyZXMpO1xuICBzZXRSZXNWYWx1ZXMocmVzLCBvYmopO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VPYmplY3RzKG1pbmUsIG9sZCwgeW91cnMpIHtcblxuICAvLyBNYWtlIGNvcGllcyAtIHdlIG1pZ2h0IG1vZGlmeSB0aGUgb2JqZWN0cyBpZiBpZHMgZG9udCBleGlzdFxuICBtaW5lID0gY2xvbmUobWluZSk7XG4gIG9sZCA9IGNsb25lKG9sZCk7XG5cbiAgLy8gRmlyc3Qgc29ydCBvdXQgX2lkJ3MuIFdlIGNvdWxkIGhhdmUgYSBuZXcgaWQgaWYgb25lIGRvZXNuJ3QgZXhpc3Qgb24gbWluZSBhbmQgb2xkXG4gIGlmICghbWluZS5faWQgJiYgIW9sZC5faWQgJiYgeW91cnMuX2lkKSB7XG4gICAgbWluZS5faWQgPSB5b3Vycy5faWQ7XG4gICAgb2xkLl9pZCA9IHlvdXJzLl9pZDtcbiAgfVxuXG4gIC8vIFdlIGFsc28gbmVlZCB0byBjb252ZXJ0IGludG8gYW5kIG91dCBvZiBkYXRlc1xuICBtaW5lID0gdG9KU09OKG1pbmUpO1xuICBvbGQgPSB0b0pTT04ob2xkKTtcbiAgeW91cnMgPSB0b0pTT04oeW91cnMpO1xuXG4gIHZhciB5b3VycGF0Y2ggPSBqaWZmLmRpZmYob2xkLCB5b3Vycyk7XG4gIHZhciBteXBhdGNoID0gamlmZi5kaWZmKG9sZCwgbWluZSk7XG5cbiAgdmFyIG15cGF0aHMgPSBwbHVjayhteXBhdGNoLCAncGF0aCcpO1xuICB2YXIgcGF0Y2ggPSB5b3VycGF0Y2guZmlsdGVyKGZ1bmN0aW9uKHBhdGNodmFsKSB7XG4gICAgcmV0dXJuICF+bXlwYXRocy5pbmRleE9mKHBhdGNodmFsLnBhdGgpO1xuICB9KTtcblxuICB2YXIgcGF0Y2hlZCA9IGppZmYucGF0Y2gocGF0Y2gsIG1pbmUpO1xuICByZXR1cm4gY29udmVydEpzb25EYXRlcyhwYXRjaGVkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvckVhY2hWYWwocmVzLCBjYikge1xuICBmb3IgKHZhciBrZXkgaW4gcmVzKSB7XG4gICAgaWYgKCFoaWRkZW5LZXlSZWdleC50ZXN0KGtleSkpIHtcbiAgICAgIGlmICghY2IocmVzLCBrZXkpKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9Kc29uUmVwbGFjZXIoa2V5LCB2YWx1ZSkge1xuICB2YXIgdmFsID0gdmFsdWU7XG4gIGlmIChhbmd1bGFyLmlzU3RyaW5nKGtleSkgJiYga2V5LmNoYXJBdCgwKSA9PT0gJyQnKSB7XG4gICAgdmFsID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgcmV0dXJuIHZhbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZyb21Kc29uUmV2aXZlcihrZXksIHZhbHVlKSB7XG4gIHZhciB2YWwgPSB2YWx1ZTtcbiAgaWYgKGFuZ3VsYXIuaXNTdHJpbmcodmFsdWUpICYmIFRJTUVTVEFNUF9SRS50ZXN0KHZhbHVlKSkge1xuICAgIHZhciBkdCA9IG1vbWVudCh2YWx1ZSk7XG4gICAgaWYgKGR0LmlzVmFsaWQoKSkge1xuICAgICAgdmFsID0gZHQudG9EYXRlKCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZhbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRvT2JqZWN0KHJlcykge1xuICAvLyBUaGUgdG9Kc29uUmVwbGFjZXIgZ2V0cyByaWQgb2YgYXR0cmlidXRlcyBiZWdpbm5pbmcgd2l0aCAkIGFuZCB0aGUgZnJvbUpzb25SZXZpdmVyXG4gIC8vIGNvbnZlcnRzIGRhdGUgc3RyaW5ncyBiYWNrIGludG8gZGF0ZXNcbiAgdmFyIHN0ciA9IEpTT04uc3RyaW5naWZ5KHJlcywgdG9Kc29uUmVwbGFjZXIpO1xuXG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2Uoc3RyLCBmcm9tSnNvblJldml2ZXIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBPbGRlciB2ZXJzaW9ucyBvZiBJRTggdGhyb3cgJ091dCBvZiBzdGFjayBzcGFjZScgZXJyb3JzIGlmIHdlIHVzZSBhIHJldml2ZXIgZnVuY3Rpb25cbiAgICAvLyBkdWUgdG8gdGhlIGJ1ZyBkZXNjcmliZWQgaGVyZTogaHR0cDovL3N1cHBvcnQubWljcm9zb2Z0LmNvbS9rYi85NzY2NjIuIEV2ZXJ5b25lIGhhdGVzXG4gICAgLy8gSUVcbiAgICBpZiAoZXJyLm1lc3NhZ2UgPT09ICdPdXQgb2Ygc3RhY2sgc3BhY2UnKSB7XG4gICAgICByZXR1cm4gY29udmVydEpzb25EYXRlcyhKU09OLnBhcnNlKHN0cikpO1xuICAgIH1cblxuICAgIHRocm93KGVycik7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVJlc1ZhbHVlcyhyZXMpIHtcbiAgZm9yRWFjaFZhbChyZXMsIGZ1bmN0aW9uKHZhbCwga2V5KSB7XG4gICAgZGVsZXRlIHJlc1trZXldO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFJlc1ZhbHVlcyhyZXMsIHZhbHMpe1xuICBmb3IgKHZhciBrZXkgaW4gdmFscykge1xuICAgIHJlc1trZXldID0gdmFsc1trZXldO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwZXJzaXN0ZW50U3RvcmFnZUtleSh1cmwpIHtcbiAgcmV0dXJuICdvcjJ3czonICsgdXJsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWR2YW5jZWRTdG9yYWdlKCRsb2NhbEZvcmFnZSkge1xuICByZXR1cm4gJGxvY2FsRm9yYWdlLmRyaXZlcigpICE9PSAnbG9jYWxTdG9yYWdlV3JhcHBlcic7XG59XG5cbi8vIGxpZnRlZCBmcm9tIGhlcmUgLT4gaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8xMDUwMzQvaG93LXRvLWNyZWF0ZS1hLWd1aWQtdXVpZC1pbi1qYXZhc2NyaXB0LzIxMTc1MjMjMjExNzUyM1xuZXhwb3J0IGZ1bmN0aW9uIHV1aWQoKSB7XG4gIHJldHVybiAneHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4Jy5yZXBsYWNlKC9beHldL2csIGZ1bmN0aW9uKGMpIHtcbiAgICB2YXIgciA9IE1hdGgucmFuZG9tKCkqMTZ8MCwgdiA9IGMgPT0gJ3gnID8gciA6IChyJjB4M3wweDgpO1xuICAgIHJldHVybiB2LnRvU3RyaW5nKDE2KTtcbiAgfSk7XG59XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
