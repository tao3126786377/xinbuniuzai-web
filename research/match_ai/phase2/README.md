# 第二阶段：行为预测模块研究

独立离线研究，无网页接入、推送或部署。第一阶段报告和算法保持不变。

本轮使用两类诊断：缩小规则上的精确已知对手规划，以及完整规则上的预测模块替换实验。神经网络是最近八条公开事件的固定窗口 MLP，不是 RNN；模型权重对局期间固定。没有训练价值网络。

## 复跑

在 `web/` 目录，用第一阶段装好依赖的 Python 运行。只需要既有 NumPy、SciPy、Numba，不新增深度学习框架。PowerShell 示例：

```powershell
$env:OPENBLAS_NUM_THREADS='1'
python -m unittest discover -s research/match_ai/tests -v
python -m research.match_ai.phase2 oracle
python -m research.match_ai.phase2 data
python -m research.match_ai.phase2 train
python -m research.match_ai.phase2 prediction
python -m research.match_ai.phase2 games --games 128 --workers 4
python -m research.match_ai.phase2 report
```

默认使用第一阶段 `research/artifacts/full` 均衡表，结果位于 `research/artifacts/phase2`；报告生成到本目录的 `results/`。可用 `--baseline` 和 `--output` 指定路径。正式数据和对局使用完整规则；oracle 命令另建两轮、每轮两回合、初始筹码 10 的精确诊断表。

精确诊断沿用第一阶段的固定规则对手；完整规则实验使用本阶段新增的随机参数行为族。同名对手的参数不必相同，两项实验的得分不能直接相减。

`data` 先生成完整且独立的合成玩家历史，再按历史划分训练/验证/测试；训练阶段只打开 train 和 validation，不打开 test。训练标签是实际揭示的动作；真实行为分布仅作为测试诊断数据。

训练：六类行为 × 64 位合成玩家 × 两局；验证：六类 × 16 位 × 两局；预测测试：八类 × 32 位 × 两局。后两类行为（模仿、伺机出招）不参与训练或选择。每位玩家随机生成噪声、偏好等参数，名字和参数均不会进入学习模型输入。数据收集混合均衡与随机探索，不声称该收集策略具有安全保证。

线性分类器和 107→64→3 tanh 网络输入完全相同。训练仅以验证 NLL 选择早停轮次。训练/验证/预测测试/实际对局使用不同 SeedSequence 空间；对局实验的随机玩家也独立生成。

## 模块接口

- `features(state, history, equilibrium)`：107 维公开信息。双方筹码保留独立值，仅作固定尺度缩放。最近八条公开事件包含选弹/出招、双方动作、轮末、局末和公开轮结果。
- `remember(history, event(...))`：在动作揭示后返回新的不可变历史，不修改先前历史。跨轮跨局保留窗口和边界。
- `Predictor.probabilities(features, mask)`：输出全局动作编号 0/1/2 的概率，非法动作掩码为零。初始选弹阶段也是 0/1/2，由阶段特征区分。
- `Predictor.load(path)`：加载 `linear.npz` 或 `neural.npz`；不会进行在线训练。
- `Lookahead.decision(state, history, belief)`：返回合法动作列表顺序对应的概率及诊断。网络、线性、贝叶斯和已知对手使用相同短前瞻；无历史时实际行动回到均衡。
- `oracle_values(equilibrium, opponent, verify_response=True)`：小规模完整精确规划，并计算该受保护策略的整局最佳反制。

## 解释限制

完整对局控制变量实验使用一步/两步全分支前瞻，在搜索末端接精确均衡价值。它让我们只更换预测模块，但它不是原完整 MCTS，也不是贝叶斯全局最优。已知对手在两步前瞻中也未必打得最好；只有小规模完整 oracle 给出局部约束下的精确上界。

贝叶斯基线仍是原来的 729 类型先验，没有针对新生成的数据离线训练，输入上下文也更短。因此网络与贝叶斯的差异包含数据和表达能力差异。网络与同输入线性模型的比较才用于考察非线性结构。

所有真实决策和搜索节点使用原精确均衡表作安全约束；网络不负责证明安全。0.02 预算未改，代价是约 402 MiB 的原表仍然存在。

预测置信区间按完整独立历史 bootstrap，单个回合不作为独立样本。对局得分采用配对差值，主区间是保守的 Hoeffding 区间，另保留 bootstrap 辅助结果。多类结果为探索性比较；不宣称对所有行为同时成立的显著性。
