# Project Plan: Web3 Play-to-Earn Idle Battle Game (fork of World of ClaudeCraft)

This document is the master guide for building the new game on top of the World of
ClaudeCraft codebase. It covers the product definition, the economy and NFT design,
the fork strategy, and the full phase-by-phase implementation plan. Treat it as a
living document: update it as decisions are made and phases complete.

---

## 1. Product definition

A web3 play-to-earn idle battle game:

- One **city hub** (no open world at launch): players walk around, chat, trade,
  interact with NPCs and each other.
- **Heroes** are obtained from purchasable boxes (gacha). A player's account owns a
  roster of heroes; heroes are NFTs the player truly owns and can sell.
- From the city, players enter **single or party dungeons** to farm coins,
  materials, and equipment, and to level their heroes.
- An **arena** hosts multiplayer idle (auto-resolved) ranked battles in several
  formats, with entry fees, prize pots, and seasonal ladder rewards.
- An **in-game marketplace** lets players list and sell heroes and equipment to
  each other, priced in the project token.
- Two currencies: a soft in-game **coin** (off-chain, abundant) and the project
  **token** (on-chain, scarce, real value).

Not in scope at launch: the open-world zones, quest storyline, professions
crafting economy, world bosses, Vale Cup, Card Duel, the RL environment, the
public wiki. All of these remain in the codebase (dark, disabled by config or
content) and can be reintroduced later as features.

---

## 2. What the base project already provides

| Needed for the game | Status in base | Where |
|---|---|---|
| City hub with movement, chat, NPCs, parties, guilds, trading | Done | `src/sim/`, `server/` |
| Swappable world definition (one custom city map, no overworld) | Done (editor + `WorldContent` seam) | `src/sim/types.ts` (`WorldContent`, `SimConfig.world`), `src/editor/` |
| Instanced dungeons with party support, bosses, loot | Done | `src/sim/` dungeons, Dungeon Finder |
| Randomized 1-2 player farming runs with AI companion | Done (delves) | delve content + delve run system |
| Ranked arena with Elo, queues, exactly-once results, anti-farm honor DR | Done (1v1, 2v2, fiesta, yumi3, yumi5) | `src/sim/sim.ts` (`ArenaMatch`), `src/sim/social/` arena module |
| Player-to-player market (search, list, buy, collect) | Done (coin-priced, off-chain) | `src/world_api/market.ts`, sim market module |
| Solana wallet link (challenge + ed25519 sign, replay-safe, one wallet per account) | Done | `server/wallet.ts`, `scripts/wallet_e2e.mjs` |
| On-chain payments in SOL / USDC / project token | Done (Claudium store rails) | `server/claudium_proxy.ts`, `server/desktop_wallet_handoff.ts` |
| Token prize-pool payouts to wallets with eligibility, bans, tx records | Done (Daily Rewards) | `server/daily_rewards.ts`, `server/daily_rewards_db.ts` |
| Server authority for all outcomes (combat, loot, economy) | Done | whole server design |
| Auth, persistence, moderation, admin dashboard, realms | Done | `server/`, `src/admin/` |
| Desktop/mobile native shells, i18n (22 locales), CI/QA gates | Done | `electron/`, `android/`, `ios/`, `src/ui/i18n.*` |
| Idle/auto-battle combat | NOT built (precedents: delve AI companion, arena bots, headless RL driver) | new work |
| Hero roster per account (multiple playable heroes, gacha supply) | NOT built (base is one character per slot, player-created) | new work |
| Boxes / gacha opening | NOT built (store SKU + payout rails are precedents) | new work |
| NFT mint / ownership verification / escrow marketplace | NOT built (wallet + payment rails are precedents) | new work |
| Arena entry fees, pots, 3v3/4v4/5v5 team-battle formats | NOT built (arena core + honor system are precedents) | new work |

Conclusion: roughly 70 percent of the product is inherited. The genuinely new
work is (a) the hero/gacha model, (b) idle battle, (c) the on-chain item layer,
(d) the fee/pot/season reward economy.

---

## 3. Economy and NFT design (the decisions)

