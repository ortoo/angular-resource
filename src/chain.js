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
      return qryFn(origQry);
    });
    var newqry = Model.query(_qry);

    // Bind qryFn to newqry
    qryFn = qryFn.bind(newqry);

    // Watch our results. If they change then reattempt the query
    origQry.$emitter.on('update', function(newRes) {
      // Only do this if we have initially synced
      if (initialSync) {
        newqry.replace(qryFn(newRes));
      }
    });

    return newqry;
  }

  function all(origQueries, Model, qryFn) {
    var newqry;
    var proms = [];
    var initialSync;
    var allqries;

    origQueries.forEach(function(origQry) {
      proms.push(origQry.$promise);
      origQry.$emitter.on('update', function() {
        if (initialSync) {
          newqry.replace(qryFn(allqries));
        }
      });
    });

    newqry = Model.query($q.all(proms).then(function(res) {
      initialSync = true;
      allqries = res;
      return qryFn(res);
    }));

    qryFn = qryFn.bind(newqry);

    return newqry;
  }

  Chain.all = all;

  return Chain;
}
