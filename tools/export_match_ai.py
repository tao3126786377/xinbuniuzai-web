"""Export the selected frozen model; never retrain or select at runtime."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import research.match_ai
import numpy as np


def main():
    source = ROOT/'research/match_ai/phase5/results'
    selection = json.loads((source/'selection.json').read_text())
    weights = source/'temporal.npz'
    if selection['selected'] != 'temporal3' or hashlib.sha256(weights.read_bytes()).hexdigest() != selection['weight_hashes']['temporal.npz']:
        raise ValueError('Expected the frozen phase-five temporal3 candidate')
    destination = ROOT/'lib/match-ai'; destination.mkdir(parents=True,exist_ok=True)
    with np.load(weights) as model:
        shapes = [(203,96),(96,),(96,3),(3,)]
        if [model[f'p{i}'].shape for i in range(4)] != shapes: raise ValueError('Incompatible network shape')
        data = b''.join(model[f'p{i}'].astype('<f8').tobytes(order='C') for i in range(4))
    (destination/'weights.bin').write_bytes(data)
    table = ROOT/'research/artifacts/full/manifest.json'
    manifest = dict(id='full-temporal3-v1',source='phase5 temporal3',inputs=203,hidden=96,outputs=3,
        history=64,depth=3,temperature=0,delta=.0199/505,defaultBudgetMs=2500,
        format='little-endian float64; W0 C-order, b0, W1 C-order, b1',
        sourceWeightsSha256=hashlib.sha256(weights.read_bytes()).hexdigest(),weightsSha256=hashlib.sha256(data).hexdigest(),
        equilibriumManifestSha256=hashlib.sha256(table.read_bytes()).hexdigest())
    (destination/'policy.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print('Exported',manifest['id'],len(data),'bytes')


if __name__ == '__main__': main()
