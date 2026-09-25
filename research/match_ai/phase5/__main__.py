import argparse
from pathlib import Path
from . import run


def main():
    p = argparse.ArgumentParser(description='Train and select a practical temporal opponent model')
    p.add_argument('stage',choices=['data','train','tune','test','report'])
    p.add_argument('--baseline',default='research/artifacts/full')
    p.add_argument('--output',default='research/artifacts/phase5')
    p.add_argument('--workers',type=int,default=4)
    p.add_argument('--games',type=int)
    args = p.parse_args(); directory = Path(args.output)
    if args.stage == 'data':
        from ..equilibrium import Equilibrium
        from .data import generate
        generate(Equilibrium(args.baseline),directory)
    elif args.stage == 'train': run.train(directory)
    elif args.stage in ('tune','test'): run.games(args.baseline,directory,'tuning' if args.stage=='tune' else 'test',args.games,args.workers)
    else: run.report(directory,Path(__file__).parent/'results')


if __name__ == '__main__': main()