### 3.1 Three-layer asset model

1. **Coin (soft currency, off-chain).** Earned in dungeons, spent on repairs,
   consumables, box re-rolls, upgrade attempts, listing fees. Never withdrawable.
   This is the inflation buffer: it absorbs grind so the token does not have to.
2. **Token (hard currency, on-chain SPL token).** Bought/sold on DEXes, used for:
   buying boxes, marketplace purchases, arena entry fees, minting fees, upgrade
   acceleration. Earned from: arena pots, seasonal ladder payouts, selling items
   or heroes on the market. The server keeps a custodial in-game token balance
   ledger (deposit/withdraw model) so gameplay never waits on chain latency;
   withdrawals settle on-chain. The existing Claudium purchase rails and the
   Daily Rewards payout pipeline are the reference implementations for deposit
   and withdrawal respectively.
3. **NFTs (heroes and premium equipment).** Minted on Solana (recommendation:
   Metaplex Core assets, or compressed NFTs if mint volume is high; decide in
   Phase 5 by projected volume and marketplace compatibility). The chain is the
   ownership registry; all stats live server-side keyed by mint address, so a
   marketplace sale transfers power without trusting client data.

### 3.2 Heroes and boxes (gacha)

- **Heroes come from Hero Boxes.** A box is a store SKU priced in the token
  (with SOL/USDC rails available, as Claudium already supports). Opening is
  server-authoritative: the server draws rarity and hero identity from an
  auditable RNG (commit-reveal: publish a seed hash before the season, reveal
  after, so players can verify draws were not rigged), then mints the hero NFT
  to the buyer's linked wallet (or holds it custodially until the player links
  a wallet: do not force a wallet to play).
- Hero rarity tiers (for example Common/Rare/Epic/Legendary) gate base stat
  multipliers and cosmetic identity, not access to game modes. Include a pity
  system (guaranteed Rare+ every N opens) to keep box EV predictable.
- The 9 existing classes become the hero archetypes at launch (they are data in
  `src/sim/content/classes.ts`); rarity is a layer on top. This avoids
  rebuilding combat kits and keeps balance work inherited.
- **Equipment Boxes** exist as well, but see 3.3: they must not be the only
  gear source, or gameplay stops mattering.
- New players get one free non-NFT starter hero so the game is playable before
  any purchase (important for funnel, for app-store policy, and for reducing
  the "pay before you can even evaluate" barrier that kills P2E games).

### 3.3 Drop economy: dungeons vs boxes

Decision: **dungeons drop the progression; boxes compress time and supply the
NFT-grade top end. Both matter, neither is strictly better.**

- Dungeon drops: coins (always), upgrade materials (common), standard equipment
  (regular loot tables, off-chain items, the bulk of gearing), and rarely an
  **unminted relic**: an item flagged NFT-eligible. The owner may pay a token
  minting fee to convert it into a tradable NFT. Mint-on-demand keeps chain
  costs near zero for the 95 percent of drops nobody would sell, and the fee is
  a token sink.
- Equipment boxes: guaranteed-quality gear and box-exclusive cosmetic lines,
  drawn from the same stat budget as dungeon gear of the same tier (no
  pay-only power ceiling, or the PvP ladder dies). Boxes give speed and
  variance control; dungeons give the grind path to the same tiers.
- Heroic/tiered difficulty (already in the base) scales drop quality; harder
  content has better relic odds.

### 3.4 Arena rewards

Two parallel reward tracks:

1. **Free ranked ladder (always on).** Elo per format (already built). Seasonal
   payouts from a sponsored prize pool to the top N per format, paid through
   the Daily Rewards payout pipeline pattern (eligibility: linked wallet,
   anti-abuse checks). Plus non-monetary rewards (titles, badge borders,
   cosmetics) via the existing deeds/honor systems for the long tail.
