/* 完整人机：服务器预先承诺动作，公开后更新记忆。与快速模式日志隔离。 */
(function () {
  'use strict';
  var MEMORY_KEY = 'xnz_match_memory_v1';
  var current = null, memory = null;
  try { memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || 'null'); } catch (_) {}
  var names = ['开枪', '防御', '装弹'], chars = ['u', 'i', 'o'];
  function $(id) { return document.getElementById(id); }
  function requestId() {
    // getRandomValues also works over HTTP on the local Wi-Fi address.
    var bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
    var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function lock() {
    App.lockActionButtons();
    for (var i = 0; i < 3; i++) $('pick-' + i).disabled = true;
  }
  // Identical retries retain the same decision ID, so a lost response cannot settle twice.
  async function request(route, data, method, attempts) {
    var body = JSON.stringify(data);
    for (var i = 0; ; i++) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 12000);
      try {
        var res = await fetch('/api/match-ai/' + route, {
          method: method || 'POST', headers: { 'Content-Type': 'application/json' },
          body: body, signal: controller.signal
        });
        var value = await res.json();
        if (!res.ok) { var error = new Error(value.error || '连接失败'); error.status = res.status; throw error; }
        return value;
      } catch (e) {
        if (i >= (attempts === undefined ? 1 : attempts) || (e.status && e.status !== 503 && e.status !== 429)) throw e;
      } finally { clearTimeout(timer); }
      await new Promise(function (resolve) { setTimeout(resolve, 1000); });
    }
  }
  function discard(id) {
    if (id) request('session', { sessionId: id }, 'DELETE', 0).catch(function () {});
  }
  function saveMemory(value) {
    memory = value;
    try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); }
    catch (_) { if (current && !current.storageWarning) { current.storageWarning = true; App.toast('浏览器无法保存记忆，本次打开页面期间仍可继续学习'); } }
  }
  function accept(g, value) {
    g.data = value;
    saveMemory(value.memory);
  }
  function panels(bc, bh, mc, mh) {
    App.updateBullets('opp-bullets-num', 'opp-bullets-icons', bc);
    App.updateBullets('my-bullets-num', 'my-bullets-icons', bh);
    App.setText('opp-money', mc); App.setText('my-money', mh);
  }
  function setup() {
    App.setActiveMode('ai-match'); App.showScreen('game');
    App.setText('game-mode-label', '完整 · 人机对战'); App.setText('opponent-name', '电脑');
    App.setText('btn-leave-game', '结束对局，返回菜单');
    App.show('opp-money-row'); App.show('my-money-row'); App.hide('countdown');
    App.hide('opp-action'); App.hide('my-action'); App.hide('banner');
    App.hide('pick-area'); App.hide('actions'); App.clearHistory();
    App.setText('round-label', '正在准备对局…'); App.setText('opp-status', '电脑正在准备…');
    App.setText('my-status', ''); panels(0, 0, 50, 50); lock();
  }
  function render(g) {
    if (current !== g) return;
    var s = g.data.snapshot.state;
    g.busy = false;
    App.hide('opp-action'); App.hide('my-action'); App.hide('banner');
    panels(s.bc, s.bh, s.mc, s.mh);
    App.setText('round-label', '第 ' + s.round + '/5 轮 · ' + (s.phase === 'pick' ? '选弹' : '回合 ' + s.turn + '/100'));
    App.setText('opp-status', '电脑已选好，等待你选择'); App.setText('my-status', '');
    if (s.phase === 'pick') {
      App.hide('actions'); App.show('pick-area');
      App.setText('pick-status', '双方选择后一起公开');
      for (var i = 0; i < 3; i++) { $('pick-' + i).disabled = false; $('pick-' + i).classList.remove('selected'); }
    } else {
      App.hide('pick-area'); App.show('actions');
      App.setActionButtons({ u: s.bh > 0, i: true, o: s.bh < 10 });
    }
  }
  function failed(g, e) {
    if (current !== g) return;
    App.hide('loading-overlay'); lock();
    App.setText('opp-status', '');
    App.showBanner((e.status ? e.message : '网络连接异常') + '。请返回菜单重开，已保存的记忆会保留。');
  }
  async function enter() {
    if (current) return;
    var g = { busy: true, events: [], data: null, timer: null };
    current = g; setup();
    try {
      var value = await request('session', { memory: memory, requestId: requestId() }, 'POST', 5);
      if (current !== g) { discard(value.sessionId); return; }
      accept(g, value); g.initialMemory = value.memory; render(g);
    } catch (e) { failed(g, e); }
  }
  async function onAction(action) {
    var g = current;
    if (!g || g.busy || !g.data || !g.data.ready) return;
    var s = g.data.snapshot.state;
    if (s.phase === 'play' && Game.feasible(s.bh).indexOf(action) < 0) return;
    if ([0, 1, 2].indexOf(action) < 0) return;
    g.busy = true; lock(); App.setText('my-status', '已提交，等待揭示…');
    try {
      var value = await request('step', { sessionId: g.data.sessionId, decisionId: g.data.ready.decisionId, action: action });
      if (current !== g) return;
      accept(g, value);
      var r = value.result, settle = r.settlement, pick = r.before.phase === 'pick';
      g.events.push({ before: r.before, human: r.human, computer: r.computer, settlement: settle, score: r.score,
        decision: r.decision, predictionReview: r.predictionReview, risk: r.risk });
      App.setText('opp-status', ''); App.setText('my-status', '');
      App.showBadge('my-action', pick ? '初始 ' + r.human + ' 颗' : names[r.human], pick ? '' : App.actionBadgeClass(chars[r.human]));
      App.showBadge('opp-action', pick ? '初始 ' + r.computer + ' 颗' : names[r.computer], pick ? '' : App.actionBadgeClass(chars[r.computer]));
      App.addHistoryChip('轮' + r.before.round + (pick ? '选弹' : '·' + r.before.turn) + ' 你' + (pick ? r.human : names[r.human]) + '/电脑' + (pick ? r.computer : names[r.computer]));
      if (settle.round_end) {
        panels(settle.final_bullets[0], settle.final_bullets[1], settle.money[0], settle.money[1]);
        App.showBanner('本轮' + (settle.winner === 2 ? '你胜' : settle.winner === 1 ? '电脑胜' : '平局') + '，结算后你 ' + settle.money[1] + ' / 电脑 ' + settle.money[0] + ' 筹码');
      } else panels(r.state.bc, r.state.bh, r.state.mc, r.state.mh);
      if (value.snapshot.over) {
        var outcome = r.score === 0 ? 'win' : r.score === 1 ? 'lose' : 'draw';
        Stats.recordFullMatch({ id: value.sessionId + ':' + value.snapshot.gameNumber,
          source: 'human', policy: value.policy, endedAt: new Date().toISOString(),
          outcome: outcome, money: settle.money, initialMemory: g.initialMemory, events: g.events });
      }
      g.timer = setTimeout(function () {
        if (current !== g) return;
        if (value.snapshot.over) {
          g.busy = false;
          App.showResult(outcome, '完整对局结束 · 你 ' + settle.money[1] + ' / 电脑 ' + settle.money[0] + ' 筹码');
        } else render(g);
      }, settle.round_end ? 1500 : 850);
    } catch (e) { failed(g, e); }
  }
  async function startGame() {
    var g = current;
    if (!g) { enter(); return; }
    if (g.busy || !g.data || !g.data.snapshot.over) return;
    g.busy = true; g.events = []; setup();
    try {
      var value = await request('rematch', { sessionId: g.data.sessionId, gameNumber: g.data.snapshot.gameNumber });
      if (current !== g) return;
      accept(g, value); g.initialMemory = value.memory; render(g);
    } catch (e) { failed(g, e); }
  }
  function toMenu() {
    var g = current; current = null;
    if (g) { clearTimeout(g.timer); if (g.data) discard(g.data.sessionId); }
    App.hide('loading-overlay'); App.setActiveMode(null); App.showScreen('menu'); Stats.refresh();
  }
  window.ModeMatchAI = { enter: enter, onAction: onAction, startGame: startGame, toMenu: toMenu, abortToMenu: toMenu };
})();
