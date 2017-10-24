// db-worker-string is automatically built
import workerString from './db-worker-string.js';
import * as utils from './utils.js';
import isObject from 'lodash.isobject';
import isString from 'lodash.isstring';
import isFunction from 'lodash.isfunction';

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

// We may not have the ability to create blobs, but we may be able to use a fallback to an
// actual file anyway.
var workerBlobUrl;
var workerBlob;
try {
  workerBlob = new Blob([workerString], {type: 'text/javascript'});
  workerBlobUrl = URL.createObjectURL(workerBlob);
} catch (err) {} //eslint-disable-line no-empty


export default function() {
  var fallbackWorkerFile;
  this.setFallbackWorkerFile = function setFallbackWorkerFile(file) {
    fallbackWorkerFile = file;
  };

  this.$get = database;

  function database($q, $rootScope, $log, $injector) {
    'ngInject';

    const ngZone = $injector.get('ngZone');

    // Kick off the web worker
    var worker;
    try {
      if (!workerBlobUrl) {
        throw new Error('No Blob URL available for DB worker');
      }

      worker = new Worker(workerBlobUrl);
    } catch (err) {
      if (isString(fallbackWorkerFile)) {
        worker = new Worker(fallbackWorkerFile);
      } else if (isFunction(fallbackWorkerFile)) {
        // handle being given a constructor directly (e.g. from the webpack worker-loader)
        worker = new fallbackWorkerFile();
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

        runOutsideAngular(() => {
          worker.addEventListener('message', (event) => {

            var data = event.data.data;
            var error = event.data.error;
            var id = event.data.id;
            var cb = this.cbMaps[id];

            if (cb) {
              runInAngular(function() {
                cb(error, data);
              });
            }
          });
        });
      }

      update(resArr) {
        if (!Array.isArray(resArr)) {
          resArr = [resArr];
        }

        const toDelete = resArr
          .filter(res => res.$deleted)
          .map(res => res.$id);
        const toUpdate = resArr
          .filter(res => !res.$deleted)
          .map(res => {
            const doc = res.$toObject();
            // Stick on the internal id
            doc.$id = res.$id;
            return doc;
          });

        const proms = [];
        if (toDelete.length > 0) {
          proms.push(this.runWorkerFunction('remove', toDelete));
        }

        if (toUpdate.length > 0) {
          proms.push(this.runWorkerFunction('update', toUpdate));
        }

        return Promise.all(proms);
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
          runOutsideAngular(() => {
            worker.postMessage({
              fnName: fnName,
              id: id,
              dbid: this.dbid,
              args: args
            });
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

    function runOutsideAngular(fn) {
      if (ngZone) {
        ngZone.runOutsideAngular(fn);
      } else {
        setTimeout(fn); //eslint-disable-line angular/timeout-service
      }
    }

    function runInAngular(fn) {
      if (ngZone) {
        ngZone.run(fn);
      } else {
        $rootScope.$apply(fn);
      }
    }
  }
}
