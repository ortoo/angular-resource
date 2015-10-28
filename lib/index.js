'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

require('angular-localforage');

var _angular = require('angular');

var _angular2 = _interopRequireDefault(_angular);

var _chain = require('./chain');

var _chain2 = _interopRequireDefault(_chain);

var _collection = require('./collection');

var _collection2 = _interopRequireDefault(_collection);

var _local = require('./local');

var _local2 = _interopRequireDefault(_local);

var _model = require('./model');

var _model2 = _interopRequireDefault(_model);

var _query = require('./query');

var _query2 = _interopRequireDefault(_query);

var _server = require('./server');

var _server2 = _interopRequireDefault(_server);

exports['default'] = _angular2['default'].module('or2.resource', ['LocalForageModule']).factory('Chain', _chain2['default']).factory('Collection', _collection2['default']).factory('LocalResourceFactory', _local2['default']).factory('ServerResourceFactory', _server2['default']).factory('QueryFactory', _query2['default']).provider('resource', _model2['default']);
module.exports = exports['default'];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O1FBQU8scUJBQXFCOzt1QkFDUixTQUFTOzs7O3FCQUVYLFNBQVM7Ozs7MEJBQ0osY0FBYzs7OztxQkFDSixTQUFTOzs7O3FCQUNiLFNBQVM7Ozs7cUJBQ2IsU0FBUzs7OztzQkFDQSxVQUFVOzs7O3FCQUU3QixxQkFBUSxNQUFNLENBQUMsY0FBYyxFQUFFLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxDQUNqRSxPQUFPLENBQUMsT0FBTyxxQkFBUSxDQUN2QixPQUFPLENBQUMsWUFBWSwwQkFBYSxDQUNqQyxPQUFPLENBQUMsc0JBQXNCLHFCQUF1QixDQUNyRCxPQUFPLENBQUMsdUJBQXVCLHNCQUF3QixDQUN2RCxPQUFPLENBQUMsY0FBYyxxQkFBZSxDQUNyQyxRQUFRLENBQUMsVUFBVSxxQkFBbUIiLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgJ2FuZ3VsYXItbG9jYWxmb3JhZ2UnO1xuaW1wb3J0IGFuZ3VsYXIgZnJvbSAnYW5ndWxhcic7XG5cbmltcG9ydCBDaGFpbiBmcm9tICcuL2NoYWluJztcbmltcG9ydCBDb2xsZWN0aW9uIGZyb20gJy4vY29sbGVjdGlvbic7XG5pbXBvcnQgTG9jYWxSZXNvdXJjZUZhY3RvcnkgZnJvbSAnLi9sb2NhbCc7XG5pbXBvcnQgUmVzb3VyY2VQcm92aWRlciBmcm9tICcuL21vZGVsJztcbmltcG9ydCBRdWVyeUZhY3RvcnkgZnJvbSAnLi9xdWVyeSc7XG5pbXBvcnQgU2VydmVyUmVzb3VyY2VGYWN0b3J5IGZyb20gJy4vc2VydmVyJztcblxuZXhwb3J0IGRlZmF1bHQgYW5ndWxhci5tb2R1bGUoJ29yMi5yZXNvdXJjZScsIFsnTG9jYWxGb3JhZ2VNb2R1bGUnXSlcbiAgLmZhY3RvcnkoJ0NoYWluJywgQ2hhaW4pXG4gIC5mYWN0b3J5KCdDb2xsZWN0aW9uJywgQ29sbGVjdGlvbilcbiAgLmZhY3RvcnkoJ0xvY2FsUmVzb3VyY2VGYWN0b3J5JywgTG9jYWxSZXNvdXJjZUZhY3RvcnkpXG4gIC5mYWN0b3J5KCdTZXJ2ZXJSZXNvdXJjZUZhY3RvcnknLCBTZXJ2ZXJSZXNvdXJjZUZhY3RvcnkpXG4gIC5mYWN0b3J5KCdRdWVyeUZhY3RvcnknLCBRdWVyeUZhY3RvcnkpXG4gIC5wcm92aWRlcigncmVzb3VyY2UnLCBSZXNvdXJjZVByb3ZpZGVyKTtcbiJdLCJzb3VyY2VSb290IjoiL3NvdXJjZS8ifQ==
