import { describe, expect, it } from 'vitest';
import { pickIdleAbility, pickIdleTarget } from '../src/sim/idle_pilot';
import { Sim } from '../src/sim/sim';
import { terrainHeight } from '../src/sim/world';

// The Duskspire idle pilot (docs/p2e/PLAN.md Phase 3): drives a hero
// hands-free: acquire the nearest hostile, close in, auto-attack, press
// abilities on the bot cadence. Zero rng of its own, so a world with no
// pilots must stay byte-identical.

const SEED = 4242;

function makeSim(): Sim {
  return new Sim({ seed: SEED, playerClass: 'warrior', autoEquip: true });
}

function teleport(sim: Sim, x: number, z: number): void {
  const p = sim.player;
  p.pos.x = x;
  p.pos.z = z;
  p.pos.y = terrainHeight(x, z, sim.cfg.seed);
  p.prevPos = { ...p.pos };
}

// The wolf run north of Eastbrook: reliable early camp with several mobs.
const WOLF_RUN = { x: -2, z: 70 };

describe('idle pilot', () => {
  it('kills nearby mobs and earns xp with zero player input', () => {
    const sim = makeSim();
    teleport(sim, WOLF_RUN.x, WOLF_RUN.z);
    sim.setIdlePilot(true);
    const startXp = sim.xp;
    let kills = 0;
    for (let i = 0; i < 20 * 120 && kills < 2; i++) {
      for (const ev of sim.tick()) {
        if (ev.type === 'death' && ev.entityId !== sim.playerId) kills++;
      }
      if (sim.player.dead) break;
    }
    expect(sim.player.dead).toBe(false);
    expect(kills).toBeGreaterThanOrEqual(2);
    expect(sim.xp).toBeGreaterThan(startXp);
  });

  it('is deterministic: two identical piloted runs produce identical worlds', () => {
    const run = (): string => {
      const sim = makeSim();
      teleport(sim, WOLF_RUN.x, WOLF_RUN.z);
      sim.setIdlePilot(true);
      const events: unknown[] = [];
      for (let i = 0; i < 20 * 30; i++) events.push(...sim.tick());
      const p = sim.player;
      return JSON.stringify({
        events,
        pos: [p.pos.x.toFixed(5), p.pos.z.toFixed(5)],
        hp: p.hp,
        xp: sim.xp,
      });
    };
    expect(run()).toBe(run());
  });

  it('a disabled pilot is inert: the world matches a never-enabled run byte for byte', () => {
    const run = (togglePilot: boolean): string => {
      const sim = makeSim();
      teleport(sim, WOLF_RUN.x, WOLF_RUN.z);
      if (togglePilot) {
        // Enable then immediately disable BEFORE any tick: the phase must
        // no-op identically to a world where the pilot never existed.
        sim.setIdlePilot(true);
        sim.setIdlePilot(false);
      }
      const events: unknown[] = [];
      for (let i = 0; i < 20 * 20; i++) events.push(...sim.tick());
      return JSON.stringify(events);
    };
    expect(run(true)).toBe(run(false));
  });

  it('stops moving and clears steering on disable', () => {
    const sim = makeSim();
    teleport(sim, WOLF_RUN.x, WOLF_RUN.z);
    sim.setIdlePilot(true);
    for (let i = 0; i < 20; i++) sim.tick();
    sim.setIdlePilot(false);
    expect(sim.isIdlePilot()).toBe(false);
    expect(sim.moveInput.forward).toBe(false);
    expect((sim as unknown as { idlePilotSteer: Map<number, unknown> }).idlePilotSteer.size).toBe(
      0,
    );
  });

  it('removePlayer tears the pilot down', () => {
    const sim = new Sim({ seed: SEED, playerClass: 'warrior', noPlayer: true });
    const pid = sim.addPlayer('warrior', 'Pilot');
    sim.setIdlePilot(true, pid);
    expect(sim.isIdlePilot(pid)).toBe(true);
    sim.removePlayer(pid);
    expect(sim.isIdlePilot(pid)).toBe(false);
  });

  it('pickIdleTarget prefers the nearest living hostile and ignores corpses', () => {
    const sim = makeSim();
    teleport(sim, WOLF_RUN.x, WOLF_RUN.z);
    const target = pickIdleTarget(sim, sim.player);
    expect(target).not.toBeNull();
    if (!target) return;
    expect(target.kind).toBe('mob');
    expect(target.hostile).toBe(true);
    // No other living hostile mob in scan range is strictly closer.
    const d = Math.hypot(target.pos.x - sim.player.pos.x, target.pos.z - sim.player.pos.z);
    for (const e of sim.entities.values()) {
      if (e.kind !== 'mob' || e.dead || !e.hostile || e.ownerId !== null) continue;
      const other = Math.hypot(e.pos.x - sim.player.pos.x, e.pos.z - sim.player.pos.z);
      expect(other).toBeGreaterThanOrEqual(d - 1e-9);
    }
  });

  it('pickIdleAbility returns an active, enemy-targeted ability', () => {
    const sim = makeSim();
    const meta = sim.meta(sim.playerId);
    expect(meta).not.toBeNull();
    if (!meta) return;
    const ability = pickIdleAbility(meta);
    expect(ability).not.toBeNull();
    const def = meta.known.find((k) => k.def.id === ability)?.def;
    expect(def?.passive).not.toBe(true);
    expect(def?.requiresTarget).toBe(true);
  });
});
