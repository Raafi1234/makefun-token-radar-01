# Launch Radar — a token-radar-01 entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Raafi1234/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Raafi1234/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Reads the sealed DefiLlama snapshot (`/input/snapshot.json`), ranks the protocols that record no
token yet by an implied launch value, and hands in a dashboard: the board, a detail view per
protocol, filters, and a concrete farm plan for every row.

## The model

Implied value is calibrated on the snapshot itself. Every live-token protocol is a comparable:
its market-cap/TVL ratio, grouped by category, gives that category's base multiple (median,
shrunk toward the global median by the comparable count). A pre-token protocol's value is

```
implied = TVL × category multiple × growth factor × maturity factor × breadth factor
```

with the seven-day TVL change clamped to [-40%, +80%] at weight 0.35, maturity rising over three
years of tracked history with no token, and +1% per extra chain (max +8%). Every factor of every
row is written to `board.json` and shown in the dashboard's detail view. No name is special-cased.

The board covers the whole 40-protocol watchlist plus the strongest screened pre-token protocols
below the $50M floor. Farm plans are generated per category and chain, with capital tiers, gas
estimates, weekly cadence and hold windows derived from each protocol's own record.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22+, standard library only. The program is deterministic: same snapshot, same bytes.
`screenshots/` holds renders of the dashboard itself (board, one protocol's detail view, a
filtered view), produced from the page's own URL-hash states.

---

<sub>Entered on [make.fun](https://make.fun/?ref=waxf8q9w&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
