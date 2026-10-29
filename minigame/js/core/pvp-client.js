'use strict';

const SOCKET_URL = 'wss://xinbuniuzai-web.onrender.com';
const SESSION_KEY = 'xnz_pvp_session_v1';

function loadSession() {
  try {
    const value = wx.getStorageSync(SESSION_KEY);
    if (!value) return null;
    const session = typeof value === 'string' ? JSON.parse(value) : value;
    if (!session || !/^\d{3,6}$/.test(session.code)
      || (session.seat !== 0 && session.seat !== 1)
      || typeof session.token !== 'string') return null;
    return session;
  } catch (error) {
    return null;
  }
}

function saveSession(session) {
  wx.setStorageSync(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  wx.removeStorageSync(SESSION_KEY);
}

class PvpClient {
  constructor(options) {
    const config = options || {};
    this.onOpen = config.onOpen || null;
    this.onMessage = config.onMessage || null;
    this.onClose = config.onClose || null;
    this.onError = config.onError || null;
    this.socket = null;
    this.session = loadSession();
    this.intent = null;
    this.manualClose = false;
    this.pingTimer = null;
    this.lastMessageAt = 0;
  }

  connect(intent) {
    this.closeSocket();
    this.intent = intent;
    this.manualClose = false;
    const socket = wx.connectSocket({ url: SOCKET_URL });
    this.socket = socket;
    socket.onOpen(() => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 45000) {
          try { socket.close({ code: 1000, reason: 'heartbeat timeout' }); } catch (error) { /* ignore */ }
          return;
        }
        this.send({ type: 'ping' });
      }, 20000);
      if (this.onOpen) this.onOpen();
      if (intent.type === 'create') {
        this.send({ type: 'create_room', mode: intent.mode });
      } else if (intent.type === 'join') {
        this.send({ type: 'join_room', code: intent.code });
      } else if (intent.type === 'rejoin' && this.session) {
        this.send({ type: 'rejoin', code: this.session.code, seat: this.session.seat, token: this.session.token });
      }
    });
    socket.onMessage((event) => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (!message || typeof message.type !== 'string') return;
      this.lastMessageAt = Date.now();
      if (message.type === 'room_created' || message.type === 'room_joined') {
        this.session = { code: message.code, seat: message.seat, token: message.token };
        saveSession(this.session);
      } else if (message.type === 'room_closed') {
        this.session = null;
        clearSession();
      }
      if (this.onMessage) this.onMessage(message);
    });
    socket.onError((error) => {
      if (this.socket === socket && this.onError) this.onError(error);
    });
    socket.onClose(() => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!this.manualClose && this.onClose) this.onClose();
    });
  }

  create(mode) {
    this.connect({ type: 'create', mode: mode === 'match' ? 'match' : 'single' });
  }

  join(code) {
    this.connect({ type: 'join', code });
  }

  rejoin() {
    if (!this.session) return false;
    this.connect({ type: 'rejoin' });
    return true;
  }

  send(message) {
    if (!this.socket) return false;
    this.socket.send({ data: JSON.stringify(message) });
    return true;
  }

  leave() {
    if (this.socket) this.send({ type: 'leave_room' });
    this.session = null;
    clearSession();
    this.close();
  }

  closeSocket() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    try { socket.close({ code: 1000, reason: 'reconnect' }); } catch (error) { /* ignore */ }
  }

  close() {
    this.manualClose = true;
    this.closeSocket();
  }

  static savedSession() {
    return loadSession();
  }
}

PvpClient.SOCKET_URL = SOCKET_URL;
PvpClient.SESSION_KEY = SESSION_KEY;

module.exports = PvpClient;
