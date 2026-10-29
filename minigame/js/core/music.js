'use strict';

const Subpackage = require('./subpackage');
const STORAGE_KEY = 'xnz_music_enabled_v1';

class MusicController {
  constructor() {
    this.audio = null;
    this.playing = false;
    this.enabled = wx.getStorageSync(STORAGE_KEY) === 'on';
    this.loading = null;
  }

  createAudio() {
    if (this.audio) return this.audio;
    const audio = wx.createInnerAudioContext();
    audio.src = 'packs/bgm/the-entertainer.mp3';
    audio.loop = true;
    audio.volume = 0.22;
    audio.onPlay(() => { this.playing = true; });
    audio.onPause(() => { this.playing = false; });
    audio.onStop(() => { this.playing = false; });
    audio.onError(() => { this.playing = false; });
    this.audio = audio;
    return audio;
  }

  toggle() {
    this.enabled = !this.enabled;
    wx.setStorageSync(STORAGE_KEY, this.enabled ? 'on' : 'off');
    if (this.enabled) this.resume();
    else this.pause();
    return this.enabled;
  }

  resume() {
    if (!this.enabled || this.playing) return Promise.resolve();
    if (!this.loading) this.loading = Subpackage.load('bgm').catch(() => null);
    return this.loading.then((loaded) => {
      if (!this.enabled || this.playing || loaded === null) return;
      this.createAudio().play();
    });
  }

  pause() {
    if (this.audio && this.playing) this.audio.pause();
  }

  isEnabled() {
    return this.enabled;
  }
}

MusicController.STORAGE_KEY = STORAGE_KEY;

module.exports = MusicController;
