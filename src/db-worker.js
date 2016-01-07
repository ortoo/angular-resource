// This file has some magic applied to it in the build process. It gets fully built, including
// dependencies and then turned into a Blob.
// Finally the `worker` is exported (the Blob of this file).

import Datastore from 'nedb';
import clone from 'lodash.clone';
import isObject from 'lodash.isobject';

self.addEventListener('message', handleMessage);

var _DB_MAP = {};

class Database {
  constructor() {
    this.db = new Datastore();

    this.RES_TO_DB_ID_MAP = {};

    // Stick an index on __id - our id field.
    this.db.ensureIndex({ fieldName: '__id' }, function (err) {
      if (err) {
        throw err;
      }
    });
  }

  remove(id, callback) {
    var dbid = this.RES_TO_DB_ID_MAP[id];
    if (dbid) {
      delete this.RES_TO_DB_ID_MAP[id];
      this.db.remove({_id: dbid}, {multi: true}, function(err) {
        callback(err);
      });
    } else {
      callback(new Error(`No object to remove with id ${id}`));
    }
  }

  update(doc, callback) {
    // We need to transform the resource by replacing the _id field (nedb uses its own id in that
    // place). Instead call it __id
    doc.__id = doc._id;
    doc.__$id = doc.$id;
    delete doc._id;
    delete doc.$id;
    var dbid = this.RES_TO_DB_ID_MAP[doc.__$id];
    if (dbid) {
      this.db.update({_id: dbid}, doc, {}, function(err) {
        callback(err);
      });
    } else {
      this.db.insert(doc, (err, newDoc) => {
        if (err) {
          return callback(err);
        }

        this.RES_TO_DB_ID_MAP[doc.__$id] = newDoc._id;
        callback();
      });
    }
  }

  query(qry, callback) {
    var find = createDbFind(qry.find);
    var limit = qry.limit;
    var skip = qry.skip;
    var sort = qry.sort;

    var cur = this.db.find(find);

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
        return doc.__$id;
      });
      callback(err, ids);
    });
  }
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
      error: err && err.message,
      data: resp
    });
  };
}

function getDatabase(dbid) {
  var db = _DB_MAP[dbid];

  if (!db) {
    db = new Database();
    _DB_MAP[dbid] = db;
  }

  return db;
}

function handleMessage(event) {
  var data = event.data;
  var dbid = data.dbid;
  var id = data.id;
  var args = data.args;
  var cb = createCallback(id);
  var db = getDatabase(dbid);

  switch(data.fnName) {
    case 'update':
      db.update(...args, cb);
      break;
    case 'remove':
      db.remove(...args, cb);
      break;
    case 'query':
      db.query(...args, cb);
      break;
    default:
      cb(new Error(`No such method ${data.fnName}`));
      break;
  }
}
