# 第三阶段：行为预测的可靠性与风格变化

本阶段仅做离线研究。神经网络继续用于从公开历史预测玩家行为；子弹、筹码、均衡价值和安全约束均使用既有精确规则。没有训练价值网络，没有接入网页、推送或部署。

## 研究控制

沿用第二阶段的 7,107 参数网络和线性预测器，权重文件完全冻结。新模块不判断“这个玩家一定属于未知分布”，而是比较多个预测器在已经揭示的动作上的相对可信度。

三个专家依次为：校准后的神经网络、校准后的线性模型、合法动作均匀分布。均匀分布只表示对玩家动作的保守预测；电脑实际出招仍需通过精确安全约束。

比较以下控制器，全部采用相同的两步全分支前瞻，搜索末端接精确均衡价值：

- `equilibrium`：原始均衡基线。
- `linear`：经验证集校准的线性预测器。
- `neural`：未经本轮校准的原网络。
- `calibrated`：仅做概率温度校准的网络。
- `static`：三个专家的固定混合，权重由验证集交叉熵最优化得到。
- `adaptive`：每次真实／模拟动作揭示后都更新专家权重。
- `frozen`：真实观测后更新，但搜索未来时冻结专家权重；公开动作历史仍正常推进。

所有控制器无当前玩家观测时实际行动使用均衡。上述校准温度属于**玩家行为预测概率**，不是第一阶段用于电脑出招的熵温度；本轮出招熵温度固定为 0，但仍按求得的分布随机采样。

## 可核对的证据更新

对已公开的人类动作 b，先计算 `posterior[k] ∝ weight[k] × expert[k][b]`，再计算 `new_weight[k] = (1-share) × posterior[k] + share/3`。所有计算使用对数权重防止长序列下溢。

分享率 share 在验证集上从 `{0, 0.005, 0.01, 0.05, 0.1, 0.2}` 中选择。它让过去暂时表现不好的专家保留重新获得权重的机会。预测温度从 `{0.75, 1, 1.5, 2, 3, 4}` 中选择。仅使用已揭示动作的 NLL，不使用对手类型或生成器真实概率选择参数。

这不是原 729 类型玩家后验；原贝叶斯算法保持不变。本轮新增的专家权重在跨轮、跨局时连续保留，分享发生在每条观测后，没有额外重复更新。`event_id` 必须连续递增，重复或跳号会报错。网络参数始终固定。

share=0 时，在同一条已观测序列上，混合预测累计对数损失不超过最好的单个专家累计损失加 ln(3)。这是预测损失性质，不是胜率保证，也不能证明识别了未知玩家。实际采用的非零分享率需要另外计入代价；0.02 对局保证始终来自原精确均衡安全约束。

## 数据与划分

使用新的 `[20260925, 3, split, family, profile, stream]` SeedSequence。验证集包含原八类行为和轮内换风格，共 288 条独立玩家历史；每条历史包含两局。上一轮已经暴露问题的 mimic/ambush 现在是开发域，不能再称为完全未知测试。

新测试集另加入 delayed（三步延迟反应）与 contrarian（近期动作频率和筹码共同影响反制），两类完全不参与验证选择。预测测试每类 64 条独立历史；完整规则对局每类 128 位独立玩家、每个控制器一局，另用 games 种子空间。

数据收集使用均衡与随机探索的混合以覆盖局面。该收集策略不声称符合候选策略的 0.02 保证。生成器真实概率和风格切换位置仅用于测试诊断，绝不进入预测器或规划器。

## 复跑

在 `web/` 目录使用前两阶段已安装依赖的 Python，无新依赖：

```powershell
$env:OPENBLAS_NUM_THREADS='1'
python -m unittest discover -s research/match_ai/tests -v
python -m research.match_ai.phase3 data
python -m research.match_ai.phase3 select
python -m research.match_ai.phase3 prediction
python -m research.match_ai.phase3 games --games 128 --workers 4
python -m research.match_ai.phase3 decisions
python -m research.match_ai.phase3 report
```

默认均衡表为 `research/artifacts/full`，冻结模型来源为 `research/match_ai/phase2/results`，实验输出为 `research/artifacts/phase3`。可通过 `--baseline`、`--source`、`--output` 指定；报告写入本目录的 results。结果、权重和哈希随报告保存，大型序列数据及首局追踪日志位于 artifacts。

`Forecast.experts(state, history, equilibrium)` 只接收公开状态与历史。`Evidence.update(experts, action, share, event_id)` 必须在动作揭示后调用，返回新的不可变证据；搜索分支不会修改真实证据。`ReliabilityPlanner.decision` 返回与 `actions(state)[0]` 同序的概率，以及决策前的预测和安全诊断。

主对局差值区间使用分布无关 Hoeffding 区间，另提供配对 bootstrap 辅助区间。预测差值按完整独立玩家历史 bootstrap；ECE、置信度和换风格分桶是描述性诊断，不能据此宣称因果恢复时间。各类型区间没有进行多重比较校正。

`decisions` 在每类第一局原网络轨迹上等距抽取最多 12 个状态，重建当时的公开历史与专家证据，并在相同状态下比较控制器概率。用知道对手的共同两步后续策略评价当前分布的机会损失。它是查看对局结果后的探索性诊断，不参与参数选择；不是整局后悔值或独立的新测试集。
