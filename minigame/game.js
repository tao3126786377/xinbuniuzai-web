import Main from './js/app';

if (wx.setInnerAudioOption) {
  wx.setInnerAudioOption({
    obeyMuteSwitch: false,
    speakerOn: true,
    success() { console.info('[audio] global audio enabled'); },
    fail(error) { console.warn('[audio] global audio setup failed', error); },
  });
}

if (wx.cloud) {
  wx.cloud.init({
    env: 'cloud1-d1gclwenrc6f659c0',
    traceUser: false,
  });
}

new Main();
