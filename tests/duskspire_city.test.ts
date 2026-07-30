import { afterEach, describe, expect, it } from 'vitest';
import { DUSKSPIRE_CITY } from '../src/sim/content/duskspire_city';
import { ZONE1_CAMPS, ZONE1_CHAPEL_CAMPS, ZONE1_NPCS, ZONE1_ZONE } from '../src/sim/content/zone1';
import { setActiveWorldContent } from '../src/sim/data';
import { Sim } from '../src/sim/sim';

// The Duskspire city world (docs/p2e/PLAN.md Phase 1): one zone, the Eastbrook
// hub as the social city, instanced content beyond it. These tests pin the
// world definition's shape and prove the sim runs it deterministically through
// the same injection seam the editor's play-test uses.

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
  it('is a single-zone world anchored on the Eastbrook hub', () => {
    expect(DUSKSPIRE_CITY.zones).toEqual([ZONE1_ZONE]);
    expect(DUSKSPIRE_CITY.playerStart.x).toBeDefined();
  });

  it('keeps the zone 1 camp order contract (zone camps, chapel camps, the Tunnelking)', () => {
    expect(DUSKSPIRE_CITY.camps.length).toBe(ZONE1_CAMPS.length + ZONE1_CHAPEL_CAMPS.length + 1);
    expect(DUSKSPIRE_CITY.camps.slice(0, ZONE1_CAMPS.length)).toEqual(ZONE1_CAMPS);
    expect(DUSKSPIRE_CITY.camps.at(-1)?.mobId).toBe('grix_the_tunnelking');
  });

  it('carries the town services (stations, mailboxes, the noticeboard, a graveyard)', () => {
    const services = DUSKSPIRE_CITY.services;
    expect(services).toBeDefined();
    expect(services?.stations?.length).toBeGreaterThan(0);
    for (const station of services?.stations ?? []) {
      expect(station.zoneId).toBe(ZONE1_ZONE.id);
    }
    expect(services?.mailboxes?.length).toBeGreaterThan(0);
    expect(services?.noticeboards?.length).toBe(1);
    expect(services?.graveyards?.length).toBeGreaterThan(0);
    for (const list of [services?.mailboxes ?? [], services?.graveyards ?? []]) {
      for (const anchor of list) {
        expect(anchor.z).toBeGreaterThanOrEqual(ZONE1_ZONE.zMin);
        expect(anchor.z).toBeLessThan(ZONE1_ZONE.zMax);
      }
    }
  });
});

describe('the sim runs the city world', () => {
  it('boots with the town population and only vale-band entities', () => {
    const sim = citySim();
    const entities = [...sim.entities.values()];
    const npcs = entities.filter((e) => e.kind === 'npc');
    const mobs = entities.filter((e) => e.kind === 'mob');
    // The whole zone 1 NPC roster spawns (vendors, questgivers, services).
    expect(npcs.length).toBeGreaterThanOrEqual(Object.keys(ZONE1_NPCS).length);
    expect(mobs.length).toBeGreaterThan(20);
    // Overworld entities stay inside the one zone band. Instanced system
    // content (arena slots, the temple, delve chambers) lives at far z bands
    // (1000+) independent of WorldContent, so it is exempt; anything between
    // the band edge and the instance bands would be a real leak and fails.
    const OVERWORLD_LIMIT = 600;
    for (const e of entities) {
      if (e.kind !== 'mob' && e.kind !== 'npc') continue;
      if (Math.abs(e.pos.z) >= OVERWORLD_LIMIT) continue;
      expect(e.pos.z).toBeGreaterThanOrEqual(ZONE1_ZONE.zMin);
      expect(e.pos.z).toBeLessThan(ZONE1_ZONE.zMax);
    }
    // The player stands at the city start.
    expect(sim.player.pos.x).toBeCloseTo(DUSKSPIRE_CITY.playerStart.x, 0);
    expect(sim.player.pos.z).toBeCloseTo(DUSKSPIRE_CITY.playerStart.z, 0);
  });

  it('ticks 1000 times deterministically (same seed, same event stream and state)', () => {
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
