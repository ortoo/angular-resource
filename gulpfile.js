var gulp = require('gulp');
var babel = require('gulp-babel');
var browserify = require('browserify');
var source = require('vinyl-source-stream');
var buffer = require('vinyl-buffer');
var sourcemaps = require('gulp-sourcemaps');
var uglify = require('gulp-uglify');
var babelify = require('babelify');
var through2 = require('through2');

var fileToString = through2.obj(function(file, enc, callback) {
  if (file.isNull()) {
    return callback();
  }

  var contents = file.contents.toString();

  var escapedContents = JSON.stringify(contents);

  // Rename the require function as it may mess with other loaders further down the line
  escapedContents = escapedContents.replace(/require/g, '__require');

  var newContents = `'format cjs';\nmodule.exports = ${escapedContents};`;
  file.contents = Buffer.from(newContents);
  this.push(file);
  callback();
});

function worker() {
  return browserify({
    entries: 'src/db-worker.js'
  })
    .transform(babelify, {
      presets: [
        [
          '@babel/preset-env',
          {
            targets:
              'last 2 versions, not ie < 11, not ie_mob < 11, not android > 0'
          }
        ]
      ]
    })
    .bundle()
    .pipe(source('db-worker-string.js'))
    .pipe(buffer())
    .pipe(uglify())
    .pipe(fileToString)
    .pipe(gulp.dest('lib'));
}

function js() {
  return gulp
    .src(['src/**/*.js'])
    .pipe(sourcemaps.init())
    .pipe(
      babel({
        sourceType: 'module',
        plugins: ['babel-plugin-angularjs-annotate']
      })
    )
    .pipe(sourcemaps.write())
    .pipe(gulp.dest('lib'));
}

module.exports.default = gulp.parallel(js, worker);
