var jiff = require('jiff');
var moment = require('moment');

var clone = require('lodash.clone');
var pluck = require('lodash.pluck');
var angular = require('angular');

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
    if (angular.isString(val)) {
      // The value is a string - does it match any of our things we want to convert
      if (TIMESTAMP_RE.test(val)) {
        // We're probably a timestamp
        var dt = moment(val);
        if (dt.isValid()) {
          res = dt.toDate();
        }
      }
    } else if (Array.isArray(val) || angular.isObject(val)) {
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

  return jiff.diff(obj1, obj2);
}

function applyPatch(res, patch) {
  // Go to JSON - don't do anything with dates
  var obj = JSON.parse(JSON.stringify(res, toJsonReplacer));
  obj = jiff.patch(patch, obj);

  // Go back to dates etc
  obj = convertJsonDates(obj);

  removeResValues(res);
  setResValues(res, obj);
}

function mergeObjects(mine, old, yours) {

  // Make copies - we might modify the objects if ids dont exist
  mine = clone(mine);
  old = clone(old);

  // First sort out _id's. We could have a new id if one doesn't exist on mine and old
  if (!mine._id && !old._id && yours._id) {
    mine._id = yours._id;
    old._id = yours._id;
  }

  // We also need to convert into and out of dates
  mine = toJSON(mine);
  old = toJSON(old);
  yours = toJSON(yours);

  var yourpatch = jiff.diff(old, yours);
  var mypatch = jiff.diff(old, mine);

  var mypaths = pluck(mypatch, 'path');
  var patch = yourpatch.filter(function(patchval) {
    return !~mypaths.indexOf(patchval.path);
  });

  var patched = jiff.patch(patch, mine);
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
  if (typeof key === 'string' && key.charAt(0) === '$') {
    val = undefined;
  }

  return val;
}

function fromJsonReviver(key, value) {
  var val = value;
  if (typeof value === 'string' && TIMESTAMP_RE.test(value)) {
    var dt = moment(value);
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

    throw(err);
  }
}

function removeResValues(res) {
  forEachVal(res, function(val, key) {
    delete res[key];
  });
}

function setResValues(res, vals){
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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

module.exports = {
  removeResValues: removeResValues,
  setResValues: setResValues,
  toObject: toObject,
  forEachVal: forEachVal,
  mergeObjects: mergeObjects,
  convertJsonDates: convertJsonDates,
  fromJsonReviver: fromJsonReviver,
  persistentStorageKey: persistentStorageKey,
  advancedStorage: advancedStorage,
  diff: diff,
  applyPatch: applyPatch,
  uuid: uuid
};
