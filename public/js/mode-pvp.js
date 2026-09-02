/* 西部牛仔 · 玩家对决模式（客户端状态机）
 *
 * 服务器权威：本文件只提交动作与渲染服务器广播；倒计时仅显示（服务器死线 + 时钟偏移）。
 * 断线/刷新：sessionStorage 保存 {code, seat, token}，自动重连后 rejoin 全量同步。
 */
(function () {
  'use strict';

  var SESSION_KEY = 'xnz_pvp_session';            // sessionStorage（每标签页主存）
  var SESSION_KEY_FALLBACK = 'xnz_pvp_session_ls'; // localStorage（跨会话一次性备份：
                                                  // 微信等后台杀死页面重载时 sessionStorage 会丢失，
                                                  // 加载时若主存为空则消费备份自动重进）

  var intent = null;   // {type:'create'} | {type:'join', code} | {type:'rejoin'}

  var state = {
    session: null,       // {code, seat, token}
    status: null,        // 'waiting' | 'playing' | 'finished'
    b1: 0, b2: 0,
    round: 1,
    acted: false,        // 本回合我是否已出招
    deadline: null,      // 服务器回合死线（epoch ms）
    offset: 0,           // 服务器时钟 - 本地时钟
    timeoutStrikes: [0, 0],
    oppConnected: true,
    graceDeadline: null, // 对手断线宽限（仅显示）
    voted: false,
    lastReason: null,     // 最近一次对局结束原因（对手离开时"再来一局"按钮的行为不同）
    reconnecting: false,
    gaveUp: false,
    lastServerMsgAt: 0,   // 最近一次收到服务器消息（仅 handleMessage 更新）
    lastPingAt: 0,        // 最近一次主动 ping
    connectFails: 0       // 连续连接失败计数（≥4 触发一次页面刷新恢复）
  };

  var tickTimer = null;
  var reconnectTimer = null;
  var reconnectDelay = 1000;
  var reconnectAttempt = 0;
  var revealTimer = null;     // 回合揭示计时器（先展示双方行动 1.5 秒再进入下一回合/结果）
  var pendingGameOver = null; // 揭示期间到达的 game_over，展示完成后处理
  var REVEAL_MS = 1500;

  function clearReveal() {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    pendingGameOver = null;
  }

  // ==================== 会话持久化 ====================
  function saveSession() {
    var s = JSON.stringify(state.session);
    try { sessionStorage.setItem(SESSION_KEY, s); } catch (e) { /* 忽略 */ }
    try { localStorage.setItem(SESSION_KEY_FALLBACK, s); } catch (e) { /* 忽略 */ }
  }
  function clearSession() {
    state.session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
    try { localStorage.removeItem(SESSION_KEY_FALLBACK); } catch (e) { /* 忽略 */ }
  }

  // ==================== 连接 ====================
  function connectPvp() {
    startTick();   // 看门狗/保活覆盖所有界面（大厅、结果页也要检测僵尸连接）
    Net.connect(Net.defaultUrl(), {
      onOpen: function () {
        state.connectFails = 0;
        try { sessionStorage.removeItem('xnz_pvp_reload_once'); } catch (e) { /* 忽略 */ }
        if (state.reconnecting) {
          send({ type: 'rejoin', code: state.session.code, seat: state.session.seat, token: state.session.token });
        } else if (intent && intent.type === 'rejoin') {
          send({ type: 'rejoin', code: state.session.code, seat: state.session.seat, token: state.session.token });
        } else if (intent && intent.type === 'create') {
          send({ type: 'create_room' });
        } else if (intent && intent.type === 'join') {
          send({ type: 'join_room', code: intent.code });
        }
      },
      onMessage: handleMessage,
      onClose: handleClose
    });
  }

  function send(obj) { Net.send(obj); }

  // ==================== 入口 ====================
  function enterMenu() {
    intent = null;
    stopTick();
    stopReconnect();
    App.showScreen('pvp-menu');
  }

  function create() {
    intent = { type: 'create' };
    resetState();
    connectPvp();
    App.showScreen('disconnected');   // 连接过程中显示等待
    App.setText('disc-status', '正在连接服务器…');
  }

  function join(code) {
    if (!/^\d{3,6}$/.test(code)) {
      App.toast('请输入正确的房间号');
      return;
    }
    intent = { type: 'join', code: code };
    resetState();
    connectPvp();
    App.showScreen('disconnected');
    App.setText('disc-status', '正在连接服务器…');
  }

  /* 页面加载：有会话则静默重进（刷新恢复；主存丢失时消费 localStorage 备份——
   * 微信等后台杀死页面重载后 sessionStorage 被清空，凭备份自动恢复对局） */
  function init() {
    var saved = null;
    try { saved = sessionStorage.getItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
    if (!saved) {
      try { saved = localStorage.getItem(SESSION_KEY_FALLBACK); } catch (e) { /* 忽略 */ }
      if (saved) {
        try {
          sessionStorage.setItem(SESSION_KEY, saved);
          localStorage.removeItem(SESSION_KEY_FALLBACK);   // 单次消费备份
        } catch (e) { /* 忽略 */ }
      }
    }
    if (saved) {
      try {
        state.session = JSON.parse(saved);
        if (!state.session || !state.session.code || !state.session.token) {
          clearSession();
          return;
        }
      } catch (e) {
        clearSession();
        return;
      }
      intent = { type: 'rejoin' };
      resetState(true);
      connectPvp();
    }
  }

  function resetState(keepSession) {
    if (!keepSession) clearSession();
    clearReveal();
    state.status = null;
    state.b1 = 0; state.b2 = 0;
    state.round = 1;
    state.acted = false;
    state.deadline = null;
    state.timeoutStrikes = [0, 0];
    state.oppConnected = true;
    state.graceDeadline = null;
    state.voted = false;
    state.lastReason = null;
    state.reconnecting = false;
    state.gaveUp = false;
    state.lastServerMsgAt = 0;
    state.lastPingAt = 0;
  }

  // ==================== 服务器消息 ====================
  function handleMessage(msg) {
    state.lastServerMsgAt = Date.now();

    switch (msg.type) {
      case 'pong':
        state.offset = msg.t - Date.now();
        return;

      case 'room_created':
      case 'room_joined':
        state.session = { code: msg.code, seat: msg.seat, token: msg.token };
        saveSession();
        state.status = 'waiting';
        stopReconnect();
        App.setText('lobby-code', msg.code);
        App.setText('lobby-status', '等待对手加入…');
        App.show('lobby-spinner');
        App.showScreen('lobby');
        return;

      case 'opponent_joined':
        App.setText('lobby-status', '对手已加入，准备开局…');
        return;

      case 'game_started':
        clearReveal();
        state.status = 'playing';
        state.b1 = msg.b1; state.b2 = msg.b2;
        state.round = msg.round;
        state.deadline = msg.roundDeadline;
        state.offset = msg.serverNow - Date.now();
        state.timeoutStrikes = msg.timeoutStrikes.slice();
        state.acted = false;
        state.voted = false;
        App.hide('rematch-status-line');
        App.setActiveMode('pvp');
        App.clearHistory();
        App.setText('game-mode-label', '房间 ' + (state.session ? state.session.code : ''));
        App.setText('opponent-name', '对手');
        App.setText('btn-leave-game', '离开房间（判负）');
        App.hide('banner');
        App.hide('my-action');
        App.hide('opp-action');
        App.setText('my-status', '');
        App.setText('opp-status', '');
        App.setText('round-label', '回合 ' + state.round + '/' + Game.MAX_ROUNDS);
        App.showScreen('game');
        refreshPanels();
        App.setActionButtons({ u: myBullets() > 0, i: true, o: myBullets() < Game.MAX_BULLET });
        startTick();
        return;

      case 'round_result':
        handleRoundResult(msg);
        return;

      case 'timeout_notice': {
        var mine = msg.seat === state.session.seat;
        var act = App.actionName(msg.action);
        var n = msg.timeoutStrikes[msg.seat];
        App.toast(mine
          ? '你超时了，系统代你出招：' + act + '（连续超时 ' + n + '/3）'
          : '对手超时，系统代其出招：' + act);
        return;
      }

      case 'game_over':
        state.status = 'finished';
        state.lastReason = msg.reason;
        // 不停止 tick：看门狗需在结果页继续守护连接（否则僵尸连接会让"再来一局"失灵）
        state.timeoutStrikes = msg.timeoutStrikes.slice();
        if (revealTimer) {
          // 行动揭示尚未完成：缓冲，展示完再进结果页
          pendingGameOver = msg;
          return;
        }
        showGameOver(msg);
        return;

      case 'rematch_status': {
        var votes = msg.votes.slice();
        var my = state.session.seat;
        var opp = 1 - my;
        if (votes[my] && votes[opp]) {
          App.setRematchLine('双方同意，开局中…');
        } else if (votes[my]) {
          App.setRematchLine('已发起再来一局，等待对方同意…');
        } else if (votes[opp]) {
          App.setRematchLine('对方发起再来一局，点击"再来一局"同意');
        }
        return;
      }

      case 'opponent_left':
        state.oppConnected = false;
        state.graceDeadline = Date.now() + (msg.graceMs || 60000);
        App.setText('opp-status', '对手已断开，等待重连…');
        App.toast('对手已断开，等待重连（' + Math.round((msg.graceMs || 60000) / 1000) + ' 秒）');
        return;

      case 'opponent_rejoined':
        state.oppConnected = true;
        state.graceDeadline = null;
        App.setText('opp-status', '');
        App.toast('对手已重新连接');
        return;

      case 'room_state':
        syncFromRoomState(msg);
        return;

      case 'error':
        handleError(msg);
        return;

      case 'room_closed':
        App.toast('房间已关闭');
        clearSession();
        stopTick();
        stopReconnect();
        App.showScreen('menu');
        return;
    }
  }

  function handleRoundResult(msg) {
    var my = state.session.seat;
    var myChar = my === 0 ? msg.a1 : msg.a2;
    var oppChar = my === 0 ? msg.a2 : msg.a1;

    clearReveal();
    state.b1 = msg.b1_next;
    state.b2 = msg.b2_next;
    state.timeoutStrikes = msg.timeoutStrikes.slice();
    refreshPanels();

    // 展示双方行动（1.5 秒揭示，与 AI 模式一致），期间锁定按钮
    App.showBadge('my-action', '你：' + App.actionName(myChar), App.actionBadgeClass(myChar));
    App.showBadge('opp-action', '对手：' + App.actionName(oppChar), App.actionBadgeClass(oppChar));
    App.showBanner('对手出招：' + App.actionName(oppChar) + '！');
    App.lockActionButtons();

    var cls;
    if (msg.outcome === 'continue') {
      cls = '';
    } else if (msg.outcome === 'p1_win') {
      cls = my === 0 ? 'win' : 'lose';
    } else if (msg.outcome === 'p2_win') {
      cls = my === 1 ? 'win' : 'lose';
    } else {
      cls = 'draw';
    }
    App.addHistoryChip(App.actionName(myChar) + '/' + App.actionName(oppChar), cls);

    if (msg.outcome === 'continue') {
      // 先展示双方行动 REVEAL_MS，再进入下一回合（新回合服务器已计时，无影响）
      var nextRound = msg.round + 1;
      var nextDeadline = msg.roundDeadline;
      revealTimer = setTimeout(function () {
        revealTimer = null;
        state.round = nextRound;
        state.deadline = nextDeadline;
        state.acted = false;
        App.setText('round-label', '回合 ' + state.round + '/' + Game.MAX_ROUNDS);
        App.setText('my-status', '');
        App.setText('opp-status', '');
        App.hide('my-action');
        App.hide('opp-action');
        App.hide('banner');
        App.setActionButtons({ u: myBullets() > 0, i: true, o: myBullets() < Game.MAX_BULLET });
        if (pendingGameOver) {
          var g = pendingGameOver;
          pendingGameOver = null;
          showGameOver(g);
        }
      }, REVEAL_MS);
    } else {
      state.round = msg.round;
      state.acted = true;
      App.setText('round-label', '回合 ' + state.round + '/' + Game.MAX_ROUNDS);
      // 终局：game_over 紧随其后到达，等揭示完成再展示结果页
      revealTimer = setTimeout(function () {
        revealTimer = null;
        if (pendingGameOver) {
          var g2 = pendingGameOver;
          pendingGameOver = null;
          showGameOver(g2);
        }
      }, REVEAL_MS);
    }
  }

  /* 重进全量同步 */
  function syncFromRoomState(msg) {
    clearReveal();
    var wasReconnecting = state.reconnecting;
    state.session = { code: msg.code, seat: msg.seat, token: state.session.token };
    state.status = msg.status;
    state.b1 = msg.b1; state.b2 = msg.b2;
    state.round = msg.round;
    state.deadline = msg.roundDeadline;
    state.offset = msg.serverNow - Date.now();
    state.timeoutStrikes = msg.timeoutStrikes.slice();
    state.oppConnected = msg.opponentConnected;
    state.graceDeadline = msg.opponentConnected ? null : Date.now() + (msg.graceMs || 60000);
    if (wasReconnecting) App.toast('已恢复对局');
    stopReconnect();

    App.setActiveMode('pvp');
    App.setText('game-mode-label', '房间 ' + msg.code);
    App.setText('opponent-name', '对手');
    App.setText('btn-leave-game', '离开房间（判负）');
    App.clearHistory();

    if (msg.history) {
      for (var i = 0; i < msg.history.length; i++) {
        var h = msg.history[i];
        App.addHistoryChip(App.actionName(h.a1) + '/' + App.actionName(h.a2), '');
      }
    }

    if (msg.lastGameOver) {
      // 回来时对局已结束：直接显示结果
      App.showResult(msg.lastGameOver.result, reasonText(msg.lastGameOver));
      var btn = document.getElementById('btn-rematch');
      btn.classList.remove('hidden');
      state.status = 'finished';
      state.lastReason = msg.lastGameOver.reason;
      return;
    }

    if (msg.status === 'waiting') {
      App.setText('lobby-code', msg.code);
      App.setText('lobby-status', msg.opponentConnected ? '等待对手加入…' : '等待对手加入…');
      App.show('lobby-spinner');
      App.showScreen('lobby');
      return;
    }

    // playing：同步本回合状态
    state.acted = msg.acted[msg.seat];
    App.setText('round-label', '回合 ' + msg.round + '/' + Game.MAX_ROUNDS);
    App.hide('banner');
    App.hide('my-action');
    App.hide('opp-action');
    App.setText('opp-status', msg.opponentConnected ? '' : '对手已断开，等待重连…');
    App.showScreen('game');
    refreshPanels();
    if (msg.lastRound) {
      // 展示上一回合双方动作
      var my = msg.seat;
      var myChar = my === 0 ? msg.lastRound.a1 : msg.lastRound.a2;
      var oppChar = my === 0 ? msg.lastRound.a2 : msg.lastRound.a1;
      App.showBadge('my-action', '你：' + App.actionName(myChar), App.actionBadgeClass(myChar));
      App.showBadge('opp-action', '对手：' + App.actionName(oppChar), App.actionBadgeClass(oppChar));
    }
    if (state.acted) {
      App.lockActionButtons();
      App.setText('my-status', '已出招');
      App.setText('opp-status', msg.acted[1 - msg.seat] ? '' : '等待对方出招…');
    } else {
      App.setActionButtons({ u: myBullets() > 0, i: true, o: myBullets() < Game.MAX_BULLET });
    }
    startTick();
  }

  function handleError(msg) {
    switch (msg.code) {
      case 'room_not_found':
      case 'bad_token':
        // 房间已不存在 / 凭证失效（如宽限期满判负）：放弃重连，回菜单
        stopReconnect();
        clearSession();
        App.toast(msg.msg || '房间已失效');
        App.showScreen('menu');
        return;
      case 'seat_taken':
        // 旧连接尚未释放（锁屏僵尸：应用层静默未达接管阈值）：
        // 保留会话继续重试，服务器会在静默超时后允许接管
        if (state.session) {
          App.toast('旧连接释放中，正在重试…');
          scheduleReconnect();
          return;
        }
        clearSession();
        App.toast(msg.msg || '该座位已被占用');
        App.showScreen('menu');
        return;
      case 'room_full':
        App.toast(msg.msg || '房间已满');
        App.showScreen('pvp-menu');
        return;
      case 'game_in_progress':
        App.toast(msg.msg || '该房间对局正在进行中（若是你掉线的对局，请刷新页面自动重连）');
        App.showScreen('pvp-menu');
        return;
      case 'rate_limited':
        App.toast(msg.msg || '操作过于频繁');
        if (state.status === null) App.showScreen('pvp-menu');
        return;
      case 'server_full':
        App.toast(msg.msg || '服务器房间已满');
        if (state.status === null) App.showScreen('pvp-menu');
        return;
      case 'round_resolved':
        App.toast('本回合已结算，你的出招未赶上');
        return;
      case 'already_submitted':
        App.toast('本回合已出招');
        return;
      case 'invalid_action':
        App.toast('当前子弹数无法执行该动作');
        return;
      default:
        App.toast(msg.msg || '出错了');
    }
  }

  function handleClose() {
    if (state.gaveUp) return;
    if (state.session) {
      // 有会话（对局中/等待/加载恢复）：进入重连流程（每次连接失败都重新调度，
      // 直到成功或凭证失效）
      state.connectFails = (state.connectFails || 0) + 1;
      if (state.connectFails >= 4) {
        // 页内重连反复失败（移动端 WebView 冻结后 socket 工厂损坏的已知问题）：
        // 刷新一次页面走 init() 自动重进；已刷过一次仍连不上则回到普通重试循环
        // （防网络恢复前无限刷新风暴）
        var reloadUsed = false;
        try { reloadUsed = sessionStorage.getItem('xnz_pvp_reload_once') === '1'; } catch (e) { /* 忽略 */ }
        if (!reloadUsed) {
          try { sessionStorage.setItem('xnz_pvp_reload_once', '1'); } catch (e) { /* 忽略 */ }
          location.reload();
          return;
        }
        state.connectFails = 0;
      }
      state.reconnecting = true;
      reconnectAttempt = 0;
      reconnectDelay = 1000;
      App.showScreen('disconnected');
      App.setText('disc-status', '连接已断开，正在重连…');
      App.hide('btn-disc-menu');
      scheduleReconnect();
    } else if (intent && (intent.type === 'create' || intent.type === 'join')) {
      // 建房/加入阶段连接失败
      intent = null;
      App.toast('无法连接服务器');
      App.showScreen('menu');
    } else {
      App.toast('连接已断开');
      App.showScreen('menu');
    }
  }

  function scheduleReconnect() {
    stopReconnect();
    reconnectAttempt++;
    App.setText('disc-status', '连接已断开，正在重连…（第 ' + reconnectAttempt + ' 次）');
    reconnectTimer = setTimeout(function () {
      connectPvp();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }

  function stopReconnect() {
    state.reconnecting = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function giveUpReconnect() {
    state.gaveUp = true;
    stopReconnect();
    Net.close();
    clearSession();
    App.showScreen('menu');
  }

  // ==================== 对局操作 ====================
  function submitAction(a) {
    if (state.status !== 'playing' || state.acted) return;
    if (!Game.isFeasible(myBullets(), a)) return;
    send({ type: 'submit_action', action: Game.ACT_CHARS[a] });
    state.acted = true;
    App.lockActionButtons();
    App.showBadge('my-action', '已出招：' + App.actionName(Game.ACT_CHARS[a]), App.actionBadgeClass(Game.ACT_CHARS[a]));
    App.setText('my-status', '');
    App.setText('opp-status', '等待对方出招…');
  }

  function rematchVote() {
    if (state.status !== 'finished' || state.voted) return;
    if (state.lastReason === 'opponent_left') {
      // 对手已离开：房间已回到等待状态，提示等新对手加入
      App.toast('对手已离开，等待新对手加入房间…');
      return;
    }
    if (!Net.isOpen()) {
      // 连接已死（如手机刚解锁）：触发重连，恢复后再投票
      App.toast('连接已断开，正在重连…');
      Net.abort();
      return;
    }
    state.voted = true;
    send({ type: 'rematch_vote', accept: true });
  }

  function leave() {
    stopTick();
    stopReconnect();
    state.gaveUp = true;
    send({ type: 'leave_room' });
    clearSession();
    Net.close();
    App.showScreen('menu');
  }

  // ==================== 显示 ====================
  function myBullets() {
    return state.session && state.session.seat === 0 ? state.b1 : state.b2;
  }
  function oppBullets() {
    return state.session && state.session.seat === 0 ? state.b2 : state.b1;
  }

  function refreshPanels() {
    App.updateBullets('my-bullets-num', 'my-bullets-icons', myBullets());
    App.updateBullets('opp-bullets-num', 'opp-bullets-icons', oppBullets());
    // 连击提示
    if (state.status === 'playing' && state.timeoutStrikes[state.session.seat] > 0) {
      App.setText('my-status', '连续超时 ' + state.timeoutStrikes[state.session.seat] + '/3');
    }
  }

  function showGameOver(msg) {
    App.showResult(msg.result, reasonText(msg));
    // 再来一局按钮始终显示：对手离开时点击会提示等待新对手（房间已回到等待状态）
    var btn = document.getElementById('btn-rematch');
    btn.classList.remove('hidden');
    App.hide('rematch-status-line');
  }

  function reasonText(msg) {
    switch (msg.reason) {
      case 'round_cap':
        return '回合数达到 ' + Game.MAX_ROUNDS + ' 上限';
      case 'opponent_left':
        return '对方已离开房间';
      case 'timeout_loss':
        if (msg.result === 'lose') return '你连续超时 3 次，判负';
        if (msg.result === 'draw') return '双方连续超时，判平';
        return '对方连续超时 3 次，你获胜';
      default:
        return '';
    }
  }

  // ==================== 心跳与倒计时 ====================
  function startTick() {
    stopTick();
    tickTimer = setInterval(tick, 250);
  }
  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function tick() {
    var now = Date.now();
    // 时钟偏移保持：超过 20 秒无服务器消息则主动 ping（ping 失败不刷新
    // lastServerMsgAt，避免掩盖死连接）
    if (now - state.lastPingAt > 20000) {
      send({ type: 'ping' });
      state.lastPingAt = now;
    }

    // 僵尸连接看门狗（所有状态，含大厅与结果页）：手机锁屏唤醒后 socket 可能
    // 半死（未触发 close 事件），超过 40 秒无任何服务器消息则主动断开进入重连流程
    if (!state.reconnecting && !state.gaveUp && state.session &&
        now - state.lastServerMsgAt > 40000) {
      Net.abort();
      return;
    }

    if (state.status !== 'playing') return;

    var el = document.getElementById('countdown');
    if (state.deadline) {
      var remaining = state.deadline - (now + state.offset);
      if (remaining > 0) {
        var sec = Math.ceil(remaining / 1000);
        el.textContent = '剩余 ' + sec + ' 秒';
        el.classList.toggle('warn', remaining < 10000);
        App.show('countdown');
      } else {
        el.textContent = '等待服务器确认…';
        el.classList.remove('warn');
        App.show('countdown');
      }
    } else {
      App.hide('countdown');
    }

    // 对手断线宽限显示
    if (state.graceDeadline !== null) {
      var g = state.graceDeadline - now;
      if (g > 0) {
        App.setText('opp-status', '对手已断开，等待重连（' + Math.ceil(g / 1000) + ' 秒）…');
      } else {
        App.setText('opp-status', '对手已断开，等待服务器确认…');
      }
    }
  }

  // 锁屏唤醒恢复（仅移动端）：实测发现微信/手机浏览器在页面冻结-唤醒后，页内新建的
  // WebSocket 连接不可用（重进请求到不了服务器），而"全新页面加载"的连接则正常。
  // 因此：页面重新可见时若距最后服务器消息超过 20 秒（期间 JS 冻结），直接刷新页面，
  // 由 init() 凭 localStorage 备份自动重进——走实测可靠的那条路。
  // 桌面端不刷新（切换标签页很常见，页内重连即可）。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (!state.session || state.gaveUp) return;
    if (!('ontouchstart' in window)) return;
    if (Date.now() - state.lastServerMsgAt > 20000) {
      location.reload();
    }
  });

  // ==================== 暴露 ====================
  window.ModePvp = {
    init: init,
    enterMenu: enterMenu,
    create: create,
    join: join,
    submitAction: submitAction,
    rematchVote: rematchVote,
    leave: leave,
    giveUpReconnect: giveUpReconnect
  };
})();
