/* 西部牛仔 · WebSocket 客户端封装（浏览器专用）
 *
 * 职责：连接管理（建立/关闭）、消息收发、事件分发。
 * 重连策略由 mode-pvp.js 驱动（依据 sessionStorage 中的 {code, seat, token} 决定是否重进）。
 */
(function (root) {
  'use strict';

  function Net() {
    this.ws = null;
    this.handlers = {};
    this.manualClose = false;   // 主动关闭后不再触发 onclose 重连提示
  }

  /* 建立连接。
   * wsUrl: 按当前页面协议推导（http→ws / https→wss）。
   * handlers: { onOpen(), onMessage(obj), onClose() }
   */
  Net.prototype.connect = function (wsUrl, handlers) {
    this.close();
    this.handlers = handlers || {};
    this.manualClose = false;

    var self = this;
    var ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = function () {
      if (self.handlers.onOpen) self.handlers.onOpen();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (self.handlers.onMessage) self.handlers.onMessage(msg);
    };
    ws.onclose = function () {
      self.ws = null;
      if (!self.manualClose && self.handlers.onClose) self.handlers.onClose();
    };
    ws.onerror = function () { /* 具体错误由 onclose 呈现 */ };
  };

  Net.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  };

  Net.prototype.close = function () {
    this.manualClose = true;
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* 忽略 */ }
      this.ws = null;
    }
  };

  /* 强制断开并立即触发 onClose 一次（用于僵尸连接看门狗：锁屏唤醒后
   * socket 半死但未触发 close 事件时，主动断开进入重连流程） */
  Net.prototype.abort = function () {
    if (this.ws) {
      var w = this.ws;
      this.ws = null;
      w.onclose = null;   // 屏蔽真实 close 事件，避免重复触发
      try { w.close(); } catch (e) { /* 忽略 */ }
    }
    if (this.handlers.onClose) this.handlers.onClose();
  };

  Net.prototype.isOpen = function () {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  };

  /* 按页面协议推导 ws 地址（局域网 http→ws；公网 https→wss） */
  Net.prototype.defaultUrl = function () {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  };

  root.Net = new Net();
})(typeof self !== 'undefined' ? self : this);
