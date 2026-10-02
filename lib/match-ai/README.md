# 完整模式电脑决策：full-temporal3-belief005-v1

v0.16.0 使用原 203→96→3 行为网络及 814 个行为假设的贝叶斯模型库。每次公开动作后更新后验并回补 0.5% 基础先验；三步同时行动规划的模拟分支也推进后验。动态整局风险余额保留，整局相对均衡的最坏期望得分损失仍低于 0.02。网络参数固定，后验与公开历史跨轮、跨局保存。选弹与轮内出招均按安全分布随机采样。

这是可调用的 **Node.js 模块**，不依赖 Python 运行时或实验脚本。已通过 `worker.js` / `http.js` 接入本地完整人机菜单，在后台线程中计算；原快速模式和联机协议保持原状。公网更新步骤见 [DEPLOY_RENDER.md](../../DEPLOY_RENDER.md)。

## 调用方式

```js
const { createEngine } = require('./lib/match-ai');
const { prepare } = require('./tools/prepare_match_ai');
const engine = createEngine({ tablesPath: await prepare(), strategy: 'belief' }); // 网页发布策略
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

默认 `prepareDecision({ budgetMs: 2500 })`，可缩小预算。动态余额搜索超时使用已完整求值且安全的一步分布，没有完成结果或预测异常时使用均衡分布；概率求解也有数值检查。由于文件读取和当前一步运算不可中断，预算是软上限；本机测时不保证手机或部署服务器性能。

每局初始余额 0.0199。玩家动作公开后按 `R' = max(0, R + p·Qeq[:,b] - Veq)` 更新，`p` 为揭示前锁定的完整分布，不按抽中动作更新。换轮不重置；再来一局才重置。会话 `snapshot.credit` 和揭示结果 `risk.before/after` 可核对余额。客户端不能覆盖会话余额，重复请求不重复扣减。

记忆外层仍使用 `full-temporal3-v1` 标识原网络及公开事件格式；新增 `belief` 保存 `fixed-share-005-v1` 后验概率、轮内行动计数和观察计数。旧记忆保留事件，新后验从先验开始。旧版回滚仍可读取事件，但不保存新增后验。实际对局 `policy` 为 `full-temporal3-belief005-v1`。记忆不保存进行中的状态或余额，刷新后重新开局，不能在旧筹码局面补回初始余额。恢复请求上限为 32 KiB。

终局揭示后，`revealed.decision` 中可以查看合法动作顺序、最终分布、三步动作得分和诊断。`diagnostics` 包括节点数、耗时、单步最大损失、数值回退次数和预算回退原因。无历史时使用均衡；持续对局中保留历史，网络权重不在线重训。

本地 v0.14.1 增加决策诊断：每次揭示后可查看此前锁定的 `humanPrediction`、均衡玩家分布、动作得分跨度、相对均衡分布的距离、预测收益差与 `safetyLimited`。`predictionReview` 用真实公开动作计算该次冻结预测的 NLL/Brier；决定锁定前不公开这些信息，网络参数与安全预算保持原样。

页面在完成的对局记录中保存诊断与开局公开记忆，菜单“导出完整人机诊断”输出 `xnz-match-diagnostics-v1` JSON，移除服务器会话令牌。旧记录没有预测时分析器跳过，不补造。`node tools/analyze_match_ai.js <导出文件.json>` 给出描述性汇总与值得复查的事件；动作得分差是搜索估计，不是真实整局损失。记录只在当前浏览器保存，未增加自动上传或集中训练。

离线诊断也可用 `engine.decide(state, history, {credit, budgetMs})`，调用者负责提供实际余额；该单次调用使用新后验，不用于还原已有会话。正式游戏使用 `createSession()` 自动维护后验、余额和阶段。省略 `strategy` 保留原静态策略，`credit` 保留旧动态余额策略，均用于历史对照；网页工作线程显式选择 `belief`。新增检查为 `node test/match_ai_belief.js`。

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

`VALIDATION.json` 是原决策移植验证摘要；详细参考数据在忽略目录 `research/artifacts`。已有离线参考数据时，`node test/match_ai_credit_runtime.js` 对照研究版及会话余额；网页集成运行 `npm run test:match-web`。本次发布检查见 [发布说明](../../RELEASE_AI_V0_15.md)。
