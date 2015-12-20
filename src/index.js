import 'angular-localforage';
import angular from 'angular';

import Chain from './chain';
import Collection from './collection';
import LocalResourceFactory from './local';
import ResourceProvider from './model';
import QueryFactory from './query';
import ServerResourceFactory from './server';
import ResourceDBFactory from './db.js';

export default angular.module('or2.resource', ['LocalForageModule'])
  .factory('Chain', Chain)
  .factory('Collection', Collection)
  .factory('LocalResourceFactory', LocalResourceFactory)
  .factory('ServerResourceFactory', ServerResourceFactory)
  .factory('QueryFactory', QueryFactory)
  .factory('ResourceDBFactory', ResourceDBFactory)
  .provider('resource', ResourceProvider);
