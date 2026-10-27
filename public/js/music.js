/* 西部牛仔 · 用户手动开启的轻快背景音乐（Web Audio，无外部音频资源） */
(function () {
  'use strict';
  var audio = null, master = null, timer = null, step = 0;
  var lead = [329.6, 370, 415.3, 493.9, 554.4, 493.9, 415.3, 370,
    329.6, 415.3, 493.9, 659.3, 554.4, 493.9, 370, 415.3];
  var roots = [82.4, 110, 123.5, 82.4];

  function pluck(when, hz, gain, life, type) {
    var oscillator = audio.createOscillator(), envelope = audio.createGain();
    oscillator.type = type || 'triangle';
    oscillator.frequency.value = hz;
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(gain, when + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + life);
    oscillator.connect(envelope).connect(master);
    oscillator.start(when);
    oscillator.stop(when + life + 0.015);
  }

  function playBeat() {
    if (!audio) return;
    var now = audio.currentTime, i = step % lead.length;
    var root = roots[Math.floor(i / 4)], lift = i % 4 === 3;
    pluck(now, lead[i], 0.06, 0.115, i % 2 ? 'square' : 'triangle');
    pluck(now + 0.205, lead[(i + 2) % lead.length] * 0.75, 0.035, 0.085, 'triangle');
    pluck(now, root, 0.045, 0.13, 'square');
    pluck(now + 0.205, root * 2, 0.025, 0.07, 'square');
    pluck(now + 0.205, lift ? 1760 : 1320, 0.012, 0.025, 'sine');
    if (lift) pluck(now + 0.31, lead[(i + 1) % lead.length], 0.035, 0.075, 'triangle');
    step++;
  }

  function label(on) {
    var button = document.getElementById('btn-music');
    button.textContent = on ? '■ 音乐' : '♫ 音乐';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.classList.toggle('on', on);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (audio) audio.close();
    audio = null;
    master = null;
    label(false);
  }

  function toggle() {
    if (audio) { stop(); return; }
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audio = new AudioContext();
    master = audio.createGain();
    master.gain.value = 0.34;
    master.connect(audio.destination);
    step = 0;
    playBeat();
    timer = setInterval(playBeat, 400);
    label(true);
  }

  window.GameMusic = { toggle: toggle, stop: stop };
})();
