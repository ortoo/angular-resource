var angular = require('angular');
require('angular-localforage');

module.exports = angular.module('or2.resource', ['LocalForageModule']);
require('./model');
require('./local');
require('./chain');
require('./collection');
require('./query');
require('./server');
