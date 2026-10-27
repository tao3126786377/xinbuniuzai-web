'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
var css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
var app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

var modeIds = [
  'btn-mode-ai',
  'btn-mode-pvp',
  'btn-mode-pvp-match',
  'btn-mode-ai-match'
];
var positions = modeIds.map(function (id) { return html.indexOf('id="' + id + '"'); });
positions.forEach(function (position, i) {
  assert(position >= 0, 'missing mode button: ' + modeIds[i]);
});
for (var i = 1; i < positions.length; i++) {
  assert(positions[i - 1] < positions[i], 'mode button order changed');
}

[
  'btn-rules',
  'btn-history',
  'btn-export-log',
  'btn-export-match-log',
  'btn-music'
].forEach(function (id) {
  assert(html.includes('id="' + id + '"'), 'missing UI control: ' + id);
});

assert(html.includes('<script src="js/music.js"></script>'), 'music script not loaded');
assert(!html.includes('正午决斗'), 'obsolete duel title remains');
assert(/\.history-strip\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow-y:\s*auto;/.test(css),
  'round history must be a vertical scroll area');
assert(app.includes('网页版 v0.17.0'), 'page version is not v0.17.0');

console.log('v0.17 UI static checks passed');
