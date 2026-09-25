import argparse
from pathlib import Path
from ..equilibrium import Equilibrium


def main():
    parser=argparse.ArgumentParser(description='Offline reliability study; frozen behavior networks, exact safety')
    parser.add_argument('stage',choices=['data','select','prediction','games','decisions','report'])
    parser.add_argument('--baseline',default='research/artifacts/full')
    parser.add_argument('--output',default='research/artifacts/phase3')
    parser.add_argument('--source',default='research/match_ai/phase2/results')
    parser.add_argument('--games',type=int,default=128)
    parser.add_argument('--workers',type=int,default=4)
    args=parser.parse_args(); directory=Path(args.output); directory.mkdir(parents=True,exist_ok=True)
    if args.stage=='data':
        from .data import generate
        generate(Equilibrium(args.baseline),directory,args.source)
    elif args.stage=='select':
        from .reliability import select
        select(directory)
    elif args.stage=='prediction':
        from .study import prediction_study
        prediction_study(directory)
    elif args.stage=='games':
        from .study import game_study
        game_study(Equilibrium(args.baseline),directory,args.games,args.workers)
    elif args.stage=='decisions':
        from .study import decision_probe
        decision_probe(Equilibrium(args.baseline),directory)
    else:
        from .report import generate_report
        generate_report(directory,Path(__file__).parent/'results')


if __name__=='__main__': main()
