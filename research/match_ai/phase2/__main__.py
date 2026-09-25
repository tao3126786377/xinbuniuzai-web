import argparse
from pathlib import Path
from ..equilibrium import Equilibrium


def main():
    parser=argparse.ArgumentParser(description='Offline opponent-model study; no deployment')
    parser.add_argument('stage',choices=['data','train','oracle','prediction','games','report'])
    parser.add_argument('--baseline',default='research/artifacts/full')
    parser.add_argument('--output',default='research/artifacts/phase2')
    parser.add_argument('--games',type=int,default=128)
    parser.add_argument('--workers',type=int,default=4)
    args=parser.parse_args(); out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    if args.stage=='data':
        from .data import generate
        generate(Equilibrium(args.baseline),out)
    elif args.stage=='train':
        from .network import train
        train(out)
    elif args.stage=='oracle':
        from .study import oracle_study
        oracle_study(out)
    elif args.stage=='prediction':
        from .study import prediction_study
        prediction_study(out)
    elif args.stage=='games':
        from .study import game_study
        game_study(Equilibrium(args.baseline),out,args.games,args.workers)
    else:
        from .report import generate_report
        generate_report(out,Path(__file__).parent/'results')


if __name__=='__main__': main()
