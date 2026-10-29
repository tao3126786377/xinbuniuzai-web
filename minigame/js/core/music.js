'use strict';

const STORAGE_KEY = 'xnz_music_enabled_v1';
const MUSIC_URL = 'https://xinbuniuzai-web.onrender.com/assets/audio/the-entertainer.mp3';

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
    audio.src = MUSIC_URL;
    audio.loop = true;
    audio.volume = 0.22;
    audio.onPlay(() => { this.playing = true; });
    audio.onPause(() => { this.playing = false; });
    audio.onStop(() => { this.playing = false; });
    audio.onError((error) => {
      this.playing = false;
      console.warn('[audio] background music failed', error);
    });
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
    this.createAudio().play();
    this.loading = Promise.resolve();
    return this.loading;
  }

  pause() {
    if (this.audio && this.playing) this.audio.pause();
  }

  isEnabled() {
    return this.enabled;
  }
}

MusicController.STORAGE_KEY = STORAGE_KEY;
MusicController.MUSIC_URL = MUSIC_URL;

module.exports = MusicController;
