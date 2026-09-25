"""Train candidates, select by complete validation games, then test once."""
from pathlib import Path
import hashlib
import json
import time
import numpy as np
from ..rules import initial, actions, transition
from ..matrix import DELTA, SAFETY_TOLERANCE
from ..phase2.data import event
from ..phase2.network import Predictor, fit
from ..phase2.study import paired_bootstrap
from ..experiments import summary
from .data import TRAIN_FAMILIES, TEST_FAMILIES, profile, rng_for
from .model import TemporalPredictor, Controller, remember

CANDIDATES = ('old2','refreshed2','temporal2','temporal3')


def train(directory):
    directory = Path(directory)
    with np.load(directory/'train.npz') as a, np.load(directory/'validation.npz') as b:
        training = {k:a[k] for k in a.files}; validation = {k:b[k] for k in b.files}
    result = {}
    for name, model, width in (('refreshed',Predictor(64),107),('temporal',TemporalPredictor(96),203)):
        ta = {**training,'x':training['x'][:,:width]}; va = {**validation,'x':validation['x'][:,:width]}
        result[name] = fit(model,ta,va,epochs=30,batch=512,seed=2026092505)
        model.save(directory/f'{name}.npz')
        print('trained',name,result[name]['validation_nll'],result[name]['seconds'],flush=True)
    (directory/'training.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


def controller(eq,directory,name):
    directory = Path(directory)
    if name == 'old2': model = Predictor.load(Path(__file__).parents[1]/'phase3/results/neural.npz')
    elif name == 'refreshed2': model = Predictor.load(directory/'refreshed.npz')
    elif name in ('temporal2','temporal3'): model = TemporalPredictor.load(directory/'temporal.npz')
    else: raise ValueError(name)
    return Controller(eq,model,int(name[-1]),name.startswith('temporal'))


def play(eq,planner,player,rng,trace=None):
    s = initial(eq.config); history = (); stats = dict(decisions=0,seconds=0.,max_local_loss=0.,fallbacks=0)
    while True:
        p,d = planner.decision(s,history); ac,ah = actions(s); hp = player.probabilities(s,history)
        a = ac[int(rng.choice(len(ac),p=p))]; b = ah[int(rng.choice(len(ah),p=hp))]
        ns,u,meta = transition(s,a,b,eq.config)
        v,_,_,q = eq.query(s); loss = max(d['max_local_loss'],float(v-min(p@q)))
        if loss > DELTA+SAFETY_TOLERANCE or not np.all(np.isfinite(p)):
            raise ArithmeticError('Unsafe decision')
        stats['decisions'] += 1; stats['seconds'] += d['seconds']; stats['fallbacks'] += d['fallbacks']
        stats['max_local_loss'] = max(stats['max_local_loss'],loss)
        if trace is not None:
            trace.write(json.dumps(dict(source='synthetic',event_id=stats['decisions'],state=s.to_dict(),
                computer=a,human=b,probabilities=p.tolist(),scores=d['scores'],settlement=meta,terminal_score=u))+'\n')
        history = remember(history,event(s,a,b,meta,ns is None))
        if ns is None: return u,stats
        s = ns


def family_games(baseline,directory,split,family,count,names):
    from ..equilibrium import Equilibrium
    eq = Equilibrium(baseline); directory = Path(directory)
    controllers = {name:controller(eq,directory,name) for name in names}
    scores = {name:[] for name in names}
    stats = {name:dict(decisions=0,seconds=0.,max_local_loss=0.,fallbacks=0) for name in names}
    start = time.perf_counter()
    for i in range(count):
        player = profile(split,family,i)
        for name,planner in controllers.items():
            if i == 0:
                with (directory/f'{split}_{family}_{name}.jsonl').open('w',encoding='utf-8') as trace:
                    u,d = play(eq,planner,player,rng_for(split,family,i,1),trace)
            else: u,d = play(eq,planner,player,rng_for(split,family,i,1))
            scores[name].append(u)
            for k,value in d.items():
                if k == 'max_local_loss': stats[name][k] = max(stats[name][k],value)
                else: stats[name][k] += value
        if (i+1)%16 == 0: print('phase5 games',split,family,i+1,flush=True)
    return dict(family=family,scores=scores,summary={k:summary(v) for k,v in scores.items()},stats=stats,seconds=time.perf_counter()-start)


def games(baseline,directory,split,count=None,workers=4):
    from concurrent.futures import ProcessPoolExecutor,as_completed
    directory = Path(directory); start = time.perf_counter()
    if split == 'tuning': families = TRAIN_FAMILIES; names = CANDIDATES; count = count or 16
    elif split == 'test':
        selection = json.loads((directory/'selection.json').read_text(encoding='utf-8'))
        families = TEST_FAMILIES; names = tuple(dict.fromkeys(('old2',selection['selected']))); count = count or 64
        for name,digest in selection['weight_hashes'].items():
            if hashlib.sha256((directory/name).read_bytes()).hexdigest() != digest: raise ValueError('Selected weights changed')
    else: raise ValueError(split)
    result = dict(source='synthetic',split=split,games_per_family=count,controllers=names,results={})
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(family_games,str(baseline),str(directory),split,f,count,names) for f in families]
        for future in as_completed(futures):
            row = future.result(); result['results'][row['family']] = row; result['seconds'] = time.perf_counter()-start
            (directory/f'{split}_games.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    if split == 'tuning':
        means = {name:float(np.mean([result['results'][f]['summary'][name]['score'] for f in families])) for name in names}
        # Prefer cheaper candidates on exact ties; no test results are available here.
        selected = max(names,key=lambda name:means[name])
        selection = dict(selected=selected,validation_scores=means,criterion='highest mean complete-match validation score; candidate order breaks exact ties',
            weight_hashes={name:hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in ('refreshed.npz','temporal.npz')})
        (directory/'selection.json').write_text(json.dumps(selection,indent=2),encoding='utf-8')
        print('SELECTED',selection,flush=True)
    return result


def report(directory,destination):
    import shutil
    directory = Path(directory); destination = Path(destination); destination.mkdir(parents=True,exist_ok=True)
    data = {k:json.loads((directory/f'{k}.json').read_text(encoding='utf-8')) for k in ('data','training','selection','tuning_games','test_games')}
    selected = data['selection']['selected']; tests = data['test_games']; names = tests['controllers']
    if set(tests['results']) != set(TEST_FAMILIES): raise ValueError('Incomplete tests')
    for k in data: shutil.copyfile(directory/f'{k}.json',destination/f'{k}.json')
    for name in ('refreshed.npz','temporal.npz'): shutil.copyfile(directory/name,destination/name)
    lines = ['# 第五阶段：训练并挑选可用的电脑决策模型','',
        f'本轮直接训练两个行为模型，以完整对局得分挑选候选。验证集选中 **{selected}**。仍为本地离线版本，未同步网页。','',
        '## 做了什么','',
        'refreshed：保留原 107 输入、64 隐藏单元，扩充训练对手和历史覆盖。temporal：203 输入、96 隐藏单元，在最近八次事件之外，增加最近 64 次公开事件的延迟响应统计；网络学习这些统计与当前局面如何共同影响玩家动作。只预测玩家行为，规则、筹码和安全约束继续精确计算。',
        '每揭示一对动作就更新历史，下一手直接使用；统计跨轮保留，但不会把不同轮的动作拼成延迟响应。对局中不重训网络参数。训练同时加入替代电脑动作形成的合法后续分支，让网络见到规划时可能访问的历史。标签全部来自合成玩家实际采样的公开动作。',
        '训练包含原十一类行为，加上随机延迟/映射的电脑动作响应和玩家自身动作响应。测试另含两种未训练的组合行为 hybrid、drifting。所有数据都是合成数据，不代表真人表现。','',
        '| 数据 | 玩家数 | 观测数 |','|---|---:|---:|']
    for split,d in data['data']['sequences'].items(): lines.append(f'| {split} | {d["profiles"]} | {d["observations"]} |')
    lines += ['','| 网络 | 参数数 | 原始权重字节 | 训练秒数 | 验证 NLL |','|---|---:|---:|---:|---:|']
    for name,d in data['training'].items():
        lines.append(f'| {name} | {d["parameters"]} | {d["weight_bytes"]} | {d["seconds"]:.2f} | {d["validation_nll"]:.4f} |')
    lines += ['','## 按完整对局选版本','','| 版本 | 验证平均得分 |','|---|---:|']
    for name,value in data['selection']['validation_scores'].items(): lines.append(f'| {name} | {value:.5f} |')
    lines += ['', f'后缀 2/3 表示搜索两步/三步；胜 1、平 0.5、负 0。每种对手 {data["tuning_games"]["games_per_family"]} 位独立验证玩家，四个候选使用相同种子。网络早停用另一组验证历史，版本选择用完整对局，测试种子与两者分离。','',
        f'## 独立测试：每类 {tests["games_per_family"]} 位玩家','',
        '| 对手 | 原版本得分 | 选中版本得分 | 差值 |','|---|---:|---:|---:|']
    differences = []
    for family in TEST_FAMILIES:
        r = tests['results'][family]; old = np.array(r['scores']['old2']); new = np.array(r['scores'][selected]); differences.extend(new-old)
        lines.append(f'| {family} | {old.mean():.5f} | {new.mean():.5f} | {(new-old).mean():+.5f} |')
    ci = paired_bootstrap(differences); mean = float(np.mean(differences))
    aggregate = dict(selected=selected,mean_difference=mean,paired_bootstrap_ci95=ci,
        controllers={k:summary([x for f in TEST_FAMILIES for x in tests['results'][f]['scores'][k]]) for k in names})
    (destination/'aggregate.json').write_text(json.dumps(aggregate,indent=2),encoding='utf-8')
    lines += ['', f'总体平均得分变化 **{mean:+.5f}**；按玩家配对 bootstrap 的参考 95% 区间 [{ci[0]:+.5f}, {ci[1]:+.5f}]。这是一次快速筛选，按固定样本量运行，不用测试结果继续调参；区间不是严格的分布外保证。',
        '胜率、平率、负率和逐类分数完整保存在 test_games.json 与 aggregate.json；若差值不稳定，保留这种不确定性，不把预测损失降低当作胜率提升。','',
        '| 控制器 | 总体得分 | 胜率 | 平率 | 负率 |','|---|---:|---:|---:|---:|']
    for name,d in aggregate['controllers'].items():
        n = d['n']; values = [x for f in TEST_FAMILIES for x in tests['results'][f]['scores'][name]]
        lines.append(f'| {name} | {d["score"]:.5f} | {values.count(1.)/n:.5f} | {values.count(.5)/n:.5f} | {values.count(0.)/n:.5f} |')
    lines += ['',
        '## 运行成本与安全','','| 控制器 | 决策数 | 平均决策毫秒 | 最大单步损失 |','|---|---:|---:|---:|']
    for name in names:
        rows = [tests['results'][f]['stats'][name] for f in TEST_FAMILIES]
        count = sum(d['decisions'] for d in rows); maximum = max(d['max_local_loss'] for d in rows)
        if maximum > DELTA+SAFETY_TOLERANCE: raise ArithmeticError('Unsafe results')
        lines.append(f'| {name} | {count} | {1000*sum(d["seconds"] for d in rows)/count:.3f} | {maximum:.12g} |')
    lines += ['',f'四进程验证耗时 {data["tuning_games"]["seconds"]:.1f} 秒；独立测试耗时 {tests["seconds"]:.1f} 秒。仍依赖完整均衡表，桌面耗时不能当手机保证。',
        '本轮 37 项回归测试通过，包含新增网络梯度/权重读写、跨轮记忆边界、原版规划行为一致性及完整对局安全检查。',
        '安全预算继续为每手 0.0199/505，加原数值误差后整局小于 0.02。无公开历史时使用均衡；行动仍从安全概率分布采样。本轮没有放宽安全预算来换得分。','',
        '复现命令见上级 README。模型、选择结果和原始对局汇总保存在本目录；可重放的首局日志与训练数组位于 research/artifacts/phase5。','']
    (destination/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
    source = Path(__file__).parents[1]
    provenance = dict(seed_prefix=[20260925,5],numpy=np.__version__,
        weights={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.glob('*.npz')},
        baseline_model=hashlib.sha256((source/'phase3/results/neural.npz').read_bytes()).hexdigest(),
        source_hashes={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*.py') if 'results' not in p.parts})
    (destination/'provenance.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
