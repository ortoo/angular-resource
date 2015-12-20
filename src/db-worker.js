// This file has some magic applied to it in the build process. It gets fully built, including
// dependencies and then turned into a Blob.
// Finally the `worker` is exported (the Blob of this file).

import Datastore from 'nedb';
import clone from 'lodash.clone';
import isObject from 'lodash.isobject';

this.addEventListener('message', handleMessage);

var db = new Datastore();

var RES_TO_DB_ID_MAP = {};

// Stick an index on __id - our id field.
db.ensureIndex({ fieldName: '__id' }, function (err) {
  if (err) {
    throw err;
  }
});

function remove(id, callback) {
  var dbid = RES_TO_DB_ID_MAP[id];
  if (dbid) {
    delete RES_TO_DB_ID_MAP[id];
    db.remove({_id: dbid}, {multi: true}, function(err) {
      callback(err);
    });
  } else {
    callback(new Error(`No object to remove with id ${id}`));
  }
}

function update(doc, callback) {
  // We need to transform the resource by replacing the _id field (nedb uses its own id in that
  // place). Instead call it __id
  doc.__id = doc._id;
  doc.__$id = doc.$id;
  delete doc._id;
  var dbid = RES_TO_DB_ID_MAP[doc.__$id];
  if (dbid) {
    db.update({_id: dbid}, doc, {}, function(err) {
      callback(err);
    });
  } else {
    db.insert(doc, function(err, newDoc) {
      if (err) {
        return callback(err);
      }

      RES_TO_DB_ID_MAP[doc.__$id] = newDoc._id;
    });
  }
}

function query(qry, callback) {
  var find = createDbFind(qry.find);
  var limit = qry.limit;
  var skip = qry.skip;
  var sort = qry.sort;

  var cur = db.find(find);

  if (sort) {
    cur = cur.sort(sort);
  }
  if (skip) {
    cur = cur.skip(skip);
  }
  if (limit) {
    // We go + 1 so we can tell if there are any more results
    cur = cur.limit(limit + 1);
  }

  cur.exec(function(err, docs) {
    // Now go from our docs to the ids
    var ids = docs.map(function(doc) {
      doc.__$id;
    });
    callback(err, ids);
  });
}

// Convert any _id searches to __id (which is where our id moved to)
function _createDbFind(qry) {
  if (Array.isArray(qry)) {
    qry.forEach(function(val) {
      _createDbFind(val);
    });
  } else if (isObject(qry)) {
    for (var key in qry) {
      var val = qry[key];

      // Convert the _id to __id searches
      if (key === '_id') {
        qry.__id = val;
        delete qry._id;
      }

      _createDbFind(val);
    }
  }
}

function createDbFind(qry) {
  // Converts the query into the form required for a db search. First clone the object
  qry = clone(qry, true);
  _createDbFind(qry);
  return qry;
}


function createCallback(id) {
  return function callback(err, resp) {
    self.postMessage({
      id: id,
      error: err,
      data: resp
    });
  };
}

function handleMessage(event) {
  var data = event.data;
  var id = data.id;
  var args = data.args;
  var cb = createCallback(id);
  switch(event.fnName) {
    case 'update':
      update(...args, cb);
      break;
    case 'remove':
      remove(...args, cb);
      break;
    case 'query':
      query(...args, cb);
      break;
    default:
      cb(new Error(`No such method ${event.fnName}`));
      break;
  }
}
