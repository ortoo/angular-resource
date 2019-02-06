import EventEmitter from 'events';
import isObject from 'lodash.isobject';
import isString from 'lodash.isstring';
import isFunction from 'lodash.isfunction';

import { Subject } from 'rxjs/Subject';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/fromPromise';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/multicast';
import './bufferTimeReactive';

// db-worker-string is automatically built
import workerString from './db-worker-string.js';
import * as utils from './utils.js';

// These are the operators nedb supports
var simpleOperators = {
  $lt: true,
  $lte: true,
  $gt: true,
  $gte: true,
  $in: true,
  $nin: true,
  $ne: true,
  $exists: true,
  $regex: true,
  $size: true,
  $or: true,
  $and: true,
  $not: true
};

// We may not have the ability to create blobs, but we may be able to use a fallback to an
// actual file anyway.
var workerBlobUrl;
var workerBlob;
try {
  workerBlob = new Blob([workerString], { type: 'text/javascript' });
  workerBlobUrl = URL.createObjectURL(workerBlob);
} catch (err) {} //eslint-disable-line no-empty

export default function() {
  var fallbackWorkerFile;
  this.setFallbackWorkerFile = function setFallbackWorkerFile(file) {
    fallbackWorkerFile = file;
  };

  this.$get = database;

  function database($q, $rootScope, $log, $injector, $timeout) {
    'ngInject';

    var ngZone;
    try {
      ngZone = $injector.get('ngZone');
    } catch (err) {
      // Ignore - we don't necessarily expect it to be there
    }

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

    worker.addEventListener('error', err => {
      $rootScope.$apply(function() {
        $log.error(err);
      });
    });

    class Database extends EventEmitter {
      constructor() {
        super();

        this.cbMaps = {};
        this.dbid = utils.uuid();
        this._updateOutstanding = false;

        this.setMaxListeners(0);

        this._setupUpdateStream();

        runOutsideAngular(() => {
          worker.addEventListener('message', event => {
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

      update(res) {
        if (res) {
          this._updateOutstanding = true;
          this._dbUpdateSubject.next(res);
        }
      }

      query(qry) {
        return this._runWorkerFunction('query', qry);
      }

      // Returns true if it is a simple query that we can process with nedb
      qryIsSimple(qry) {
        var simple = true;

        if (Array.isArray(qry)) {
          qry.forEach(val => {
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
            var kosherKey = key[0] !== '$' || simpleOperators[key];

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

      awaitOutstandingUpdates() {
        return $q(resolve => {
          if (this._updateOutstanding) {
            this.once('update', () => {
              $timeout(() => resolve());
            });
          } else {
            resolve();
          }
        });
      }

      _setupUpdateStream() {
        const dbUpdateSubject = new Subject();
        const _updateOperationsSubj = new Subject();

        this._dbUpdateSubject = dbUpdateSubject;

        // Batch up db updates
        const updateOperations = dbUpdateSubject
          .bufferTimeReactive(100)
          .mergeMap(docs => {
            // Remove duplicates
            docs = [...new Set(docs)];

            return Observable.fromPromise(
              // We catch the errors here and log them as we don't
              // want the stream to error out - it would then stop and
              // no more events will be passed through!
              this._doBulkUpdate(docs).catch(err => $log.error(err))
            );
          })
          .multicast(_updateOperationsSubj)
          .refCount();

        updateOperations.subscribe(
          () => {
            this._updateOutstanding = false;
            this.emit('update');
          },
          err => {
            // If this goes wrong for any reason, just reset
            // the stream
            $log.error(err);
            this._setupUpdateStream();
          }
        );
      }

      _doBulkUpdate(resArr) {
        if (!Array.isArray(resArr)) {
          resArr = [resArr];
        }

        const toDelete = resArr.filter(res => res.$deleted).map(res => res.$id);
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
          proms.push(this._runWorkerFunction('remove', toDelete));
        }

        if (toUpdate.length > 0) {
          proms.push(this._runWorkerFunction('update', toUpdate));
        }

        return $q.all(proms);
      }

      _runWorkerFunction(fnName, ...args) {
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
        ngZone.run(fn); // eslint-disable-line angular/module-getter
      } else {
        $rootScope.$apply(fn);
      }
    }
  }
}
