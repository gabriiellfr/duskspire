# Economy design

Status: DRAFT. Every number below is a PROPOSAL to be reviewed by the owner and
then validated in the Phase 4 headless economy simulation before it touches
anything real. This document gates Phases 5 and 6 of PLAN.md. Economy numbers
only change through this document plus a simulation run.

Currency names are placeholders until branding lands: the on-chain token is
written **TOKEN**, the off-chain soft currency **Coin**.

---

## 1. The two currencies

| | Coin | TOKEN |
|---|---|---|
| Where it lives | Server database only | Solana SPL token + server ledger balance |
| How players get it | Dungeon/delve drops, selling trash to vendors | Arena pots, seasonal payouts, selling on the market, buying/depositing |
| What it buys | Repairs, consumables, upgrade attempts, coin-tier market listings | Boxes, NFT market purchases, arena entry fees, relic minting, withdrawals |
| Withdrawable | Never | Yes (fees + caps below) |
| Design job | Absorb grind inflation | Carry real value, stay scarce |

The game must remain fun for a player who never touches TOKEN: coins plus
dungeon gear cover the whole PvE progression. TOKEN accelerates and monetizes;
it must never be the only path to playing.

## 2. TOKEN supply and allocation (PROPOSED)

- Fixed supply: 1,000,000,000 TOKEN. No further minting, ever (burned sinks are
  deflationary).
- Allocation:
  - 40 percent Play Rewards reserve (funds arena/season/event payouts; emission
    schedule below)
  - 20 percent Treasury (ops, audits, market making, contingency; multisig)
  - 15 percent Liquidity (DEX pools, locked)
  - 15 percent Team (24-month linear vest, 6-month cliff)
  - 10 percent Marketing and partners (12-month linear vest)
- Decision open (PLAN.md section 7): launch a new mint vs adopt an existing
  token. Everything below assumes a new mint.

## 3. Emission (faucets)

Principle: emission is BUDGETED, never formulaic from player activity. Player
counts scale who splits the budget, not the budget itself. This is the single
most important anti-collapse rule.

PROPOSED season = 8 weeks. Per-season emission from the Play Rewards reserve,
decaying 10 percent per season:

- Season 1 budget: 8,000,000 TOKEN (0.8 percent of supply), split:
  - 55 percent seasonal ladder prize pools (paid at season end, per format,
    top-N tables below)
  - 30 percent daily arena activity pools (small daily payouts to active rated
    players, Daily Rewards pipeline pattern)
  - 15 percent events and campaigns
- Arena stake pots are NOT emission: they redistribute player-deposited fees
  (minus rake). Marketplace flows are NOT emission either. Only the reserve
  emits.

