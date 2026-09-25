# 完整模式电脑决策：full-temporal3-v1

固定第五阶段选出的 `temporal3`：203→96→3 行为网络、最近 64 次公开事件、三步同时行动规划、原安全约束。模型参数固定，历史统计每次揭示后更新。选弹与轮内出招均已实现，最终从安全分布随机采样。

这是可调用的 **Node.js 模块**，不依赖 Python 运行时或实验脚本。已通过 `worker.js` / `http.js` 接入本地完整人机菜单，在后台线程中计算；原快速模式和联机协议保持原状。公网更新步骤见 [DEPLOY_RENDER.md](../../DEPLOY_RENDER.md)。

## 调用方式

```js
const { createEngine } = require('./lib/match-ai');
const { prepare } = require('./tools/prepare_match_ai');
const engine = createEngine({ tablesPath: await prepare() }); // 整个进程复用一个引擎和有上限的读表缓存
const session = engine.createSession(); // 每位玩家独立会话

const ready = session.prepareDecision(); // 电脑已锁定；不会公开动作或概率
// 接着等待玩家提交，完整选弹阶段为 0/1/2 颗，出招阶段为 0=枪/1=防/2=装。
const revealed = session.reveal(ready.decisionId, humanAction);
// revealed.computer / human：双方动作；state：新状态；settlement：结算；score：终局得分。
// score 从电脑视角计：胜 1，平 0.5，负 0；未结束为 null。

const publicState = session.getState();
if (publicState.over) session.startNextMatch(); // 新一局，保留过去公开行为记忆

const saved = session.exportMemory(); // 调用方可保存为独立的完整模式玩家记忆
const restored = engine.createSession({ memory: saved });
// 引擎不自行读写任何玩家日志，不读取快速模式历史。
engine.close(); // 退出进程或彻底停止使用时关闭文件句柄
```

`prepareDecision()` 重复调用返回同一个决定，不会重新抽签；它不接收玩家的本次动作。只有 `reveal()` 才接收玩家已提交的选择，同时更新规则状态及历史。过期、重复决定和非法动作会被拒绝；非法提交不会清除原已锁定决定。返回状态、记忆均为副本，调用方修改不会影响内部会话。

测试可传 `{ seed: 123 }` 获得相同电脑抽样序列。重新创建会话只恢复行为记忆，不恢复未完成游戏或隐藏电脑动作。真实服务端不得把未揭示的 `engine.decide()` 结果发给玩家。

内部状态明确使用电脑视角：`mc/bc/pc` 是电脑筹码/当前子弹/初始子弹，`mh/bh/ph` 是玩家对应值。**这和快速模式 UI 的 b1=玩家约定不同**；接页面时应显式映射。运行时直接调用现有 `public/js/game.js` 与 `match.js` 完成规则和筹码结算。

## 固定模型与数据

- `policy.json` 固定版本、结构、参数和模型/均衡清单 SHA-256。
- `weights.bin` 为 19,875 个 float64 权重，共 159,000 字节，随模块保存。
- 均衡表默认从 `research/artifacts/full` 读取，或用 `createEngine({ tablesPath })` 指定完整路径。
- 均衡表磁盘资源约 402 MiB，**仍是必需文件**；模块按轮和筹码组合读取，最多缓存 32 个块（约 6.59 MiB），另有最多 5,000 个状态查询缓存。它不是浏览器直接加载的版本，也没有通过近似小表冒充原安全基线。

加载时检查权重哈希、表清单版本、数组形状/长度；不兼容资源直接报错。查询拒绝不可达状态。发布资源已经压缩为 `assets/match-ai/*.gz`（合计约 80 MB）；`npm run build` 校验 SHA-256 后流式解压到忽略目录 `.runtime/match-ai/`，正式服务使用该路径。仅模型发生变化时才需重新 `npm run pack:match-ai`。

## 网页接口

- `GET /api/match-ai/health`：资源就绪状态。
- `POST /api/match-ai/session`：传 `requestId` 和可选 `memory`，返回随机会话令牌、公开状态及已锁定的决定编号。
- `POST /api/match-ai/step`：传 `sessionId/decisionId/action`，返回本次公开结果与下一步决定编号。相同决定和动作重试返回同一结果，不重复结算或学习。
- `POST /api/match-ai/rematch`：传 `sessionId/gameNumber`，完成后再战，保留记忆；相同局号重试幂等。
- `DELETE /api/match-ai/session`：传 `sessionId` 释放会话。

下一步电脑动作和概率留在服务器。会话闲置 30 分钟过期；每 IP 最多 4 个，总计最多 128 个。请求有限流、体积和来源检查，计算队列有上限。完整模式浏览器使用 `xnz_match_memory_v1` / `xnz_match_history_v1`，不混入 `xnz_log_v1`。模型权重不在线重训。

## 决策预算与诊断

默认 `prepareDecision({ budgetMs: 2500 })`，可缩小预算。搜索超过预算或预测出现非有限值时，返回当前状态的均衡策略；概率求解也有数值检查。由于文件读取和当前一步运算不可中断，预算是软上限；本机测时不保证手机或部署服务器性能。

终局揭示后，`revealed.decision` 中可以查看合法动作顺序、最终分布、三步动作得分和诊断。`diagnostics` 包括节点数、耗时、单步最大损失、数值回退次数和预算回退原因。无历史时使用均衡；持续对局中保留历史，网络权重不在线重训。

离线诊断也可用 `engine.decide(state, history, options)`。其中 `history` 为本模块格式的已公开事件；正式游戏优先使用 `createSession()`，让模块维护阶段和记忆，避免调用方错序或混入未公开动作。

## 复现与检查

已有完整表时，从 `web/` 执行：

```powershell
# 以下两步只用于离线导出和移植验证，不是 Node 服务的运行依赖。
python tools/export_match_ai.py
python tools/gen_match_ai_reference.py
npm run test:match-ai
npm run test:ai
```

依赖沿用 `research/.deps` 或研究环境。缺少完整表时先按 `research/match_ai/README.md` 构建；重新构建后再次导出会绑定新表清单。导出只接受第五阶段已经选定的权重，不会自动训练或根据测试重新选模型。

移植验证覆盖 Python/JS 状态转移、网络特征与概率、三步动作价值、安全小矩阵，以及重复请求、旧决定拒绝、跨轮/跨局记忆、持久化恢复和预算回退。浮点等值时可以选择不同的同分安全分布，测试比较实际动作价值，不要求这些等值分布逐项相同。

`VALIDATION.json` 是决策移植验证摘要；详细参考数据在忽略目录 `research/artifacts`。网页集成另运行 `npm run test:match-web`；当前本地改动尚未推送到公网。
