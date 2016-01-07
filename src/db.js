// db-worker-string is automatically built
import workerBlob from './db-worker-blob.js';
import * as utils from './utils.js';
import isObject from 'lodash.isobject';

// These are the operators nedb supports
var simpleOperators = {
  '$lt': true,
  '$lte': true,
  '$gt': true,
  '$gte': true,
  '$in': true,
  '$nin': true,
  '$ne': true,
  '$exists': true,
  '$regex': true,
  '$size': true,
  '$or': true,
  '$and': true,
  '$not': true
};

var workerUrl = URL.createObjectURL(workerBlob);

export default function() {
  var fallbackWorkerFile;
  this.setFallbackWorkerFile = function setFallbackWorkerFile(file) {
    fallbackWorkerFile = file;
  };

  this.$get = database;

  function database($q, $rootScope, $log) {
    'ngInject';

    // Kick off the web worker
    var worker;
    try {
      worker = new Worker(workerUrl);
    } catch (err) {
      if (fallbackWorkerFile) {
        worker = new Worker(fallbackWorkerFile);
      } else {
        throw err;
      }
    }

    worker.addEventListener('error', (err) => {
      $rootScope.$apply(function() {
        $log.error(err);
      });
    });

    class Database {
      constructor() {

        this.cbMaps = {};
        this.dbid = utils.uuid();

        worker.addEventListener('message', (event) => {

          var data = event.data.data;
          var error = event.data.error;
          var id = event.data.id;
          var cb = this.cbMaps[id];

          if (cb) {
            $rootScope.$apply(function() {
              cb(error, data);
            });
          }
        });
      }

      update(res) {
        if (res.$deleted) {
          return this.runWorkerFunction('remove', res.$id);
        } else {
          var doc = res.$toObject();
          // Stick on the internal id
          doc.$id = res.$id;
          return this.runWorkerFunction('update', doc);
        }
      }

      query(qry) {
        return this.runWorkerFunction('query', qry);
      }

      // Returns true if it is a simple query that we can process with nedb
      qryIsSimple(qry) {
        var simple = true;

        if (Array.isArray(qry)) {
          qry.forEach((val) => {
            var kosher = this.qryIsSimple(val);
            if (!kosher) {
              simple = false;
              return false;
            }
          });
        } else if (isObject(qry)) {
          for (var key in qry) {
            var val = qry[key];
            // The key is fine if it doesn't begin with $ or is a simple operator
            var kosherKey = (key[0] !== '$') || simpleOperators[key];

            if (!kosherKey) {
              simple = false;
              break;
            }

            var valKosher = this.qryIsSimple(val);

            if (!valKosher) {
              simple = false;
              break;
            }
          }
        }

        return simple;
      }


      runWorkerFunction(fnName, ...args) {
        return $q((resolve, reject) => {
          var id = utils.uuid();
          worker.postMessage({
            fnName: fnName,
            id: id,
            dbid: this.dbid,
            args: args
          });

          this.cbMaps[id] = (err, resp) => {
            delete this.cbMaps[id];
            if (err) {
              reject(err);
            } else {
              resolve(resp);
            }
          };
        });
      }
    }

    function DBFactory() {
      return new Database();
    }

    return DBFactory;
  }
}