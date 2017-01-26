export default function($q) {
  'ngInject';

  // Chain a query into a new one (when the query updates so does the new query)
  function Chain(origQry, Model, qryFn) {
    var initialSync = false;

    if (!qryFn) {
      qryFn = Model;
      Model = origQry.$Model;
    }

    // Make sure we have at least finished an initial load before generating the
    // query object
    var _qry = origQry.$promise.then(function() {
      initialSync = true;
      // We copy the array here so that we can do things like .map without auto-updating repercussions.
      return qryFn([...origQry]);
    });
    var newqry = Model.query(_qry);

    // Bind qryFn to newqry
    qryFn = qryFn.bind(newqry);

    // Watch our results. If they change then reattempt the query
    origQry.$emitter.on('update', function(newRes) {
      // Only do this if we have initially synced
      if (initialSync) {
        // We copy the array here so that we can do things like .map without auto-updating repercussions.
        newqry.replace(qryFn([...newRes]));
      }
    });

    return newqry;
  }

  function all(origQueries, Model, qryFn) {
    var newqry;
    var proms = [];
    var initialSync;
    var allqries;

    for (let ii = 0; ii < origQueries.length; ii++) {
      let origQry = origQueries[ii];
      proms.push(origQry.$promise);
      origQry.$emitter.on('update', function(newRes) {
        if (initialSync) {
          allqries[ii] = [...newRes];
          newqry.replace(qryFn(allqries));
        }
      });
    }

    newqry = Model.query($q.all(proms).then(function(res) {
      initialSync = true;
      allqries = [];
      for (let result of res) {
        allqries.push([...result]);
      }
      return qryFn(allqries);
    }));

    qryFn = qryFn.bind(newqry);

    return newqry;
  }

  Chain.all = all;

  return Chain;
}
