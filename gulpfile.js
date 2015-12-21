var gulp = require('gulp');
var babel = require('gulp-babel');
var browserify = require('browserify');
var source = require('vinyl-source-stream');
var buffer = require('vinyl-buffer');
var sourcemaps = require('gulp-sourcemaps');
var ngAnnotate = require('gulp-ng-annotate');
var uglify = require('gulp-uglify');
var babelify = require('babelify');
var through2 = require('through2');

var fileToBlob = through2.obj(function(file, enc, callback) {
  if (file.isNull()) {
    return callback();
  }

  var contents = file.contents.toString();

  var escapedContents = JSON.stringify(contents);

  // Rename the require function as it may mess with other loaders further down the line
  escapedContents = escapedContents.replace(/require/g, '__require');

  var newContents = `'format cjs';\nmodule.exports = new Blob([${escapedContents}], {type: 'application/json'});`;
  file.contents = new Buffer(newContents);
  this.push(file);
  callback();
});

gulp.task('worker', function() {
  return browserify({
    entries: 'src/db-worker.js'
  }).transform(babelify, {presets: ['es2015']})
    .bundle()
    .pipe(source('db-worker.js'))
    .pipe(buffer())
    .pipe(uglify())
    .pipe(fileToBlob)
    .pipe(gulp.dest('lib'));
});

gulp.task('js', function() {
  return gulp.src(['src/**/*.js', '!src/db-worker.js'])
    .pipe(sourcemaps.init())
      .pipe(babel())
      .pipe(ngAnnotate({
        regexp: /angular.*?\.module\(.*?\)$/
      }))
    .pipe(sourcemaps.write())
    .pipe(gulp.dest('lib'));
});

gulp.task('default', ['js', 'worker']);
