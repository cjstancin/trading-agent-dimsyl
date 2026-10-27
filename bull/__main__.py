"""python -m bull engine | site | bakeoff [--days N] | experiment [--days N] | check"""
from __future__ import annotations

import argparse
import logging
import sys
from logging.handlers import RotatingFileHandler

from .config import load_config, load_env, runtime_dir


def setup_logging(name: str) -> None:
    logs = runtime_dir() / "logs"
    logs.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in (logging.StreamHandler(sys.stdout), RotatingFileHandler(logs / f"{name}.log", maxBytes=5_000_000, backupCount=5)):
        h.setFormatter(fmt)
        root.addHandler(h)
    logging.getLogger("websockets").setLevel(logging.WARNING)


def main() -> None:
    ap = argparse.ArgumentParser(prog="bull")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("engine")
    s = sub.add_parser("site")
    s.add_argument("--port", type=int, default=4326)
    b = sub.add_parser("bakeoff")
    b.add_argument("--days", type=int)
    x = sub.add_parser("experiment")
    x.add_argument("--days", type=int, default=1000)
    sub.add_parser("check")
    args = ap.parse_args()

    load_env()
    cfg = load_config()
    setup_logging(args.cmd)

    if args.cmd == "engine":
        from .engine import Engine
        Engine(cfg).run()
    elif args.cmd == "site":
        from .site import serve
        serve(cfg, port=args.port)
    elif args.cmd == "bakeoff":
        from .bakeoff import print_table, run
        print_table(run(cfg, args.days))
    elif args.cmd == "experiment":
        from .experiment import print_table, run
        print_table(run(cfg, args.days))
    elif args.cmd == "check":
        from . import broker
        tc = broker.client()
        acct = tc.get_account()
        clock = tc.get_clock()
        print(f"paper account {acct.account_number}: equity ${float(acct.equity):,.2f}, "
              f"buying power ${float(acct.buying_power):,.2f}, shorting {'on' if acct.shorting_enabled else 'off'}, "
              f"market {'open' if clock.is_open else 'closed'}")


if __name__ == "__main__":
    main()
