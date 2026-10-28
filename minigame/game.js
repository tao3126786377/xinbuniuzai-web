import Main from './js/app';

if (wx.cloud) {
  wx.cloud.init({
    env: 'cloud1-d1gclwenrc6f659c0',
    traceUser: false,
  });
}

new Main();
