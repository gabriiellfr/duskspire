// PURE hero-box draw core (docs/p2e/economy.md section 5, docs/p2e/heroes.md).
// No IO, no pg, unit-tested directly; node:crypto sha256 is the only import.
//
// Commit-reveal verifiability: every roll derives from
// sha256(`${seasonSeed}:${accountId}:${drawIndex}:${lane}`), so with the
// season seed revealed at season end any player can recompute their draws and
// prove none was rigged. The server publishes sha256(seasonSeed) up front
// (GET /api/p2e/season) and keeps the seed secret until reveal.
//
// Pity is deterministic state, not randomness: the epic guarantee fires on the
// EPIC_PITY-th draw since the last epic-or-better, the legendary guarantee on
// the LEGENDARY_PITY-th since the last legendary; a natural roll at or above
// the guaranteed tier resets the counter early. Legendary pity outranks epic
// pity, and a pity upgrade never downgrades a natural roll.
import { createHash } from 'node:crypto';
import { ALL_CLASSES, type PlayerClass } from '../src/sim/types';

export const HERO_RARITIES = ['common', 'rare', 'epic', 'legendary'] as const;
export type HeroRarity = (typeof HERO_RARITIES)[number];

// Odds in basis points of 10_000 (economy.md: 74 / 20 / 5 / 1).
export const RARITY_ODDS_BP: Record<HeroRarity, number> = {
  common: 7_400,
  rare: 2_000,
  epic: 500,
  legendary: 100,
};
export const EPIC_PITY = 20; // guaranteed epic-or-better within every 20 opens
export const LEGENDARY_PITY = 90; // guaranteed legendary within every 90 opens

// Hero Box price in SPIRE base units (economy.md: 25 SPIRE).
export const HERO_BOX_PRICE_BASE = 25n * 10n ** 9n;

export interface PityState {
  sinceEpic: number; // completed draws since the last epic-or-better
  sinceLegendary: number; // completed draws since the last legendary
}

export interface HeroDraw {
  rarity: HeroRarity;
  heroClass: PlayerClass;
  rarityRoll: number; // 0..9999, the verifiable natural roll
  classRoll: number; // 0..(classCount-1)
  pityApplied: 'none' | 'epic' | 'legendary';
  nextPity: PityState;
}

/** The published commitment for a season seed. */
export function seasonSeedHash(seasonSeed: string): string {
  return createHash('sha256').update(seasonSeed, 'utf8').digest('hex');
}

// One uniform integer in [0, bound) from the verifiable hash lane. 48 bits of
// hash into a double is exact (< 2^53) and bias is negligible for our bounds
// (10_000 and 9) against 2^48.
function verifiableRoll(
  seasonSeed: string,
  accountId: number,
  drawIndex: number,
  lane: string,
  bound: number,
): number {
  const digest = createHash('sha256')
    .update(`${seasonSeed}:${accountId}:${drawIndex}:${lane}`, 'utf8')
    .digest();
  const value = digest.readUIntBE(0, 6); // 48 bits
  return Math.floor((value / 2 ** 48) * bound);
}

function naturalRarity(rarityRoll: number): HeroRarity {
  if (rarityRoll < RARITY_ODDS_BP.legendary) return 'legendary';
  if (rarityRoll < RARITY_ODDS_BP.legendary + RARITY_ODDS_BP.epic) return 'epic';
  if (rarityRoll < RARITY_ODDS_BP.legendary + RARITY_ODDS_BP.epic + RARITY_ODDS_BP.rare) {
    return 'rare';
  }
  return 'common';
}

const AT_LEAST_EPIC: ReadonlySet<HeroRarity> = new Set(['epic', 'legendary']);

/**
 * Draw one hero. `drawIndex` is the account's 1-based draw counter in the
 * season (allocated by the caller under a lock); `pity` is the state BEFORE
 * this draw. Deterministic for a given (seed, account, index, pity).
 */
export function drawHero(
  seasonSeed: string,
  accountId: number,
  drawIndex: number,
  pity: PityState,
): HeroDraw {
  const rarityRoll = verifiableRoll(seasonSeed, accountId, drawIndex, 'rarity', 10_000);
  const classRoll = verifiableRoll(seasonSeed, accountId, drawIndex, 'class', ALL_CLASSES.length);
  const natural = naturalRarity(rarityRoll);

  let rarity = natural;
  let pityApplied: HeroDraw['pityApplied'] = 'none';
  if (pity.sinceLegendary >= LEGENDARY_PITY - 1 && natural !== 'legendary') {
    rarity = 'legendary';
    pityApplied = 'legendary';
  } else if (pity.sinceEpic >= EPIC_PITY - 1 && !AT_LEAST_EPIC.has(natural)) {
    rarity = 'epic';
    pityApplied = 'epic';
  }

  const nextPity: PityState = {
    sinceEpic: AT_LEAST_EPIC.has(rarity) ? 0 : pity.sinceEpic + 1,
    sinceLegendary: rarity === 'legendary' ? 0 : pity.sinceLegendary + 1,
  };
  return {
    rarity,
    heroClass: ALL_CLASSES[classRoll],
    rarityRoll,
    classRoll,
    pityApplied,
    nextPity,
  };
}

// ---------------------------------------------------------------------------
// Hero names: deterministic, letters-only (the classic name rule), derived
// from the same verifiable lane so the whole grant is recomputable. The
// attempt counter feeds the hash so a UNIQUE-name collision retries to a
// different deterministic candidate.
// ---------------------------------------------------------------------------

const NAME_HEADS = [
  'Ash',
  'Bran',
  'Cael',
  'Dorn',
  'Ered',
  'Fenn',
  'Gal',
  'Hild',
  'Isen',
  'Jor',
  'Kael',
  'Lorn',
  'Morr',
  'Nym',
  'Orin',
  'Pyr',
  'Quill',
  'Ravn',
  'Syl',
  'Thal',
  'Ulric',
  'Vael',
  'Wren',
  'Yor',
  'Zeph',
];
const NAME_TAILS = [
  'adin',
  'bara',
  'crest',
  'dane',
  'eth',
  'fara',
  'gorn',
  'hollow',
  'is',
  'jun',
  'kara',
  'lish',
  'mund',
  'nara',
  'oth',
  'pike',
  'ric',
  'sha',
  'tide',
  'usk',
  'vane',
  'wick',
  'yr',
  'zara',
];

export function deriveHeroName(
  seasonSeed: string,
  accountId: number,
  drawIndex: number,
  attempt: number,
): string {
  const head =
    NAME_HEADS[
      verifiableRoll(seasonSeed, accountId, drawIndex, `name-head-${attempt}`, NAME_HEADS.length)
    ];
  const tail =
    NAME_TAILS[
      verifiableRoll(seasonSeed, accountId, drawIndex, `name-tail-${attempt}`, NAME_TAILS.length)
    ];
  return `${head}${tail}`;
}
