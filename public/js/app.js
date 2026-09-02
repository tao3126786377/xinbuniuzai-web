/* 西部牛仔 · 应用入口：界面路由、菜单、共享 UI 助手 */
(function () {
  'use strict';

  var SCREENS = ['menu', 'pvp-menu', 'lobby', 'game', 'result', 'disconnected'];
  var activeMode = null;   // 'ai' | 'pvp'（决定对局界面按钮文案与行为）

  function $(id) { return document.getElementById(id); }

  function showScreen(name) {
    for (var i = 0; i < SCREENS.length; i++) {
      $( 'screen-' + SCREENS[i]).classList.toggle('hidden', SCREENS[i] !== name);
    }
  }

  function setText(id, text) { $(id).textContent = text; }

  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  /* 底部提示条 */
  var toastTimer = null;
  function toast(text, ms) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, ms || 2600);
  }

  var ACTION_NAMES = { u: '开枪', i: '防御', o: '装弹' };
  function actionName(ch) { return ACTION_NAMES[ch] || ch; }
  function actionBadgeClass(ch) {
    return ch === 'u' ? 'bad-shoot' : ch === 'i' ? 'bad-defend' : 'bad-reload';
  }

  /* 子弹面板刷新：大数字 + 子弹图标 */
  function updateBullets(numId, iconsId, n) {
    $(numId).textContent = String(n);
    var el = $(iconsId);
    el.textContent = '';
    for (var i = 0; i < 10; i++) {
      var b = document.createElement('span');
      b.className = 'bullet' + (i < n ? '' : ' empty');
      el.appendChild(b);
    }
  }

  function showBadge(id, text, cls) {
    var el = $(id);
    el.textContent = text;
    el.className = 'action-badge ' + (cls || '');
    show(id);
  }

  function showBanner(text) {
    var el = $('banner');
    el.textContent = text;
    show('banner');
  }

  /* 三个动作按钮可用性（u 需子弹、o 需未满） */
  function setActionButtons(feas) {
    $('act-u').disabled = !feas.u;
    $('act-i').disabled = !feas.i;
    $('act-o').disabled = !feas.o;
  }

  function lockActionButtons() {
    $('act-u').disabled = true;
    $('act-i').disabled = true;
    $('act-o').disabled = true;
  }

  /* 历史条追加回合芯片 */
  function addHistoryChip(text, cls) {
    var el = $('history-strip');
    var chip = document.createElement('span');
    chip.className = 'history-chip' + (cls ? ' ' + cls : '');
    chip.textContent = text;
    el.appendChild(chip);
    el.scrollLeft = el.scrollWidth;
  }
  function clearHistory() { $('history-strip').textContent = ''; }

  /* 结果界面（result: 'win' | 'lose' | 'draw'；reason 文案） */
  function showResult(result, reason) {
    var title = result === 'win' ? '你赢了！' : result === 'lose' ? '你输了！' : '平局！';
    setText('result-title', title);
    setText('result-reason', reason || '');
    hide('rematch-status-line');
    setText('rematch-status-line', '');
    showScreen('result');
  }

  function setRematchLine(text) {
    setText('rematch-status-line', text);
    show('rematch-status-line');
  }

  window.App = {
    showScreen: showScreen,
    setText: setText,
    show: show,
    hide: hide,
    toast: toast,
    actionName: actionName,
    actionBadgeClass: actionBadgeClass,
    updateBullets: updateBullets,
    showBadge: showBadge,
    showBanner: showBanner,
    setActionButtons: setActionButtons,
    lockActionButtons: lockActionButtons,
    addHistoryChip: addHistoryChip,
    clearHistory: clearHistory,
    showResult: showResult,
    setRematchLine: setRematchLine,
    getActiveMode: function () { return activeMode; },
    setActiveMode: function (m) { activeMode = m; }
  };

  // ==================== 菜单事件 ====================
  // 动作按钮：按当前模式分发（AI 本地结算 / PvP 提交服务器）
  $('act-u').addEventListener('click', function () {
    if (activeMode === 'ai') ModeAI.onAction(Game.ACT_U);
    else ModePvp.submitAction(Game.ACT_U);
  });
  $('act-i').addEventListener('click', function () {
    if (activeMode === 'ai') ModeAI.onAction(Game.ACT_I);
    else ModePvp.submitAction(Game.ACT_I);
  });
  $('act-o').addEventListener('click', function () {
    if (activeMode === 'ai') ModeAI.onAction(Game.ACT_O);
    else ModePvp.submitAction(Game.ACT_O);
  });

  $('btn-mode-ai').addEventListener('click', function () {
    ModeAI.enter();   // 首次进入时构建 AI 会话（懒加载，带遮罩）
  });

  $('btn-mode-pvp').addEventListener('click', function () {
    activeMode = 'pvp';
    ModePvp.enterMenu();
  });

  $('btn-pvp-back').addEventListener('click', function () {
    showScreen('menu');
  });

  $('btn-create').addEventListener('click', function () {
    ModePvp.create();
  });

  $('btn-join').addEventListener('click', function () {
    ModePvp.join($('join-code').value.trim());
  });

  $('btn-copy').addEventListener('click', function () {
    var code = $('lobby-code').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () {
        toast('已复制房间号 ' + code);
      }, function () {
        fallbackCopy(code);
      });
    } else {
      fallbackCopy(code);   // 微信内置浏览器可能屏蔽 clipboard API
    }
  });

  function fallbackCopy(code) {
    var range = document.createRange();
    var sel = window.getSelection();
    var el = $('lobby-code');
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    toast('已选中房间号，长按复制');
  }

  $('btn-leave-lobby').addEventListener('click', function () {
    ModePvp.leave();
  });

  $('btn-leave-game').addEventListener('click', function () {
    if (activeMode === 'ai') ModeAI.abortToMenu();
    else ModePvp.leave();
  });

  $('btn-rematch').addEventListener('click', function () {
    if (activeMode === 'ai') ModeAI.startGame();
    else ModePvp.rematchVote();
  });

  $('btn-result-menu').addEventListener('click', function () {
    if (activeMode === 'ai') ModeAI.toMenu();
    else ModePvp.leave();
  });

  $('btn-disc-menu').addEventListener('click', function () {
    ModePvp.giveUpReconnect();
  });

  $('btn-rules').addEventListener('click', function () {
    show('rules-modal');
  });

  $('btn-rules-close').addEventListener('click', function () {
    hide('rules-modal');
  });

  // ==================== 启动 ====================
  showScreen('menu');
  setText('version-note', '网页版 v0.10');
  console.log('西部牛仔 网页版 v0.10');

  // 页面加载：若存在未完成的 PvP 会话则静默重进（刷新/杀后台恢复）
  ModePvp.init();

  // 菜单脚注：统计历史对局数（不构建模型，仅数行；只统计正常结束的对局）
  try {
    var logText = localStorage.getItem('xnz_log_v1') || '';
    var games = (logText.match(/^GAME_END NORMAL/gm) || []).length;
    setText('ai-memory-note', games > 0 ? '电脑已记住你的 ' + games + ' 局历史对局' : '电脑还未记录你的对局');
  } catch (e) {
    setText('ai-memory-note', '');
  }
})();
