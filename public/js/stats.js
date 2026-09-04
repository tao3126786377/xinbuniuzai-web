/* 西部牛仔 · 菜单统计与对局记录（纯客户端，读 localStorage 日志）
 *
 * - refresh()：主菜单脚注分模式显示对局数与胜率（快速模式读 xnz_log_v1；
 *   完整模式的电脑对手开发中，暂显示"暂无对局"）
 * - openHistory()/closeHistory()：对局记录弹窗，最近 20 局，
 *   结果由回放 Game.step 得出，动作用中文（开枪/防御/装弹，不用 u/i/o）
 *
 * 胜率口径：胜率 = 胜 / (胜 + 负)，平局单列显示。
 */
(function () {
  'use strict';

  var LOG_KEY_FAST = 'xnz_log_v1';
  var MAX_SHOW_GAMES = 20;

  function actionName(ch) {
    if (ch === 'u') return '开枪';
    if (ch === 'i') return '防御';
    if (ch === 'o') return '装弹';
    return ch;
  }

  /* 解析日志为对局列表（只取 GAME_END NORMAL；结果由回放 Game.step 得出）。
   * 返回 [{ rounds: [{b1,b2,pa,ca}], outcome: 'win'|'lose'|'draw' }] */
  function parseGames(logText) {
    var games = [];
    var rounds = null;
    var lines = logText.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line.indexOf('GAME_START') === 0) {
        rounds = [];
      } else if (line.indexOf('GAME_END') === 0) {
        if (rounds && line.indexOf('NORMAL') !== -1 && rounds.length > 0) {
          games.push(rounds);
        }
        rounds = null;
      } else if (rounds) {
        var m = line.match(/^(\d+)\s+(\d+)\s+(\S)\s+(\S)\s+(\d+)$/);
        if (m) rounds.push({ b1: +m[1], b2: +m[2], pa: m[3], ca: m[4] });
      }
    }
    var out = [];
    for (var g = 0; g < games.length; g++) {
      var rs = games[g];
      var b1 = 0, b2 = 0, outcome = 'draw', ok = true;
      for (var r = 0; r < rs.length; r++) {
        var rr = rs[r];
        if (rr.b1 !== b1 || rr.b2 !== b2) { ok = false; break; }   // 与回放不符：跳过该局
        var a1 = Game.charToAction(rr.pa), a2 = Game.charToAction(rr.ca);
        if (a1 < 0 || a2 < 0) { ok = false; break; }
        var st = Game.step(b1, b2, a1, a2);
        b1 = st.b1;
        b2 = st.b2;
        if (st.winner !== -1) {
          outcome = st.winner === 1 ? 'win' : st.winner === 2 ? 'lose' : 'draw';
          break;
        }
      }
      if (ok) out.push({ rounds: rs, outcome: outcome });
    }
    return out;
  }

  /* 主菜单脚注：分模式对局数与胜率 */
  function refresh() {
    var fastText = '';
    try { fastText = localStorage.getItem(LOG_KEY_FAST) || ''; } catch (e) { /* 忽略 */ }
    var games = parseGames(fastText);
    var wins = 0, losses = 0, draws = 0;
    for (var i = 0; i < games.length; i++) {
      if (games[i].outcome === 'win') wins++;
      else if (games[i].outcome === 'lose') losses++;
      else draws++;
    }
    var fastLine;
    if (games.length === 0) {
      fastLine = '快速模式：暂无对局记录';
    } else {
      var rate = wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
      fastLine = '快速模式：' + games.length + ' 局（胜 ' + wins + ' / 负 ' + losses +
        ' / 平 ' + draws + '，胜率 ' + rate + '%）';
    }
    // 内容全部由数字拼接，无用户输入，innerHTML 安全
    document.getElementById('ai-memory-note').innerHTML =
      fastLine + '<br>完整模式：暂无对局（开发中）';
  }

  /* 对局记录弹窗：最近 20 局（新在前），动作用中文 */
  function openHistory() {
    var fastText = '';
    try { fastText = localStorage.getItem(LOG_KEY_FAST) || ''; } catch (e) { /* 忽略 */ }
    var games = parseGames(fastText);
    var list = document.getElementById('history-list');
    list.textContent = '';
    if (games.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'hist-empty';
      empty.textContent = '暂无对局记录（完整模式的电脑对手开发中，暂不计入）';
      list.appendChild(empty);
    } else {
      var start = Math.max(0, games.length - MAX_SHOW_GAMES);
      for (var i = games.length - 1; i >= start; i--) {
        var g = games[i];
        var block = document.createElement('div');
        block.className = 'hist-game';
        var title = document.createElement('div');
        title.className = 'hist-title hist-' + g.outcome;
        title.textContent = '第 ' + (i + 1) + ' 局 · ' +
          (g.outcome === 'win' ? '你赢了' : g.outcome === 'lose' ? '你输了' : '平局') +
          ' · ' + g.rounds.length + ' 回合';
        block.appendChild(title);
        block.appendChild(movesRow('你：', g.rounds, true));
        block.appendChild(movesRow('电脑：', g.rounds, false));
        list.appendChild(block);
      }
    }
    document.getElementById('history-modal').classList.remove('hidden');
  }

  function movesRow(label, rounds, isPlayer) {
    var div = document.createElement('div');
    div.className = 'hist-moves';
    var lab = document.createElement('span');
    lab.className = 'hist-label';
    lab.textContent = label;
    div.appendChild(lab);
    var parts = [];
    for (var i = 0; i < rounds.length; i++) {
      parts.push(actionName(isPlayer ? rounds[i].pa : rounds[i].ca));
    }
    div.appendChild(document.createTextNode(parts.join(' · ')));
    return div;
  }

  function closeHistory() {
    document.getElementById('history-modal').classList.add('hidden');
  }

  window.Stats = {
    refresh: refresh,
    openHistory: openHistory,
    closeHistory: closeHistory
  };
})();
