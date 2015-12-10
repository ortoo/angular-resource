# angular-resource
Magical CRUD resource management for angular

## Requires

- angular
- An angular service named 'socket' that handles the direct http comms

## What's it do?
Magically manages CRUD operations on models, keeping queries and objects in sync with the server.

## Usage

Add the module `or2.resource` to your application

```javascript
angular.module('yourModule', ['or2.resource']);
```

Inject the `resource` service and construct a resource class:
```javascript

// '/users' defines an endpoint, 'user' defines a model name (singular)
var Users = resource('/users', 'user');

var Doris = new Users({
  firstName: 'Doris'
});

Doris.gender = 'female';

// Save Doris to the server. Doris will be given an `_id` field
Doris.$save();
console.log(Doris._id) // doris1

var femaleUsers = Users.query({
  gender: 'female'
});

// Will synchronously return an empty array that will populate with female users. You can wait
// for initial population by waiting for $promise to resolve
femaleUsers.$promise.then(function(results) {
  // femaleUsers === results
  console.log(femaleUsers); // [{Doris}]
});

// Now add a new female user
var Betty = new Users({
  firstName: 'Betty',
  gender: 'female'
});

// femaleUsers won't include Betty yet because she hasn't been saved.
console.log(femaleUsers); // [{Doris}]

Betty.$save();

// femaleUsers has updated itself automatically (this will happen asynchronously, but fast,
// in real life)
console.log(femaleUsers); // [{Doris}, {Betty}]

Betty.$delete();

// You can also reset local changes back to the last stored version. E.g.
Doris.gender = 'male';
Doris.$reset();
console.log(Doris.gender); //female

// And refresh your value from the server (local changes will be merged)
Doris.$refresh();

// You can also fetch models by _id. There is guaranteed to be only one object with the same id.
// This method just keeps giving you the same object, so you can update it in one place and
// everywhere else will see the update.
var Doris1 = Users.get('doris1')
console.log(Doris1 === Doris) // true


// You can also ask for multiple users by ID
var girls = Users.get(['doris1', 'betty1']);

// Queries just use standard mongodb query objects. You can do
var results = Users.query({gender: 'female'});
// or, for example,
var limitedResults = Users.query({find: {gender: 'female'}, limit: 10});
// or could even be a promise that resolves to something mongodb like

// If you want to extend a limited query (or maybe it's a very large query) then you can use
// `next` and `prev`
if (limitedResults.hasNext) {
  limitedResults.next();
}

if (limitedResults.hasPrev) {
  limitedResults.prev();
}

// More...
```