2. **Stake matches (opt-in).** Both sides pay an entry fee in tokens into a pot;
   winner side takes the pot minus a protocol rake (rake is a primary token
   sink and revenue line). Formats: 1v1 winner-takes-all; 2v2 through 5v5 split
   the pot evenly across the winning team. Fixed fee tiers per format (for
   example 1 / 5 / 25 tokens) rather than free-form wagers: tiers make
   matchmaking pools liquid and limit whale-vs-newbie predation.
   - Fees are escrowed by the server ledger at queue time and refunded on
     no-match or draw/abort.
   - IMPORTANT legal flag: fee-in, winner-takes-pot on a real-value token is
     wagering-shaped and is regulated or prohibited in several jurisdictions
     (and restricted by Apple/Google store policies). Before building Phase 6,
     get a legal read for the target markets; be prepared to geo-gate stake
     matches or reframe rewards. The free ladder track carries the game either
     way.
   - Formats to add: 3v3, 4v4, 5v5 team battles (the arena core supports
     multi-member teams; yumi3/yumi5 prove 3s and 5s work; the new formats are
     straight team deathmatch brackets plus matchmaking config).
   - All stake matches are idle battles (see Phase 3), which also neutralizes
     most input-skill-based cheating.

### 3.5 Marketplace

- The in-game **World Market** (search, listings, buy, collect) is extended:
  listings priced in tokens (from the server token ledger), and a listing can
  carry an NFT. NFT listings escrow the asset (transfer to a program-owned or
  server-custodial escrow at list time, released to buyer on sale, returned on
  cancel). Coin listings for ordinary gear keep working as today.
- Marketplace fee (a percent of sale) is another token sink.
- Because heroes/relics are real NFTs, they are ALSO tradable on external
  marketplaces (Magic Eden etc.) with royalties configured at mint. In-game
  stats resolve by mint address, so external trades just work; the in-game
  market's job is convenience and liquidity, not exclusivity. This is the
  strongest possible "you really own it" proof for players.

### 3.6 Faucets and sinks (keep this table balanced forever)

| Token faucets (in) | Token sinks (out) |
|---|---|
| Arena pot winnings (net of rake) | Box purchases |
| Seasonal ladder prize pools | Arena entry fees (rake share) |
| Selling items/heroes to other players | Relic minting fees |
| (indirect) buying tokens on a DEX | Marketplace fees |
| | Upgrade/acceleration spends |
| | Cosmetics |

Rule: every new faucet PR must name its offsetting sink. The economy model
lives in `docs/p2e/economy.md` (created in Phase 0) with target daily
emission, projected player counts, and the sink coverage ratio; re-run the
model whenever a number changes. Use the headless sim (`headless/`) to
simulate farm rates before touching live values.

---

## 4. Fork strategy: diverge little, merge often

Goal: a long-lived fork that can still absorb upstream engine fixes.

1. **Repository setup.** GitHub fork; remotes `origin` (the fork) and
   `upstream` (levy-street/world-of-claudecraft). The fork's `main` tracks a
   chosen upstream release tag; game work happens on feature branches into the
   fork's own release branches, mirroring upstream's workflow.
2. **Additive-first rule.** All new game code lands in NEW modules behind the
   seams the repo already enforces (this is also its own stated convention):
   - New sim systems: modules behind `SimContext` (`src/sim/sim_context.ts`).
   - New content: new files under `src/sim/content/` merged in `data.ts`.
   - New endpoints: new `RouteDef` modules registered in `server/http/registry.ts`.
   - New UI: new HUD component modules, never edits inside `hud.ts` bodies.
   - New world: a `WorldContent` value (the city), injected via config, never
     edits to the built-in zones.
   - P2E-only server code under a dedicated `server/p2e/` directory.
   Merges then conflict only at small registration points (a route table line,
   a `data.ts` spread, a facet interface), not inside upstream logic.
3. **Feature flags over deletion.** Disable unwanted upstream systems (open
   world, professions, Vale Cup, wiki) behind config/env flags or by simply not
   including their content in the injected world, instead of deleting their
   code. Deleted code is a permanent merge conflict; dark code is free.
4. **Divergence ledger.** `docs/p2e/DIVERGENCE.md` lists every upstream file
   the fork has modified and why. Keep it short by keeping the list short. At
   each upstream merge, the ledger IS the conflict checklist.
