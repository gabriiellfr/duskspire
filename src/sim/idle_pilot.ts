// Duskspire idle pilot (docs/p2e/PLAN.md Phase 3): the auto-combat driver that
// plays a hero while its owner idles. When enabled for a player it acquires
// the nearest living hostile mob in the overworld around it, walks to it
// (reusing the fiesta bots' cover-recovery steering), engages auto-attack,
// and presses the first sensible offensive ability on the shared bot cadence.
//
// Determinism: the pilot draws ZERO rng. Target choice is nearest-by-distance
// with the entity-id tie-break, steering is the pure BotSteer state machine,
// and ability presses stagger on tickCount % IDLE_ABILITY_PERIOD === pid, the
// exact fiesta-bot idiom, so enabling a pilot can never fork the shared draw
// order for anyone else, and a world with no pilots is byte-identical to one
// without this phase (the tick call no-ops on an empty set).
//
// State lives on `Sim` (idlePilotPids / idlePilotSteer): session-only, never
// serialized, invisible to the parity harness (the fiestaBotPids E1 pattern).
import { rangedAutoProfile } from './combat/form_swing';
import type { PlayerMeta, Sim } from './sim';
import {
  advanceBotSteer,
  BOT_DETOUR_TICKS,
  type BotSteer,
  freshBotSteer,
} from './social/fiesta_bots';
import { angleTo, dist2d, type Entity, emptyMoveInput, MELEE_RANGE, steadyAngleTo } from './types';

/** How far the pilot scans for its next victim, in world units. */
export const IDLE_PILOT_SCAN_RANGE = 45;
/** Ability-press cadence (ticks), staggered per pid like the fiesta bots. */
export const IDLE_ABILITY_PERIOD = 24;

/** Toggle the idle pilot for a player. Clears movement intent on disable. */
export function setIdlePilot(sim: Sim, pid: number, on: boolean): void {
  if (on) {
    if (sim.players.has(pid)) sim.idlePilotPids.add(pid);
    return;
  }
  sim.idlePilotPids.delete(pid);
  sim.idlePilotSteer.delete(pid);
  const meta = sim.players.get(pid);
  if (meta) meta.moveInput = emptyMoveInput();
}

/**
 * The nearest living, hostile, ownerless, non-evading mob within scan range.
 * Deterministic: distance first, then the lower entity id.
 */
export function pickIdleTarget(sim: Sim, p: Entity): Entity | null {
  let target: Entity | null = null;
  let best = IDLE_PILOT_SCAN_RANGE;
  for (const e of sim.entities.values()) {
    if (e.kind !== 'mob' || e.dead || !e.hostile) continue;
    if (e.ownerId !== null || e.aiState === 'evade') continue;
    const d = dist2d(p.pos, e.pos);
    if (d < best || (d === best && target !== null && e.id < target.id)) {
      best = d;
      target = e;
    }
  }
  return target;
}

// The pilot's go-to offensive press: the first known, castable-shaped,
// enemy-targeted active ability. castAbility itself no-ops on cooldown or
// resource shortfall, so this stays a cheap shape filter (the fiesta
// pickBotAbility idiom).
export function pickIdleAbility(meta: PlayerMeta): string | null {
  for (const k of meta.known) {
    const def = k.def;
    if (def.passive === true) continue;
    if (!def.requiresTarget) continue;
    if (def.targetType === 'friendly') continue;
    return def.id;
  }
  return null;
}

function steerState(sim: Sim, pid: number): BotSteer {
  let st = sim.idlePilotSteer.get(pid);
  if (!st) {
    st = freshBotSteer();
    sim.idlePilotSteer.set(pid, st);
  }
  return st;
}

/** Drive every enabled pilot one tick. Called from the tick head; no rng. */
export function updateIdlePilots(sim: Sim): void {
  for (const pid of sim.idlePilotPids) drivePilot(sim, pid);
}

function drivePilot(sim: Sim, pid: number): void {
  const e = sim.entities.get(pid);
  const meta = sim.players.get(pid);
  if (!e || !meta) {
    sim.idlePilotPids.delete(pid);
    sim.idlePilotSteer.delete(pid);
    return;
  }
  meta.moveInput = emptyMoveInput();
  // A dead or casting pilot holds still (updateCasting owns the cast; movement
  // would cancel it). Ghosts stay parked: releasing/corpse-running is an owner
  // decision, not the pilot's.
  if (e.dead || e.castingAbility) {
    sim.idlePilotSteer.delete(pid);
    return;
  }

  const current = e.targetId !== null ? sim.entities.get(e.targetId) : null;
  const engaged =
    current && !current.dead && current.kind === 'mob' && current.hostile ? current : null;
  const target = engaged ?? pickIdleTarget(sim, e);
  if (!target) return;
  e.targetId = target.id;

  const d = dist2d(e.pos, target.pos);
  e.facing = steadyAngleTo(e.pos, target.pos, e.facing);
  const engageRange = rangedAutoProfile(e, meta.cls) ? 22 : MELEE_RANGE * 0.9;
  if (d > engageRange || !sim.ctx.hasLineOfSight(e, target)) {
    meta.moveInput.forward = true;
    e.facing = advanceBotSteer(
      steerState(sim, pid),
      e.pos.x,
      e.pos.z,
      angleTo(e.pos, target.pos),
      BOT_DETOUR_TICKS * 6,
    );
    return;
  }

  if (!e.autoAttack) sim.startAutoAttack(pid);
  if (sim.tickCount % IDLE_ABILITY_PERIOD === pid % IDLE_ABILITY_PERIOD) {
    const ability = pickIdleAbility(meta);
    if (ability) sim.castAbility(ability, pid);
  }
}