Seasonal ladder payout table per format (percent of that format's pool):
rank 1: 20, rank 2: 12, rank 3: 8, ranks 4-10: 3 each, ranks 11-50: 0.975 each.
Eligibility: linked wallet, minimum 30 rated matches in season, not banned,
anti-abuse review passed (PLAN.md Phase 6).

## 4. Sinks

| Sink | PROPOSED value | Notes |
|---|---|---|
| Hero Box | 25 TOKEN | Section 5 |
| Equipment Box | 10 TOKEN | Section 5 |
| Arena rake | 10 percent of every stake pot | Half burned, half to Treasury |
| Relic mint fee | 2 TOKEN | Converts a dungeon relic drop into an NFT |
| Marketplace fee | 5 percent of sale price | Half burned, half to Treasury; seller pays |
| Withdrawal fee | 1 percent, minimum 0.5 TOKEN | Plus network cost; discourages micro-churn |
| Upgrade acceleration | 1-5 TOKEN per skip | Optional; from the coin upgrade system's timers |
| Cosmetics | varies | Pure sink, never power |

Target health metric: **sink coverage ratio** (TOKEN destroyed or returned to
treasury/reserve per day, divided by TOKEN emitted per day) at or above 0.8
once the market matures (season 3+). Season 1 will run lower while the box
economy bootstraps; watch the trend, not the day.

Coin sinks (repairs, consumable crafting, upgrade attempts with failure risk,
coin listing fees, vendor gear) must scale with coin faucets from dungeon
tuning; the Phase 4 simulation calibrates drop tables so a mid-skill player's
coin balance is roughly flat at their content tier.

## 5. Boxes (gacha)

Server-authoritative opening with commit-reveal RNG: before each season the
server publishes hash(seed); at season end it reveals the seed; every draw is
`prng(seed, accountId, drawIndex)` so any player can recompute their draws.
Odds are published in-game and on the site (loot-box law compliance).

### Hero Box: 25 TOKEN (PROPOSED)

| Rarity | Odds | Pity |
|---|---|---|
| Common | 74 percent | |
| Rare | 20 percent | |
| Epic | 5 percent | Guaranteed Epic or better within every 20 opens |
| Legendary | 1 percent | Guaranteed within every 90 opens (counter carries across seasons) |

Class is drawn uniformly across the 9 archetypes after rarity. Duplicate
heroes are legitimate (different builds/gear/market value); no dupe-shard
system at launch (keep v1 simple).

### Equipment Box: 10 TOKEN (PROPOSED)

Draws from the same stat budget as dungeon gear of the player's tier
(PLAN.md 3.3): guaranteed Uncommon+, 10 percent Epic-tier, 2 percent
box-exclusive cosmetic line (cosmetic only). Box gear arrives NFT-eligible
(mint fee still applies to make it tradable).

EV rule: the expected market value of a box's contents must stay below the box
price (boxes are a convenience/variance product, not an arbitrage machine);
the Phase 4 simulation checks this against simulated market prices each
tuning pass.

## 6. Arena stake tiers (PROPOSED, gated on the legal memo)

| Tier | Entry fee per player | Formats |
|---|---|---|
| Bronze | 1 TOKEN | 1v1, 2v2, 3v3, 4v4, 5v5 |
| Silver | 5 TOKEN | 1v1, 2v2, 3v3, 4v4, 5v5 |
| Gold | 25 TOKEN | 1v1, 2v2, 5v5 |

Pot = sum of entries. Rake 10 percent. Winner side splits the remainder
evenly. Draw/abort/no-match: full refund. Fees escrow on the server ledger at
queue time. Stake queues match within the tier only, and within a rating band
(plus or minus 200 Elo, widening with queue time) so tiers stay competitive.

## 7. Ledger and withdrawals

- Double-entry server ledger (PLAN.md Phase 4): every TOKEN a player sees
  in-game is a ledger balance; deposits credit it after on-chain confirmation,
  withdrawals debit it and settle on-chain through the payout pipeline.
- Withdrawal controls (PROPOSED): minimum 10 TOKEN per withdrawal; daily cap
  500 TOKEN per account and per wallet; new-account holdback (no withdrawals
  for the first 7 days); manual-review threshold above 5,000 TOKEN per week.
  KYC threshold: per the Phase 0 legal memo.
- Hot-wallet float capped at 2 days of average withdrawal volume; the rest of
  the treasury stays in cold storage/multisig.

## 8. Monitoring (Phase 6 dashboards)

Daily: emission vs sinks (the coverage ratio), stake pot volume and rake,
box opens and realized EV, market velocity and median prices by asset class,
withdrawal volume vs deposit volume, top-100 earner concentration.
Alert thresholds are set in the admin dashboard config, not in code.

## 9. Simulation protocol (Phase 4)

Before any of these numbers go live, and again before every change:

1. Drive N simulated weeks in the headless env: bot populations at three skill
   tiers running the actual dungeon/delve/arena loops (the RL env drives the
   real sim, so farm rates are real, not spreadsheet guesses).
2. Feed the resulting drop/coin/relic rates into the economy model with the
   proposed prices/fees; compute the coverage ratio and box EV.
3. Record the run (seed, build, inputs, outputs) in `docs/p2e/economy-runs/`
   and link it from the change PR.