5. **Merge cadence.** Merge each upstream release tag (not raw main) within a
   sprint of its release, while the delta is small. Run the full gate
   (`npm run gate`) plus the fork's own test suite after each merge.
6. **Upstream what is generic.** Where a fork need is met by making an upstream
   seam slightly more general (for example a config flag upstream would accept),
   PR it upstream. Every accepted PR is divergence that permanently disappears.
7. **Branding isolation.** Names, logos, palette, and copy live in the i18n
   catalogs, `public/` assets, and a small branding config; keep them out of
   logic files so rebranding never conflicts.

---

## 5. Phases

Each phase ends with a playable/demonstrable milestone and a written acceptance
check. Do not start a phase's on-chain or paid elements before its off-chain
version is fun and stable: chain integration freezes the design.

### Phase 0: Foundation (setup, design locks, compliance)

Steps:
1. Create the fork, remotes, branch protection, CI (reuse upstream CI), and the
   divergence ledger. Verify `npm run gate` is green on the fork untouched.
2. Write `docs/p2e/economy.md`: token supply and distribution, emission
   schedule, faucet/sink model with numbers, box pricing and EV, pity math,
   rake percent, season cadence. This document gates Phases 5 and 6.
3. Write `docs/p2e/heroes.md`: hero model (rarity tiers, stat multipliers,
   level/gear inheritance from the base game, roster size, starter hero).
4. Legal/compliance review kickoff: token classification, stake-match gambling
   exposure per target market, KYC needs for withdrawals, app-store policy for
   NFT/token features (both stores restrict them; browser + desktop may need to
   be the primary channels). Output: a written go/no-go per feature per region.
5. Branding: name, domain, palette, logo set; strip ClaudeCraft branding via
   the i18n catalog and `public/` assets swap.
6. Environments: dev Postgres, staging server, Solana devnet wallets and a
   devnet test token.

Acceptance: fork boots the unmodified game under the new brand on staging;
economy and hero docs approved; legal memo delivered.

### Phase 1: The city and the trimmed game (off-chain vertical slice)

Steps:
1. Author the **city world**: one `WorldContent` (start in the world editor,
   then commit as a content module, for example `src/sim/content/p2e_city.ts`):
   city terrain, buildings, NPC placement (vendors, market, mailbox, arena
   master, dungeon portals, box vendor placeholder), player start, blockers.
2. Inject it via `SimConfig.world` for all three hosts; the server boots the
   city instead of the built-in world.
3. **Trim by configuration**: no overworld camps/quests in the injected world;
   hide unused HUD surfaces (quest log, professions, Vale Cup) behind a game
   profile flag; keep dungeons, delves, arena, market, mail, parties, guilds,
   chat.
4. Wire the city's dungeon portals to a chosen launch set: 2-3 of the existing
   dungeons plus the two delves (the randomized-chamber mode is the flagship
   farming loop). Rebalance entry levels to the launch level band.
5. Update the pinned tests that the trim touches (world parity, guide/content
   pins) and add a test that boots a Sim on the city world and runs 1000 ticks
   deterministically.

Acceptance: multiplayer city on staging; two players can meet, chat, party,
clear a delve and a dungeon, loot coins and gear, level up. Full gate green.

### Phase 2: Heroes and the roster (still off-chain)

Steps:
1. Data model: `heroes` table keyed by account (later by mint address);
   a hero is class + rarity + cosmetic identity + level/XP/talents/equipment,
   reusing the existing character persistence shape per hero.
2. Character select becomes **roster select**; a free starter hero is granted
   at account creation. Hero cap per account from config.
3. **Boxes, off-chain first**: box SKUs purchasable with a placeholder balance,
   server-side draw (rarity tables + pity counters, all through auditable
   server RNG), hero granted to roster. Build the open animation/UI.
4. Equipment boxes likewise, feeding the normal inventory.
5. Admin dashboard pages: box tables, draw audit log, grant/revoke tools.
6. Tests: draw distribution tests (statistical bounds), pity guarantees,
   roster persistence, grant idempotency.

