import argparse
import json
from pathlib import Path
from .rules import Config
from .equilibrium import build, Equilibrium


def main():
    parser=argparse.ArgumentParser(description='Offline full-match AI research; never deploys')
    parser.add_argument('command',choices=['build','audit','tune','evaluate','probes','learning','report'])
    parser.add_argument('--baseline',default='research/artifacts/full')
    parser.add_argument('--output',default='research/artifacts/results')
    parser.add_argument('--rounds',type=int,default=5)
    parser.add_argument('--cap',type=int,default=100)
    parser.add_argument('--money',type=int,default=50)
    parser.add_argument('--simulations',type=int,default=8)
    parser.add_argument('--max-games',type=int,default=128)
    parser.add_argument('--train-games',type=int,default=2)
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--report-dir',default='research/match_ai/results')
    args=parser.parse_args()
    if args.command=='build':
        eq=build(args.baseline,Config(args.rounds,args.cap,args.money))
        print(json.dumps({k:v for k,v in eq.manifest.items() if k!='pairs'},indent=2)); return
    from .experiments import tune,evaluate_parallel,probes,learning_curves
    eq=Equilibrium(args.baseline); out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    if args.command=='report':
        from .report import generate
        generate(args.baseline,args.output,args.report_dir)
    elif args.command=='audit':
        from .audit import audit
        print(audit(eq,out/'audit.json'))
    elif args.command=='tune':
        result=tune(eq,args.simulations,workers=args.workers); result['simulations']=args.simulations
        (out/'tuning.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    elif args.command=='evaluate':
        tuning=json.loads((out/'tuning.json').read_text(encoding='utf-8'))
        if tuning['simulations']!=args.simulations: raise ValueError('Tune and evaluate with same simulation budget')
        evaluate_parallel(eq,out,tuning['chosen'],args.simulations,args.max_games,args.train_games,args.workers)
    elif args.command=='learning': learning_curves(eq,out/'learning.json')
    else:
        tuning=json.loads((out/'tuning.json').read_text(encoding='utf-8'))
        probes(eq,out/'probes.json',tuning['chosen'])


if __name__=='__main__': main()
