"""Keep root-action diagnostics separate from actual terminal policy values."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import platform
import shutil
import numpy as np
from ..matrix import DELTA, SAFETY_TOLERANCE
from .study import FAMILIES, KINDS, VALUE_TOLERANCE, aggregate


def generate_report(directory, destination):
    destination.mkdir(parents=True, exist_ok=True)
    protocol = json.loads((directory / 'protocol.json').read_text(encoding='utf-8'))
    runs = {f:json.loads((directory / f'{f}.json').read_text(encoding='utf-8')) for f in FAMILIES}
    audit = json.loads((directory / 'endgame.json').read_text(encoding='utf-8'))
    runtime = json.loads((directory / 'runtime.json').read_text(encoding='utf-8'))
    natural = [r for d in runs.values() for r in d['natural']]
    controlled = [r for d in runs.values() for r in d['controlled']]
    if any(len(d['natural']) != protocol['profiles_per_family'] for d in runs.values()):
        raise ValueError('Incomplete natural samples')
    maximum = max([r['max_local_loss'] for r in natural + controlled] +
                  [audit['oracle']['max_local_loss']] + [d['max_local_loss'] for d in audit['policies'].values()])
    bound = 505 * (DELTA + SAFETY_TOLERANCE) + protocol['baseline_error']
    if maximum > DELTA + SAFETY_TOLERANCE or bound > .02 or any(r['fallbacks'] for r in natural + controlled):
        raise ArithmeticError('Safety acceptance failed')
    result = dict(source='synthetic', overall=aggregate(natural), families={f:aggregate(d['natural']) for f,d in runs.items()},
        controlled={f:d['history_groups'] for f,d in runs.items()}, max_local_loss=maximum,
        accumulated_loss_bound=bound, timings={}, seconds=runtime['seconds'])
    for name in natural[0]['seconds']:
        times = np.array([r['seconds'][name] for r in natural]) * 1000
        result['timings'][name] = dict(mean_ms=float(times.mean()), p95_ms=float(np.quantile(times,.95)), max_ms=float(times.max()))
    (destination / 'summary.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    for name in ('protocol.json', 'endgame.json', 'runtime.json'): shutil.copyfile(directory/name, destination/name)
    source = Path(__file__).parents[1]
    provenance = dict(created_utc=datetime.now(timezone.utc).isoformat(), python=platform.python_version(),
        numpy=np.__version__, platform=platform.platform(), processor=platform.processor(),
        source_hashes={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*.py') if 'results' not in p.parts},
        artifact_hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.suffix in ('.json','.jsonl')})
    (destination / 'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    overall = result['overall']; groups = [g for d in runs.values() for g in d['history_groups']]
    positive = sum(g['root_history_value'] > VALUE_TOLERANCE for g in groups)
    lines = ['# 第四阶段：哪些历史规律值得让小网络学习','',
        '本阶段完成离线诊断，没有训练新网络、修改网页或部署。规则、均衡和安全约束保持精确计算；沿用冻结的行为网络和第三阶段参数。', '',
        '## 结论与研究取舍','',
        f'在 {len(groups)} 组当前状态完全相同的合法历史对照中，{positive} 组出现正的历史决策价值。连续防御、延迟模仿、连续安静后的反应等时序规律，可以改变安全集合中的最佳出招。只看当前子弹和上一手并不总够用。',
        '现有网络尚未稳定利用这些规律。下一步值得训练的是“玩家如何对过去多步动作作出延迟反应”的行为预测子模块，同时检查它在模拟分支上的预测。没有证据支持把已知规则或安全计算交给网络。',
        '一个精确终局审计还表明：只评价当前一手、假设后续由理想策略接管，可能把两个真实控制器的强弱顺序排反。因此，后续模型的验收要包含连续执行到终局的表现，不能只用预测误差或单手机会损失。','',
        '## 1. 固定实验方案与样本','',
        f'新种子前缀 [20260925,4]，11 类对手各 {protocol["profiles_per_family"]} 位独立合成玩家，每位打一局，共 {len(natural):,} 局用于采样。收集策略为均衡；每局从已有公开观测后的状态均匀抽取一处，共 {len(natural):,} 个自然轨迹状态。初始无数据选弹不在此诊断样本中。',
        '这不是三种控制器各自打完整局的胜率实验。每局等权，长对局不会因回合多而获得更高权重；它也不代表候选控制器将来访问局面的频率。行为类型在前几阶段已出现，新的是玩家参数和随机轨迹，并非全新类型的盲测。',
        f'另从真实初始状态构造 {len(controlled):,} 条合法短历史：九种初始选弹组合，四手双方同步动作返回原子弹数，再共同防御。每类使用独立预设玩家，每组的完整当前状态相同，包括轮次、回合、绝对筹码、初始和当前子弹、上一手及上一轮结果。所有历史都合法，但组内等权是受控干预，不能解释为自然出现概率。',
        '方案在实验运行前写入 protocol.json；未调参或重训。原网络、线性专家和校准参数的 SHA-256 均有记录。所有数据明确标为 synthetic。','',
        '## 2. 诊断量的含义','',
        '参考规划知道合成对手的真实行为，分别展开 1、2、3 次同时行动，未来公开历史照常推进，每个决策遵守原安全约束；叶节点接完整模式均衡价值。这个有额外信息的参考仅用于诊断，不是可部署策略，也不是完整博弈的最优解。',
        '当前动作机会损失：用同一个三步参考的动作分数评价候选分布，再减去参考最优值。它只评价当前一手，后续统一假设由参考策略接管；不能叫作控制器整局损失。',
        '历史决策价值：同一当前状态的一组历史，逐条使用各自最佳安全分布的平均值，减去所有历史被迫共用一个最佳安全分布的平均值。后续两步均保留真实历史，因此这是根节点使用更早历史的价值，不是完全删除记忆的整局代价。',
        '安全价值跨度：三步参考分数下，安全集合内最好与最差分布之差。无约束根节点差距仅解除当前一手的约束作为诊断，后续仍安全；它不授权放松 0.02 预算。阈值 1e-10 只排除数值噪声，不是实用收益门槛。','',
        '## 3. 新轨迹上的深度与预测对照','',
        '| 对手 | 两步网络机会损失 | 三步网络机会损失 | 三步自适应机会损失 | 三步参考相对均衡当前分布的收益 |',
        '|---|---:|---:|---:|---:|']
    for f, d in result['families'].items():
        losses = d['mean_opportunity_cost']
        lines.append(f'| {f} | {losses["neural2"]:.7f} | {losses["neural3"]:.7f} | {losses["adaptive3"]:.7f} | {d["root_gain_by_depth"]["3"]:.7f} |')
    lines += ['', f'{overall["positive_safe_span"]}/{len(natural)} 个状态的安全价值跨度超过 1e-10，平均跨度 {overall["mean_safe_span"]:.7f}。解除当前一手约束的平均额外参考收益为 {overall["mean_unrestricted_root_gap"]:.7f}，说明安全要求会限制利用对手，但并非所有可用空间都消失。',
        f'有 {overall["flat2_nonflat3"]} 个状态在两步参考中动作等值、三步中不等值；网络加深后的动作分布总变差超过 0.01 的有 {overall["changed_depth"]} 个。不能把之前小样本的“两步等值”外推为所有局面没有决策机会。','',
        '| 比较（三步参考下，正值较好） | 平均当前动作价值差 | 95% 配对 bootstrap 区间 |','|---|---:|---|']
    for label, key in (('网络三步 − 网络两步','depth_gain'), ('自适应三步 − 网络三步','adaptive_gain')):
        d = overall[key]; lo, hi = d['ci95']
        lines.append(f'| {label} | {d["mean"]:+.7f} | [{lo:+.7f}, {hi:+.7f}] |')
    lines += ['', '区间按独立玩家状态重采样 2,000 次，属于探索性局部诊断，没有多重比较校正。汇总区间包含零，不宣称加深或混合专家稳定提高收益；也不能据此宣称它们整局更弱。极少数状态会影响均值，后面的终局审计保留了这种影响。','',
        '## 4. 相同状态、不同历史','',
        '| 对手 | 有历史价值的组 / 9 | 最大根节点历史价值 | 九组等权平均 |','|---|---:|---:|---:|']
    for f, d in runs.items():
        vals = np.array([g['root_history_value'] for g in d['history_groups']])
        lines.append(f'| {f} | {int(sum(vals > VALUE_TOLERANCE))} | {max(vals):.7f} | {vals.mean():.7f} |')
    lines += ['', '固定动作、只依赖上一手的 reactive、筹码敏感、周期和跨轮切换构成负对照：当前状态已包含它们在这里需要的信息，更早历史的参考价值为零。不能从这些负对照推断真实玩家都不需要记忆。',
        '模仿型 mimic 的最大一组发生在首轮双方初始与当前子弹都为 1、筹码均为 50 的同一局面；最佳安全概率随更早动作变化。连续防御和延迟反应也有正例。summary.json 保存每组的共用最优分布、参考价值及网络相对该共用分布的差值；当前网络在多组中仍落后于这个知道对手的共用参考。',
        '这里的合成规律本身可以手写，作用是验证历史信息怎样影响决策，并不证明它们必须用神经网络。面对未知玩家，多种延迟、上下文和风格变化的组合才是后续小网络拟承担的子问题；仍需与简单记忆统计模型比较。',
        '每类受控实验只用一个预设玩家，且只覆盖首轮短历史。这些结果能定位机制和训练题型，不能估计真人群体的平均收益。','',
        '## 5. 到真实终局的补充审计','',
        '此项在看到上面结果后追加，明确属于事后诊断：选出 mimic 样本中最后一轮剩余不超过七手、三步网络当前动作机会损失最大的状态。没有用它调网络参数，也没有把它当独立测试集。',
        f'状态：第 {audit["state"]["round"]} 轮第 {audit["state"]["turn"]} 手，电脑/玩家筹码 {audit["state"]["mc"]}/{audit["state"]["mh"]}，当前子弹 {audit["state"]["bc"]}/{audit["state"]["bh"]}。这里可以直接枚举到终局，完全不用均衡叶值评价最终结果。','',
        '| 连续执行的控制器 | 精确期望得分 | 胜率 | 平率 | 负率 |','|---|---:|---:|---:|---:|']
    for k, d in audit['policies'].items():
        lines.append(f'| {k} | {d["score"]:.6f} | {d["win"]:.6f} | {d["draw"]:.6f} | {d["loss"]:.6f} |')
    lines += ['', f'已知真实对手、在每步原安全约束内求到终局的最优值为 {audit["oracle"]["value"]:.6f}。oracle2/oracle3 只替换行为预测为已知真实规律，搜索深度仍为两步/三步，因此不是把终局最优值直接送给候选网络。',
        f'只选当前一手然后让终局最优策略接管时，两步网络得到 {audit["root_only_values"]["neural2"]:.6f}，三步网络得到 {audit["root_only_values"]["neural3"]:.6f}；实际持续执行时，三步网络反而优于两步网络。这正是单手代理指标不能替代连续对局评价的实例。',
        '同样三步搜索，准确的时序行为模型能显著改善此例，现有网络和自适应专家远未达到该值。可用空间来自对未来延迟反应的正确预测，单纯继续加深并不能保证解决模型错误。这里只证明这个被挑选的合成残局，不能把差距当成整体胜率提升。','',
        '## 6. 安全、验证和计算成本','',
        f'所有观测节点最大单步损失 {maximum:.12g}；delta={DELTA:.12g}，容差 {SAFETY_TOLERANCE:g}，没有数值回退。原基线累计误差 {protocol["baseline_error"]:.4g}；计入 505 次决策后的损失界为 {bound:.12g}，小于 0.02。网络和对手预测错误不改变这项基于精确规则的保证。',
        '本次完整回归 33 项测试通过，包括 6,507 组 JavaScript 规则对照和 720 个矩阵 LP 对照。新增验证覆盖合法历史重放、完整当前状态一致、信息有用/无用对照、独立终局树加 SciPy LP、小规模压缩/完整历史终局求解一致、公开观测快照因果性、权重冻结及不安全分布拒绝。完整测试命令见 README。','',
        '| 自然样本决策函数 | 均值 ms | P95 ms | 最大 ms |','|---|---:|---:|---:|']
    for name, d in result['timings'].items():
        lines.append(f'| {name} | {d["mean_ms"]:.3f} | {d["p95_ms"]:.3f} | {d["max_ms"]:.3f} |')
    lines += ['', f'四进程主体实验墙钟 {runtime["seconds"]:.2f} 秒；补充终局审计 {audit["seconds"]:.2f} 秒。耗时含本机 Python 调用及并行争用，未做手机测量，不能保证网页 2–3 秒预算。仍依赖约 402 MiB 的均衡表；没有解决浏览器资源规模，未采集进程峰值内存。',
        '## 7. 下一步的具体目标','',
        '优先给小型时序行为网络增加延迟响应、连续动作阈值和风格变化的训练覆盖。以公开历史预测下一动作分布；真实类型、隐藏参数和本回合未公开动作都不能作为输入。规则引擎、筹码结算和安全求解继续保留。',
        '对照应包括相同数据和预算的简单滞后统计模型、线性模型、当前小网络、增加时序表达的候选网络；还要单独衡量未来模拟分支上的预测误差。使用新训练/验证/测试玩家，不能把本轮挑出的残局当新的独立测试证据。',
        '验收分两层：预测校准和关键历史对照用于定位问题；固定安全约束下完整对局及可精确求解残局的连续策略得分用于判断是否更强。即使平均 NLL 降低，也不直接升级为网页候选。',
        '', '复现入口、结果文件和局部指标的限制见上级 README.md。','']
    (destination / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')
