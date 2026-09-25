"""Create a compact, versionable report from actual completed artifacts."""
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
import scipy
import numba
from .experiments import OPPONENTS
from .matrix import DELTA, SAFETY_TOLERANCE


def generate(baseline,results,destination):
    baseline=Path(baseline); results=Path(results); destination=Path(destination)
    destination.mkdir(parents=True,exist_ok=True)
    eq=json.loads((baseline/'manifest.json').read_text(encoding='utf-8'))
    data={name:json.loads((results/f'{name}.json').read_text(encoding='utf-8'))
          for name in ('audit','tuning','evaluation','probes','learning')}
    if set(data['evaluation']['results'])!=set(OPPONENTS):
        raise ValueError('Incomplete opponent evaluation; do not publish partial report as complete')
    for name in data:
        shutil.copyfile(results/f'{name}.json',destination/f'{name}.json')
    compact={k:v for k,v in eq.items() if k!='pairs'}
    (destination/'baseline.json').write_text(json.dumps(compact,indent=2),encoding='utf-8')
    source=Path(__file__).parent
    hashes={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(source.rglob('*')) if p.suffix in ('.py','.js') and 'results' not in p.parts}
    rule_hashes={name:hashlib.sha256((source.parents[1]/'public'/'js'/name).read_bytes()).hexdigest()
                 for name in ('game.js','match.js')}
    provenance=dict(created_utc=datetime.now(timezone.utc).isoformat(),source_sha256=hashes,
                    javascript_rule_sha256=rule_hashes,
                    numpy=np.__version__,scipy=scipy.__version__,numba=numba.__version__,
                    platform=data['probes']['platform'],python=data['probes']['python'])
    (destination/'provenance.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    ev=data['evaluation']; tuning=data['tuning']; audit=data['audit']
    rows=[]
    for op in OPPONENTS:
        r=ev['results'][op]
        for kind,s in r['planners'].items():
            rows.append(dict(opponent=op,planner=kind,**s,win_rate=s['wins']/s['n'],
                             loss_rate=s['losses']/s['n'],draw_rate=s['draws']/s['n']))
    with (destination/'scores.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    lines=['# 完整模式 AI 离线实验报告','',
      '本报告仅使用合成对手。研究代码未接入网页，未推送或部署。', '',
      '## 1. 已验证的基线与范围','',
      f'- 完整规则：{eq["config"]["rounds"]} 轮，每轮 {eq["config"]["cap"]} 回合，初始筹码 {eq["config"]["money"]}。',
      f'- 可达决策状态：{eq["states"]:,}；初始均衡期望得分：{eq["root_value"]:.12f}。',
      f'- 基线生成耗时：{eq["seconds"]:.2f} 秒；磁盘表：{eq["artifact_bytes"]/1024**2:.2f} MiB。',
      f'- 累计数值误差上界：{eq["accumulated_error_bound"]:.3g}；认证通过：{eq["certified"]}。',
      f'- 电脑均衡对整局最佳反制：{audit["computer_equilibrium_vs_best_response"]:.14f}；对玩家均衡的最佳响应：{audit["best_response_vs_human_equilibrium"]:.14f}。',
      f'- 最佳响应间隙：{audit["exploitability_gap"]:.3g}；独立审计耗时：{audit["seconds"]:.2f} 秒。',
      f'- 理论预算：505 ×（{DELTA:.12g} + 概率数值容差 {SAFETY_TOLERANCE}）+ 基线误差 < 0.02，单位是胜 1／平 0.5／负 0 的期望得分。',
      '- 规则与数值验证包括 6,507 个 JS 对照场景、720 个 LP 矩阵对照、缩小规则完整反推、精确信念树、信息价值诊断、编译模拟尾部和累计安全约束。', '',
      '## 2. 筹码、赔付和轮数是否改变打法','',
      '下面均为双方选弹 1/1、当前子弹 1/1、轮内第 1 回合。概率顺序为防御／开枪／装弹，来自完整均衡表，不是手写风险偏好。','',
      '| 轮 | 电脑／玩家筹码 | 整局价值 | 防御 | 开枪 | 装弹 |',
      '|---|---|---|---|---|---|']
    seen=set()
    for c in data['probes']['contexts']:
        s=c['state']; key=(s['round'],s['mc'],s['mh'])
        if key in seen: continue
        seen.add(key); p=c['computer']
        lines.append(f'| {s["round"]} | {s["mc"]}/{s["mh"]} | {c["value"]:.4f} | {p[0]:.4f} | {p[1]:.4f} | {p[2]:.4f} |')
    lines += ['', '下面固定双方筹码 50/50、当前子弹 1/1 和第 3 回合，只改变本轮初始选弹（及其赔付和平局扣款规则）。','',
              '| 轮 | 初始选弹 | 价值 | 防御 | 开枪 | 装弹 |','|---|---|---|---|---|---|']
    for c in data['probes']['payout_contexts']:
        s=c['state']; p=c['computer']
        lines.append(f'| {s["round"]} | {s["pc"]}/{s["ph"]} | {c["value"]:.4f} | {p[0]:.4f} | {p[1]:.4f} | {p[2]:.4f} |')
    lines += ['', '这些表用于检查内外层价值的耦合。部分局面均衡高度偏向防御，是当前赔付、平局和有限回合规则下求出的结果，可能影响游玩节奏。此处没有为了加快节奏修改收益目标。','',
      '## 3. 独立测试集结果','',
      f'本次执行首批每类对手 {next(iter(ev["results"].values()))["planners"]["belief"]["n"]} 局；每个样本从独立的 {ev["train_games"]} 局均衡训练历史开始。每次决策 {ev["simulations"]} 次模拟。',
      '程序支持按 128 局递增至 2,048 局；本报告没有执行上限规模实验。当前首批样本仅用于方法核对，不能据此宣称策略更强。',
      '各策略在真实回合后均更新信念；frozen 仅在模拟未来时冻结信念，belief 模拟未来的信念更新。表中为整局期望得分，不是纯胜率。','',
      '| 对手 | 均衡 | frozen | belief | belief−frozen | 差值 95% 区间 | 结论 |',
      '|---|---|---|---|---|---|---|']
    for op in OPPONENTS:
        r=ev['results'][op]; ps=r['planners']; ci=r['difference_ci95']
        lines.append(f'| {op} | {ps["equilibrium"]["score"]:.4f} | {ps["frozen"]["score"]:.4f} | {ps["belief"]["score"]:.4f} | {r["paired_belief_minus_frozen"]:+.4f} | [{ci[0]:+.4f}, {ci[1]:+.4f}] | {r["conclusion"]} |')
    means={kind:float(np.mean([r['planners'][kind]['score'] for r in ev['results'].values()])) for kind in ('equilibrium','frozen','belief')}
    lines += ['', f'八类对手等权描述性平均：均衡 {means["equilibrium"]:.4f}、frozen {means["frozen"]:.4f}、belief {means["belief"]:.4f}。这不是对真人群体的泛化保证。',
      '差值使用独立样本的配对 Hoeffding 区间，结论再对最多 16 次批次查看做校正。inconclusive 表示证据不足，不表示两者完全相同。胜／负／平率、数量、各自 Wilson 区间及得分区间见 scores.csv 和 evaluation.json。',
      'counter 只针对电脑公开概率和均衡延续价值作反制，不是对整个学习算法的精确最佳响应；不能用此样本成绩替代安全证明。','',
      '## 4. 何时能识别玩家，以及是否提高得分','',
      '独立的学习曲线按已揭示观测数量分桶，比较动作揭示前的交叉熵，越低越好。每类 128 条独立历史、每条最多四局。它衡量倾向识别，不直接衡量获胜收益。','',
      '| 对手 | 已有观测 | 预测样本数 | 学习后交叉熵 | 原始先验交叉熵 |',
      '|---|---|---|---|---|']
    for op,curve in data['learning'].items():
        for point in curve:
            lo,hi=point['observations']
            lines.append(f'| {op} | {lo}–{hi} | {point["samples"]} | {point["learned_logloss"]:.4f} | {point["prior_logloss"]:.4f} |')
    lines += ['', '即使预测交叉熵降低，也必须结合独立对局成绩判断策略是否受益。当前实验不能给出对所有玩家通用的“第几轮必然变强”阈值。轮间换风格、模型外行为和严格的逐步安全预算都会限制收益。','',
      '## 5. 随机温度与计算预算','',
      f'验证集选出的温度为 **{tuning["chosen"]}**；每种对手 {tuning["trials_per_opponent"]} 个独立验证样本。无法统计区分时选择较小温度。温度 0 仍按求出的概率分布采样，并不强制选择单一动作。','',
      '| 温度 | 验证集得分 | 95% 区间 |','|---|---|---|']
    for temp,s in tuning['results'].items():
        ci=s['score_ci95']; lines.append(f'| {temp} | {s["score"]:.4f} | [{ci[0]:.4f}, {ci[1]:.4f}] |')
    lines += ['', '同一批三个可达状态、每次 256 次模拟的动作分布诊断，以及验证集中专门反制者的成绩如下。反制者每个温度仅 16 局，成绩只作描述，无法据此排序。温度也改变搜索采样路径和得分估计，因此这个端到端实验中的策略熵不保证随温度单调增加。','',
              '| 温度 | 平均策略熵 | 安全约束限制次数/3 | 对 counter 得分 |','|---|---|---|---|']
    for temp in tuning['results']:
        ds=[p['decision']['diagnostics'] for p in data['probes']['temperatures'] if p['temperature']==float(temp)]
        lines.append(f'| {temp} | {np.mean([d["entropy"] for d in ds]):.5f} | {sum(d["safety_limited"] for d in ds)}/3 | {tuning["by_opponent"]["counter"][temp]["score"]:.4f} |')
    lines += ['', '下面是预热后的三个可达状态，分别用 0.5、1、2.5 秒软预算搜索。实际耗时可能略超预算，因为一条模拟完成后才检查时钟。','',
      '| 规划器 | 预算秒 | 实际秒（最小–最大） | 模拟次数（最小–最大） |',
      '|---|---|---|---|']
    for kind in ('frozen','belief'):
        for budget in (.5,1.,2.5):
            ds=[p['decision']['diagnostics'] for p in data['probes']['timing'] if p['kind']==kind and p.get('budget_seconds')==budget]
            secs=[d['seconds'] for d in ds]; sims=[d['simulations'] for d in ds]
            lines.append(f'| {kind} | {budget} | {min(secs):.3f}–{max(secs):.3f} | {min(sims)}–{max(sims)} |')
    maxloss=max(d['max_local_loss'] for r in ev['results'].values() for d in r['diagnostics'].values())
    lines += ['', f'测试集最大观测到的单步价值损失为 {maxloss:.12g}，预算为 {DELTA:.12g}。温度改变动作多样性，但最终分布仍受同一安全条件约束。',
      f'观测损失超过名义 delta 的部分为浮点误差，仍小于显式数值容差 {SAFETY_TOLERANCE}；该容差已经计入整局预算。',
      '这里验证了在本机时间预算内能够输出策略；没有证明 2.5 秒已经足够接近最优，也没有做真人或手机性能验证。固定模拟次数及时间预算下的完整动作价值、分布、熵和约束诊断见 probes.json。','',
      f'测时进程峰值驻留内存约 {data["probes"]["process_peak_resident_bytes"]/1024**2:.1f} MiB（含 Python、JIT、映射页、缓存和搜索树，不能当作网页内存需求）。另做 1,024 次模拟的分析，主要模块自身耗时如下；嵌套总耗时不能相加。','',
      '| 函数 | 文件 | 调用数 | 自身秒 | 含子调用秒 |','|---|---|---|---|---|']
    for row in data['probes']['profile'][:5]:
        lines.append(f'| {row["function"]} | {row["file"]} | {row["calls"]} | {row["self_seconds"]:.4f} | {row["total_seconds"]:.4f} |')
    lines += ['',
      '## 6. 当前结论与限制','',
      '- 已完成完整规则均衡、有限类型信念模型、三种规划器、随机概率优化、安全验证与合成对手实验。',
      '- 信念搜索仍是有限预算近似：受约束探索可能很少采样某些动作，尾部采用均衡策略；不宣称全局最优。',
      '- 729 个候选类型是研究模型族，不能覆盖任意真人行为；合成对手专门包含模型外风格。',
      '- 每步均匀分配 0.0199/505 的安全预算很保守；这能限制最坏损失，也会限制利用已识别弱点的程度。',
      '- 当前约 402 MiB 的原始价值表不适合直接整包放入手机网页。后续需要单独评估压缩、按需查询或服务端计算，本阶段未选择或实现网页架构。',
      '- 正负样本差异及不确定性均保留。只有更大独立样本或更充分搜索证实收益，才能判断复杂规划是否值得网页成本。',
      '- 规则、基线和安全门槛通过不等于产品已就绪。当前仅是待评估的网页接入候选，公网版本未变。','',
      '## 7. 复现与环境','',
      f'Python {provenance["python"]}；NumPy {np.__version__}；SciPy {scipy.__version__}；Numba {numba.__version__}。',
      f'平台：{provenance["platform"]}。正式对手测试墙钟耗时：{ev["seconds"]:.2f} 秒（四进程）。',
      '运行命令见上级 README.md。provenance.json 记录源文件 SHA-256；报告所用紧凑结果随本目录保存，大型价值表和完整合成日志留在 research/artifacts。','']
    (destination/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
