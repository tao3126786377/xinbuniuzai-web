/* 西部牛仔 · 背景钢琴曲《The Entertainer》（公版录音） */
(function () {
  'use strict';
  var player = new Audio('assets/audio/the-entertainer.mp3');
  player.loop = true;
  player.preload = 'none';
  player.volume = 0.22;

  function label(on) {
    var button = document.getElementById('btn-music');
    button.textContent = on ? '■ 音乐' : '♫ 音乐';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.classList.toggle('on', on);
  }

  function stop() {
    player.pause();
    label(false);
  }

  function toggle() {
    if (!player.paused) { stop(); return; }
    player.play().then(function () { label(true); }, function () { label(false); });
  }

  player.addEventListener('error', function () { label(false); });
  window.GameMusic = { toggle: toggle, stop: stop };
})();
