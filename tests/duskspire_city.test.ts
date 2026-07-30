import { afterEach, describe, expect, it } from 'vitest';
import { CITY_BAND, DUSKSPIRE_CITY, DUSKSPIRE_CITY_ZONE } from '../src/sim/content/duskspire_city';
import { ZONE1_ZONE } from '../src/sim/content/zone1';
import { setActiveWorldContent } from '../src/sim/data';
import { Sim } from '../src/sim/sim';

// The Duskspire city world (docs/p2e/PLAN.md Phase 1): ONE compact fenced
// city band (town + walled outskirts holding the starter camps and the
// Hollow Crypt door), nothing beyond it. These tests pin the band geometry,
// the content filters, and a deterministic 1000-tick run through the same
// injection seam the editor play-test uses.

const SEED = 20061;

function citySim(): Sim {
  setActiveWorldContent(DUSKSPIRE_CITY);
  return new Sim({
    seed: SEED,
    playerClass: 'warrior',
    playerName: 'Rehearser',
    world: DUSKSPIRE_CITY,
  });
}

afterEach(() => {
  setActiveWorldContent(null);
});

describe('DUSKSPIRE_CITY definition', () => {
  it('is one compact square band, far smaller than the original vale', () => {
    expect(DUSKSPIRE_CITY.zones).toEqual([DUSKSPIRE_CITY_ZONE]);
    expect(DUSKSPIRE_CITY_ZONE.xMin).toBe(-CITY_BAND);
    expect(DUSKSPIRE_CITY_ZONE.xMax).toBe(CITY_BAND);
    expect(DUSKSPIRE_CITY_ZONE.zMin).toBe(-CITY_BAND);
    expect(DUSKSPIRE_CITY_ZONE.zMax).toBe(CITY_BAND);
    // The band is a strict subset of the original vale.
    expect(2 * CITY_BAND).toBeLessThan(ZONE1_ZONE.zMax - ZONE1_ZONE.zMin);
    expect(DUSKSPIRE_CITY_ZONE.id).toBe(ZONE1_ZONE.id);
  });

  it('keeps every camp fully inside the band (spawn circle included)', () => {
    expect(DUSKSPIRE_CITY.camps.length).toBeGreaterThan(8);
    for (const camp of DUSKSPIRE_CITY.camps) {
      expect(Math.abs(camp.center.x) + camp.radius).toBeLessThanOrEqual(CITY_BAND);
      expect(Math.abs(camp.center.z) + camp.radius).toBeLessThanOrEqual(CITY_BAND);
    }
    // The Hollow Crypt chapel guards stay: the dungeon door lives in-band.
    expect(DUSKSPIRE_CITY.camps.some((c) => c.mobId === 'restless_bones')).toBe(true);
    expect(DUSKSPIRE_CITY.camps.at(-1)?.mobId).toBe('grix_the_tunnelking');
  });

  it('fences the band edge with four blocker walls', () => {
    expect(DUSKSPIRE_CITY.blockers?.length).toBe(4);
    for (const wall of DUSKSPIRE_CITY.blockers ?? []) {
      for (const v of [wall.x1, wall.z1, wall.x2, wall.z2]) {
        expect(Math.abs(v)).toBeLessThanOrEqual(CITY_BAND);
        expect(Math.abs(v)).toBeGreaterThanOrEqual(CITY_BAND - 4);
      }
    }
  });

  it('carries the town services, all inside the band', () => {
    const services = DUSKSPIRE_CITY.services;
    expect(services?.stations?.length).toBeGreaterThan(0);
    expect(services?.mailboxes?.length).toBeGreaterThan(0);
    expect(services?.noticeboards?.length).toBe(1);
    expect(services?.graveyards?.length).toBeGreaterThan(0);
    for (const list of [services?.mailboxes ?? [], services?.graveyards ?? []]) {
      for (const anchor of list) {
        expect(Math.abs(anchor.x)).toBeLessThanOrEqual(CITY_BAND);
        expect(Math.abs(anchor.z)).toBeLessThanOrEqual(CITY_BAND);
      }
    }
  });

  it('keeps only in-band npcs, objects, roads, pois', () => {
    for (const npc of Object.values(DUSKSPIRE_CITY.npcs)) {
      expect(Math.abs(npc.pos.x)).toBeLessThanOrEqual(CITY_BAND);
      expect(Math.abs(npc.pos.z)).toBeLessThanOrEqual(CITY_BAND);
    }
    for (const obj of DUSKSPIRE_CITY.groundObjects) {
      expect(obj.positions.length).toBeGreaterThan(0);
      for (const p of obj.positions) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(CITY_BAND);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(CITY_BAND);
      }
    }
    for (const road of DUSKSPIRE_CITY.roads) {
      for (const p of road) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(CITY_BAND);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(CITY_BAND);
      }
    }
  });
});

describe('the sim runs the compact city world', () => {
  it('boots with the town population, everything inside the band', () => {
    const sim = citySim();
    const entities = [...sim.entities.values()];
    const npcs = entities.filter((e) => e.kind === 'npc');
    const mobs = entities.filter((e) => e.kind === 'mob');
    expect(npcs.length).toBeGreaterThan(10);
    expect(mobs.length).toBeGreaterThan(20);
    // Overworld entities stay inside the band; instanced system content
    // (arena slots, temple bands at z 1000+) is exempt by design.
    const OVERWORLD_LIMIT = 600;
    for (const e of entities) {
      if (e.kind !== 'mob' && e.kind !== 'npc') continue;
      if (Math.abs(e.pos.z) >= OVERWORLD_LIMIT || Math.abs(e.pos.x) >= OVERWORLD_LIMIT) continue;
      expect(Math.abs(e.pos.x)).toBeLessThanOrEqual(CITY_BAND);
      expect(Math.abs(e.pos.z)).toBeLessThanOrEqual(CITY_BAND);
    }
    expect(sim.player.pos.x).toBeCloseTo(DUSKSPIRE_CITY.playerStart.x, 0);
    expect(sim.player.pos.z).toBeCloseTo(DUSKSPIRE_CITY.playerStart.z, 0);
  });

  it('the fence blocks walking past the band edge', () => {
    const sim = citySim();
    const p = sim.player;
    // Stand just inside the north fence and push north for five seconds.
    p.pos.x = 0;
    p.pos.z = CITY_BAND - 4;
    p.prevPos = { ...p.pos };
    p.facing = 0; // sim facing 0 walks +z (north)
    sim.moveInput.forward = true;
    for (let i = 0; i < 20 * 5; i++) sim.tick();
    expect(p.pos.z).toBeLessThan(CITY_BAND);
  });

  it('ticks 1000 times deterministically (same seed, same stream and state)', () => {
    const run = (): string => {
      const sim = citySim();
      const events: unknown[] = [];
      for (let i = 0; i < 1000; i++) events.push(...sim.tick());
      const mobSnapshot = [...sim.entities.values()]
        .filter((e) => e.kind === 'mob')
        .map((e) => [e.id, e.pos.x.toFixed(4), e.pos.z.toFixed(4), e.hp]);
      return JSON.stringify({ events, mobSnapshot, time: sim.time });
    };
    expect(run()).toBe(run());
  });
});
