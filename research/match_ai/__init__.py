"""Full-match research package. Optional project-local Python dependencies."""
from pathlib import Path
import sys

deps = Path(__file__).resolve().parents[1] / '.deps'
if deps.exists():
    sys.path.insert(0, str(deps))