Acceptance: a player opens boxes, builds a roster, plays any owned hero into
Phase 1 content. Draw audit log reconciles exactly with grants.

### Phase 3: Idle battle

Steps:
1. **Auto-combat policy module** in the sim (behind `SimContext`): a per-class
   priority-list controller (target selection, ability rotation, positioning
   band, potion use). Precedents to build from: delve AI companion, arena
   bots. Deterministic: all decisions from sim state + `Rng`.
2. **Idle arena**: all ranked/stake formats auto-resolve using the policy;
   players watch (spectator camera) or leave; result, rating, and rewards
   apply on completion regardless of presence. Add 3v3/4v4/5v5 team brackets
   to the arena module (queue config + team spawn layouts on the existing
   maps).
3. **Idle dungeon farming**: dispatch a hero (or party of own heroes) on a
   delve run that resolves over real time server-side; loot arrives by mail
   (the mail system is built). This is the idle-game retention loop. Cap
   concurrent dispatches; energy/stamina system if the economy model calls
   for it.
4. Player-strategy surface: let players order the priority list / stance per
   hero (this is the skill expression in an idle game; it also differentiates
   ratings honestly).
5. Tests: policy determinism (same seed, same battle), battle resolution with
   zero connected clients, dispatch loot accounting exactly-once.

Acceptance: two rosters fight a full 5v5 with no player input; a dispatched
delve pays out by mail while the player is offline; ladder updates correctly.

### Phase 4: Token ledger, marketplace, and economy tuning (still no chain writes)

Steps:
1. **Server token ledger**: double-entry balances table (account, amount,
   reason, ref), every mutation through one module with an audit trail. All
   Phase 2 box purchases and Phase 3 rewards switch to the ledger. This ledger
   is exactly what later settles against the chain.
2. **Marketplace v2**: World Market listings in token prices for eligible
   assets (heroes, relic-flagged gear); escrow the asset server-side at list
   time; marketplace fee to a sink account.
3. Arena stake matches on ledger balances (fees, pots, rake), gated OFF by
   default pending the Phase 0 legal memo.
4. **Economy simulation**: drive weeks of simulated play through the headless
   env (farm rates, box opens, market flow) against `docs/p2e/economy.md`
   targets; tune drop rates, fees, pity, and rake before real value exists.
5. Anti-abuse foundations: per-account and per-wallet rate limits, multi-account
   correlation (the antibot config machinery exists), trade-loop detection,
   admin freeze tooling on the ledger.

Acceptance: full game loop runs on the internal ledger; a season of simulated
economy stays within emission targets; every ledger mutation is auditable.

### Phase 5: On-chain layer (token, NFTs, custody)

Steps:
1. Token: launch (or adopt) the SPL token; liquidity plan per the economy doc.
2. **Deposits**: token purchase/deposit flow reusing the Claudium transaction
   rails (`sol`/`usdc`/token) crediting the ledger after confirmed on-chain
   settlement.
3. **Withdrawals**: reuse the Daily Rewards payout pipeline pattern (linked
   wallet, eligibility, ban checks, recorded tx signatures) for ledger to
   wallet withdrawals; withdrawal fee and/or daily caps per the economy doc;
   KYC threshold if the legal memo requires it.
4. **NFT minting service**: hero mints on box open, relic mint-on-demand;
   metadata standard (collection, attributes mirroring server stats snapshot);
   royalties; custodial holding for wallet-less players with a claim flow.
5. **Ownership sync**: index transfers of the collections (webhook/indexer);
   on transfer, the hero/relic re-keys to the new owner's account when they
   link the holding wallet. In-game market NFT sales move the asset through
   escrow and settle both ledger and chain.
6. Security: withdrawal signing key isolation (HSM/KMS), invariant monitors
   (total ledger vs treasury), third-party audit of any on-chain program and
   of the deposit/withdraw path.

Acceptance: end-to-end on devnet then mainnet-beta: buy box with token, hero
NFT lands in wallet, sell hero in-game to another player, buyer plays it,
seller withdraws proceeds to wallet; books reconcile to the lamport.

### Phase 6: Stake arena and seasons (live economy)

