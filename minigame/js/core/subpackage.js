'use strict';

const loading = {};

function load(name) {
  if (!wx.loadSubpackage) return Promise.resolve();
  if (!loading[name]) {
    loading[name] = new Promise((resolve, reject) => {
      wx.loadSubpackage({ name, success: resolve, fail: reject });
    }).catch((error) => {
      delete loading[name];
      throw error;
    });
  }
  return loading[name];
}

module.exports = { load };
