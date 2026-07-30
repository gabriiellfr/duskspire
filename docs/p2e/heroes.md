# Hero model

Status: DRAFT. Numbers marked PROPOSED are for owner review; they gate Phase 2
of PLAN.md. Companion documents: PLAN.md (sections 3.2 and 3.3) and economy.md
(box pricing and odds).

## 1. What a hero is

A hero is one playable character in an account's roster:

- **Archetype**: one of the 9 existing classes (`src/sim/content/classes.ts`).
  Kits, talents, ranks, and balance are inherited from the base game unchanged.
- **Rarity**: Common, Rare, Epic, Legendary. Set at draw time, immutable.
- **Cosmetic identity**: generated name (renameable), appearance seed, rarity
  frame/VFX. Cosmetics only.
- **Progression state**: level, XP, talent allocation, equipment, deeds. This
  is the same per-character persistence shape the base game already saves; a
  hero is stored as a character row owned by an account, keyed additionally by
  its mint address once minted.
- **Ownership**: starter heroes are plain database rows (not NFTs, not
  tradable). Box heroes are NFTs; the chain is the ownership registry and the
  server resolves stats by mint address (PLAN.md 3.1).

A hero's level/gear/talents travel WITH the hero when it is sold: buyers are
buying the progression too. (This makes leveling a value-creating activity,
which is the core earn loop for non-PvP players.)

## 2. Rarity (PROPOSED)

Rarity multiplies base attributes, within a deliberately tight band so PvP
stays a game of builds and ratings rather than wallet size, and so matchmaking
(Elo plus stake tiers) can absorb the spread:

| Rarity | Base attribute multiplier | Cosmetic tier |
|---|---|---|
| Common | 1.00 | standard frame |
| Rare | 1.04 | silver frame, recolor set |
| Epic | 1.08 | gold frame, unique VFX tint |
| Legendary | 1.12 | animated frame, unique mount/aura cosmetic |

Rules:

- The multiplier applies to base attributes only, never to gear stats, so the
  gap narrows as gear dominates at endgame.
- Maximum PvP power gap from rarity alone stays under roughly 12 percent;
  the Elo system prices it in. No rarity-gated abilities, ever.
- Fairness invariant carried over from the base game: nothing sold ever grants
  actionable information or mechanics others cannot see or use.

## 3. Roster and account rules (PROPOSED)

- Roster cap: 20 heroes per account (raisable later; NFTs above the cap remain
  owned but must be swapped in at the city's Hero Hall to be playable).
- One hero active in the world at a time per account (the base one-character
  session model). Idle dispatch (PLAN.md Phase 3) can send up to 3 additional
  owned heroes on delve runs concurrently.
- Party play: a party is up to 5 accounts, one hero each (the base model).
  Solo party-of-own-heroes is NOT in v1 (it multiplies farm rate per account
  and is an economy risk; revisit after launch data).
- Selling a hero mid-progression: allowed, except while it is on an active
  dispatch, listed on the market (escrow), or in an active arena match.

## 4. The starter hero

- Granted at account creation: player picks any of 3 rotating archetypes
  (rotation keeps class distribution healthy).
- Common-equivalent stats, full progression, NOT an NFT, NOT tradable, never
  counted against the roster cap, cannot be dispatched (idle farming is a
  box-hero privilege and a key box motivation, PROPOSED, revisit if funnel
  data says it is too aggressive).
- Purpose: the whole game is evaluable for free (funnel, store policy, and
  fairness baseline).

## 5. Draws (summary; authoritative math in economy.md section 5)

- Hero Box draws rarity first (74/20/5/1 with pity 20/90), then archetype
  uniformly. Commit-reveal RNG, odds published.
- Duplicates are legitimate (different builds and market value); no shard
  system in v1.

## 6. Open questions for the owner

1. Roster cap 20: right size?
2. Dispatch limited to box heroes: keep, or allow the starter one dispatch
   slot as a taste of the idle loop?
3. Hero renaming: free once then token fee, or always a small coin fee?
4. Should Legendary include a gameplay-visible but cosmetic-only entrance VFX
   in arena (visibility sells boxes, but keep it skippable/quiet for others)?