Steps:
1. Enable stake matches where the legal memo allows (geo-gating in place).
2. Season system: season table, rating soft-reset, seasonal prize pools paid
   through the payout pipeline, season cosmetics via deeds.
3. Anti-abuse hardening for real value: win-trade detection (the honor DR
   team-key machinery is the starting point), collusion analytics, device and
   payment fingerprinting on entries, delayed payout window with review for
   outliers.
4. Observability: economy dashboards in the admin app (emission vs sink daily,
   pot volume, rake revenue, box EV realized, market velocity).

Acceptance: one full internal season with fees and payouts on staging under
bot load; abuse drills (win-trading, multi-boxing) are detected and blocked.

### Phase 7: Launch hardening and live ops

Steps:
1. Full security pass: external audit results resolved; `privacy-security-review`
   and `release-malware-audit` gates; load test the city (one dense hub is a
   hotter interest-scope than a spread-out world; profile with the existing
   mob-stall/profiler harnesses); DDoS posture.
2. Store/channel strategy per the legal memo (browser + desktop first if
   mobile stores block token features; the shells exist when policy allows).
3. Launch content calendar (new dungeon/delve cadence, box lines, seasons),
   support runbooks, moderation staffing, incident playbooks (chain outage:
   the ledger design keeps the game playable with withdrawals paused).
4. Soft launch (capped region/population), economy watch, then launch.

Acceptance: soft-launch exit criteria met (retention, economy within model,
zero critical incidents for N weeks).

---

## 6. Top risks

1. **Economy collapse** (every P2E's killer): emission outpaces sinks, token
   price falls, earners leave. Mitigation: the sink-per-faucet rule, headless
   economy simulation before every tuning change, caps and rake as pressure
   valves, and a game that is fun at zero token price.
2. **Regulatory/gambling exposure** on stake matches and box gacha (loot-box
   law in several countries). Mitigation: Phase 0 legal memo gates the
   features; publish box odds (auditable commit-reveal RNG helps here too);
   geo-gates; the free ladder carries the product anywhere stakes cannot ship.
3. **Bots and multi-accounting** farming rewards. Mitigation: server authority
   (inherited), idle-battle design (removes input-bot advantage), wallet-and
   payment-linked eligibility, correlation analytics, delayed payouts.
4. **Custody/security**: the withdrawal signer and any escrow program are the
   crown jewels. Mitigation: key isolation, invariant monitors, external
   audit, capped hot-wallet float.
5. **Fork drift**: divergence creep makes upstream merges painful. Mitigation:
   section 4 rules, the divergence ledger, merge-per-release cadence.
6. **App store policy** on NFT/token features. Mitigation: browser/desktop
   first; mobile ships the game with web3 surfaces hidden if needed.

---

## 7. Open decisions (resolve by phase)

| Decision | Resolve by | Notes |
|---|---|---|
| Token: new SPL mint vs existing token | Phase 0 | Affects economy doc and liquidity plan |
| NFT standard: Metaplex Core vs compressed NFTs | Phase 5 start | By mint volume and marketplace support |
| Custodial default vs wallet-required for NFTs | Phase 2 (model), Phase 5 (final) | Recommendation: custodial default, claim-to-wallet optional |
| KYC threshold for withdrawals | Phase 0 legal memo | |
| Stake-match availability per region | Phase 0 legal memo, enforced Phase 6 | |
| Hero rarity count and stat spread | Phase 0 heroes doc | Keep PvP within fair bands |
| Launch dungeon/delve set and level band | Phase 1 | |
| Energy/stamina system for idle dispatch | Phase 3, from economy model | |
| Season length and prize split | Phase 6 | |

---

## 8. Working agreements

- Follow the base repo's contribution baseline: release-branch workflow, git
  worktrees per task, module-first seams, tests with every sim/server change,
  `npm run gate` before done. The fork inherits the QA machinery; keep it green.
- Every phase gets a tracking issue with its steps as a checklist; this
  document links to them as they are created.
- Economy numbers only change through `docs/p2e/economy.md` plus a simulation
  run; never hot-tune live drop rates by feel.
