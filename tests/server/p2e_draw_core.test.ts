import { describe, expect, it } from 'vitest';
import {
  deriveHeroName,
  drawHero,
  EPIC_PITY,
  HERO_BOX_PRICE_BASE,
  LEGENDARY_PITY,
  type PityState,
  RARITY_ODDS_BP,
  seasonSeedHash,
} from '../../server/p2e_draw_core';
import { ALL_CLASSES } from '../../src/sim/types';

const SEED = 'test-season-seed';
const FRESH: PityState = { sinceEpic: 0, sinceLegendary: 0 };

describe('drawHero determinism and verifiability', () => {
  it('is deterministic for the same (seed, account, index, pity)', () => {
    expect(drawHero(SEED, 7, 1, FRESH)).toEqual(drawHero(SEED, 7, 1, FRESH));
  });

  it('differs across accounts, indexes, and seeds', () => {
    const base = drawHero(SEED, 7, 1, FRESH);
    const rolls = [
      drawHero(SEED, 8, 1, FRESH),
      drawHero(SEED, 7, 2, FRESH),
      drawHero('other-seed', 7, 1, FRESH),
    ].map((d) => `${d.rarityRoll}:${d.classRoll}`);
    // At least one lane must differ from the base for each variation (hash
    // collisions across all three would mean the roll ignores its inputs).
    expect(rolls.some((r) => r !== `${base.rarityRoll}:${base.classRoll}`)).toBe(true);
  });

  it('publishes a stable sha256 commitment for the seed', () => {
    expect(seasonSeedHash(SEED)).toMatch(/^[0-9a-f]{64}$/);
    expect(seasonSeedHash(SEED)).toBe(seasonSeedHash(SEED));
    expect(seasonSeedHash(SEED)).not.toBe(seasonSeedHash('other-seed'));
  });

  it('always draws a real class', () => {
    for (let i = 1; i <= 200; i++) {
      expect(ALL_CLASSES).toContain(drawHero(SEED, 42, i, FRESH).heroClass);
    }
  });
});

describe('rarity distribution', () => {
  it('tracks the published odds over many draws (fresh pity, no guarantees)', () => {
    const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
    const n = 40_000;
    for (let i = 1; i <= n; i++) {
      counts[drawHero(SEED, 1_000_000 + i, 1, FRESH).rarity]++;
    }
    // Each observed share within an absolute 1 percentage point of the odds.
    for (const rarity of ['common', 'rare', 'epic', 'legendary'] as const) {
      const expected = RARITY_ODDS_BP[rarity] / 10_000;
      expect(Math.abs(counts[rarity] / n - expected)).toBeLessThan(0.01);
    }
  });
});

describe('pity guarantees', () => {
  it('guarantees epic-or-better within every EPIC_PITY draws', () => {
    for (let account = 1; account <= 50; account++) {
      let pity = FRESH;
      let gap = 0;
      for (let i = 1; i <= 200; i++) {
        const draw = drawHero(SEED, account, i, pity);
        gap = draw.rarity === 'epic' || draw.rarity === 'legendary' ? 0 : gap + 1;
        expect(gap).toBeLessThan(EPIC_PITY);
        pity = draw.nextPity;
      }
    }
  });

  it('guarantees legendary within every LEGENDARY_PITY draws', () => {
    for (let account = 1; account <= 20; account++) {
      let pity = FRESH;
      let gap = 0;
      for (let i = 1; i <= 400; i++) {
        const draw = drawHero(SEED, account, i, pity);
        gap = draw.rarity === 'legendary' ? 0 : gap + 1;
        expect(gap).toBeLessThan(LEGENDARY_PITY);
        pity = draw.nextPity;
      }
    }
  });

  it('fires the epic guarantee exactly on the EPIC_PITY-th dry draw', () => {
    const pity: PityState = { sinceEpic: EPIC_PITY - 1, sinceLegendary: 0 };
    // Find an account whose natural roll here is below epic; the guarantee
    // must lift it to exactly epic (never legendary).
    for (let account = 1; account < 200; account++) {
      const draw = drawHero(SEED, account, 5, pity);
      if (draw.pityApplied === 'epic') {
        expect(draw.rarity).toBe('epic');
        expect(draw.nextPity.sinceEpic).toBe(0);
        return;
      }
    }
    throw new Error('no epic-pity trigger found in 200 accounts (odds make this impossible)');
  });

  it('legendary pity outranks epic pity and resets both counters', () => {
    const pity: PityState = { sinceEpic: EPIC_PITY - 1, sinceLegendary: LEGENDARY_PITY - 1 };
    for (let account = 1; account < 200; account++) {
      const draw = drawHero(SEED, account, 5, pity);
      if (draw.pityApplied === 'legendary') {
        expect(draw.rarity).toBe('legendary');
        expect(draw.nextPity).toEqual({ sinceEpic: 0, sinceLegendary: 0 });
        return;
      }
    }
    throw new Error('no legendary-pity trigger found in 200 accounts');
  });

  it('a natural epic resets the epic counter without pity applying', () => {
    for (let account = 1; account < 2000; account++) {
      const draw = drawHero(SEED, account, 9, { sinceEpic: 5, sinceLegendary: 10 });
      if (draw.rarity === 'epic' && draw.pityApplied === 'none') {
        expect(draw.nextPity.sinceEpic).toBe(0);
        expect(draw.nextPity.sinceLegendary).toBe(11);
        return;
      }
    }
    throw new Error('no natural epic found in 2000 accounts');
  });
});

describe('deriveHeroName', () => {
  it('is deterministic and letters-only, and varies by attempt', () => {
    const name = deriveHeroName(SEED, 7, 1, 0);
    expect(name).toBe(deriveHeroName(SEED, 7, 1, 0));
    expect(name).toMatch(/^[A-Za-z]{3,16}$/);
    const variants = new Set(
      Array.from({ length: 8 }, (_, attempt) => deriveHeroName(SEED, 7, 1, attempt)),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe('economy constants', () => {
  it('pins the hero box price at 25 SPIRE base units', () => {
    expect(HERO_BOX_PRICE_BASE).toBe(25_000_000_000n);
  });
});
