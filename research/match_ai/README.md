# 完整模式 AI 离线研究

本目录是独立研究模块，不被网页或服务器加载。不会推送代码、部署服务、读取快速模式历史或写入浏览器存储。既有快速模式修补保持不变。

最新阶段：[训练与对局选优](phase5/README.md)与[第五阶段结果](phase5/results/REPORT.md)，直接训练长历史行为模型并比较完整对局得分。前一阶段的[历史价值诊断](phase4/results/REPORT.md)保留供参考。

## 运行

在 `web/` 目录运行，建议 Python 3.12 虚拟环境：

```powershell
python -m venv research/.venv
research/.venv/Scripts/python.exe -m pip install -r research/match_ai/requirements.txt
research/.venv/Scripts/python.exe -m unittest discover -s research/match_ai/tests -v
research/.venv/Scripts/python.exe -m research.match_ai build
research/.venv/Scripts/python.exe -m research.match_ai audit
research/.venv/Scripts/python.exe -m research.match_ai tune --simulations 8 --workers 4
research/.venv/Scripts/python.exe -m research.match_ai evaluate --simulations 8 --workers 4 --max-games 128
research/.venv/Scripts/python.exe -m research.match_ai probes
research/.venv/Scripts/python.exe -m research.match_ai learning
research/.venv/Scripts/python.exe -m research.match_ai report
```

也支持把依赖安装到 `research/.deps/`，包初始化会自动读取此目录。本次执行采用这个方式，未更改系统 Python。实际依赖版本记录在实验报告中。

大表、Numba 编译缓存、模拟日志位于忽略目录 `research/artifacts/`。完整均衡表约 402 MiB，首次计算包含编译耗时。不同缩小规则必须使用不同 `--baseline` 目录，例如：

```powershell
python -m research.match_ai build --rounds 2 --cap 2 --money 10 --baseline research/artifacts/tiny
```

`--max-games` 支持 128 到 2048，步长 128。每个样本是独立合成玩家历史加一局测试，避免把连续学习过程中的相关对局误当独立样本。调参默认每种对手 16 个样本、五种温度；正式测试每种对手至少 128 个样本、三种规划器。训练、调参、测试的随机种子通过不同 SeedSequence 命名空间产生。调参完成后才能测试，且模拟预算必须一致。

## 模型与接口

- `rules.State`：电脑固定为座位 0，玩家为座位 1。动作编码 `0=开枪、1=防御、2=装弹`；合法出招列表顺序为 `[防御, 开枪, 装弹]`，选弹顺序为 `[0,1,2]`。动作概率必须和返回的 `actions` 一起解释。
- `transition(state, computer_action, human_action, config)`：返回下一状态、终局得分和结算元数据。终局得分胜 1、平 0.5、负 0；中间不奖励筹码或单轮胜负。
- `Equilibrium.query(state)`：返回电脑均衡价值、电脑分布、玩家分布及动作对延续价值矩阵。只支持从配置初始条件可达的状态；不把未计算状态当成零价值。
- `OpponentModel.update(state, belief, human_action, round_end, event_id)`：只接受已公开玩家动作。`event_id` 必须严格递增；轮末遗忘只应用一次。对局结束后的遗忘由下一局调用方执行。
- `Planner.decision(state, belief, simulations, seconds, seed)`：返回动作、概率、预测得分、模拟数、耗时、安全下限和回退诊断。`equilibrium/frozen/belief` 分别表示均衡、模拟未来时冻结信念、模拟未来时更新信念。三者都可在真实观察后更新模型。

729 个候选模型是六个参数 `{-2,0,2}^6` 的笛卡尔积。先验是独立的 `{0.1,0.8,0.1}`。以完整模式玩家均衡混入 2% 合法动作均匀概率作为基础，再指数倾斜：开枪偏好、装弹偏好、电脑上次开枪后的防御、筹码劣势下的非防御倾向、上一轮输赢后的非防御倾向、初始选弹偏好。玩家筹码劣势为 `(电脑筹码-玩家筹码)/(双方筹码和)`；玩家上一轮输/平/赢编码为 `+1/0/-1`。选弹受后三项中的筹码、上轮结果和选弹参数影响。

轮间以 `0.95 × 后验 + 0.05 × 初始先验` 预测下一轮类型，重置上一回合动作、保留上轮结果。跨局也执行一次此混合。这等价于轮间有 5% 概率重新抽取类型，而不是声称玩家永远不改变策略。

## 求解与安全范围

有限时域动态规划求解完整规则，不使用快速模式价值表。小矩阵求解器枚举 maximin 线性规划的支持顶点，并同时计算双方分布和原始/对偶间隙。累计误差上界为最大局部间隙加浮点余量，再乘最大决策数；超过 0.0001 拒绝进入受保护的规划。额外的 `audit` 独立反推双方针对固定均衡策略的整局最佳响应。

每次实际决策和搜索树内的模拟决策均满足：

`min_b p · Qeq[:, b] >= Veq - 0.0199/505`。

沿对局望远镜求和后，整局损失最多是 `505 × (delta + 1e-11) + 基线数值误差`。这里 `1e-11` 是每步概率求解的验收容差，已计入预算；规划器还会检查总和是否超过 0.02。该保证针对完整规则的终局期望得分，不等于严格胜率损失最多 2 个百分点，也不等于模型预测准确。缩小规则仍使用生产的 delta，因此更加保守。

熵只用于当次策略选择，绝不加进模拟奖励；因此不会为获取更多熵奖励故意拖延。合法概率集合至多是二维多边形，在其内部 softmax 候选及边界上优化。数值检查失败时回到均衡。无完整模式观测时也直接采用均衡。

完整规模搜索是近似 Bayesian MCTS：按受约束的乐观分布分配搜索样本、逐步扩展动作对分支、以真实终局得分回传。未访问动作的初值来自均衡延续价值。有限预算、均衡尾部策略及受约束探索会产生估值偏差，不宣称求得贝叶斯全局最优。

尾部用均衡完成整局。因为这个策略不依赖信念，可以从叶节点信念抽取隐藏类型，并在换轮时模拟 5% 类型重抽，等价地边缘化中间后验更新。冻结版本每一步都从同一冻结分布重新抽类型，以对应固定预测模型。此优化经过小规模精确预测树对照。

`seconds` 是软预算：当前一条完整模拟及最终概率求解会完成后才返回。首次 JIT 编译不属于稳定运行耗时，正式测时会先预热。桌面测试不代表手机性能；2～3 秒目标尚须网页实现后实机验证。

## 实验解释

对手包括均衡、均匀随机、95% 装弹偏好、95% 开枪偏好、记忆反应、筹码敏感、逐轮切换、知道电脑分布的反制者。最后一种选择使均衡延续价值最低的玩家动作，**不是**对历史依赖学习策略的精确整局最佳响应。精确均衡最佳响应和逐步安全约束另行验证。

得分区间使用有界变量 Hoeffding 95% 区间，胜/负/平率用 Wilson 区间。配对差值也用 Hoeffding 区间，最多 16 次批次查看采用 Bonferroni 校正；因此小样本结论通常较保守。没有显著差异不能解释为策略完全相等。

`learning` 测量的是揭示动作之前的预测交叉熵，相同上下文下比较学习后模型与原始先验；它只能说明识别倾向的效果，不能单独证明胜率提高。所有日志和实验均为合成数据，不包含真人实验。

样例日志含局/轮/回合边界、决策前状态、双方公开动作、筹码结算、终局结果和概率诊断，标记 `source=synthetic`。完整日志留在 artifacts；紧凑结果与报告可保留到版本库。
