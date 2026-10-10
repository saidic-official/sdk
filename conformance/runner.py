"""The conformance runner (sections 51.7 and 51.12): every scenario of scenarios/*.json,
through an SDK's adapter (ADAPTER.md), against the real backend in a test environment.

    python sdk/conformance/runner.py --adapter "node sdk/conformance/adapters/web.mjs"
    python sdk/conformance/runner.py                 # the backend's trivial adapter

Run from the monorepo's root with the backend's Python (backend/.venv/bin/python). The
backend is served inside the run on a contract copy, as its realtime tests are, so the
runner can play the assistant and the team; CONTRACT_DB_NAME must name a contract copy
(saidic_contract_...), and nothing else is ever touched. The report is pytest's: a pass,
a failure with the step and what was seen, or a skip naming an operation the SDK cannot
do (a gap of that SDK, never a pass).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--adapter", help="the adapter's command, run from the monorepo's root"
    )
    parser.add_argument("-k", help="only the scenarios whose name holds this")
    arguments = parser.parse_args(argv)
    database = os.environ.get("CONTRACT_DB_NAME", "")
    if not database.startswith("saidic_contract_"):
        print(
            "CONTRACT_DB_NAME must name a contract copy (saidic_contract_...): nothing run"
        )
        return 2
    env = {**os.environ, "ENVIRONMENT": os.environ.get("ENVIRONMENT", "test")}
    if arguments.adapter:
        env["CONFORMANCE_ADAPTER"] = arguments.adapter
    command = [sys.executable, "-m", "pytest", "tests/realtime/test_conformance.py", "-v",
               "-p", "no:cacheprovider", "-rs"]  # fmt: skip
    if arguments.k:
        command += ["-k", arguments.k]
    return subprocess.call(command, cwd=str(BACKEND), env=env)


if __name__ == "__main__":
    raise SystemExit(main())
