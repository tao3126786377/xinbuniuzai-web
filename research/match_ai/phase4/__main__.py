import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Decision-relevant history: frozen models, exact safety, offline only')
    parser.add_argument('stage', choices=['run', 'endgame', 'report'])
    parser.add_argument('--baseline', default='research/artifacts/full')
    parser.add_argument('--source', default='research/match_ai/phase3/results')
    parser.add_argument('--output', default='research/artifacts/phase4')
    parser.add_argument('--profiles', type=int, default=128)
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if args.profiles < 1 or args.workers < 1: parser.error('Counts must be positive')
    if args.stage == 'run':
        from .study import run
        run(args.baseline, args.source, args.output, args.profiles, args.workers)
    elif args.stage == 'endgame':
        from .endgame import audit
        audit(args.baseline, args.source, args.output)
    else:
        from .report import generate_report
        generate_report(Path(args.output), Path(__file__).parent / 'results')


if __name__ == '__main__': main()
