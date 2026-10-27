# Bull v3

Autonomous day trader on an Alpaca **paper** account. Each morning it picks 30 stocks (the day's biggest gappers plus the most liquid names), watches 1-minute bars, and trades only the methods that survived a fee-aware backtest. Every entry carries a broker-side stop and target, and everything is closed by 15:50 ET.

See [CLAUDE.md](CLAUDE.md) for rails, layout and deploy.
