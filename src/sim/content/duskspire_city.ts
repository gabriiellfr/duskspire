// The Duskspire city world (docs/p2e/PLAN.md Phase 1): the fork's launch map.
// ONE compact city band and nothing beyond it: the Eastbrook town square is
// the social hub (vendors, bank, mail, market, stations, the noticeboard),
// the walled outskirts inside the band carry the starter camps and the Hollow
// Crypt door at the chapel ruin (80, 90), and the band edge is fenced with
// invisible blocker walls, so the rest of the original overworld neither
// renders nor exists for play. The terrain chunk grid derives from this
// zone's rect (render/terrain.ts), so the band IS the rendered world:
// 240x240 = 16 chunks versus the original strip's 792 cells.
//
// Data-as-code, assembled by FILTERING the zone 1 content the base game
// ships to the band (nothing redefined, so upstream fixes flow in). Injected
// like an editor map: SimConfig.world plus setActiveWorldContent.
//
// Camp ORDER is a determinism contract (the Sim draws the shared Rng in
// array order): the band filter preserves the built-in relative order
// (zone 1 camps, chapel camps, the Tunnelking). Append only, never reorder.
import { EASTBROOK_LAYOUT } from '../eastbrook_layout';
import type { BlockerDef, CampDef, NpcDef, WorldContent, ZoneDef } from '../types';
import { OVERWORLD_GRAVEYARDS } from './graveyards';
import { MAILBOXES } from './mailboxes';
import { NOTICEBOARDS } from './noticeboards';
import { STATIONS } from './professions';
import {
  ZONE1_CAMPS,
  ZONE1_CHAPEL_CAMPS,
  ZONE1_NPCS,
  ZONE1_OBJECTS,
  ZONE1_PROPS,
  ZONE1_ROADS,
  ZONE1_ZONE,
} from './zone1';

/** Half-width of the square city band, in world units. */
export const CITY_BAND = 120;
// The fence sits just inside the last rendered chunk row, so a player always
// stands on visible ground when they hit it.
const FENCE = CITY_BAND - 2;

const inBand = (x: number, z: number, margin = 0): boolean =>
  Math.abs(x) <= CITY_BAND - margin && Math.abs(z) <= CITY_BAND - margin;

export const DUSKSPIRE_CITY_ZONE: ZoneDef = {
  ...ZONE1_ZONE,
  xMin: -CITY_BAND,
  xMax: CITY_BAND,
  zMin: -CITY_BAND,
  zMax: CITY_BAND,
  pois: ZONE1_ZONE.pois.filter((p) => inBand(p.x, p.z)),
  lakes: ZONE1_ZONE.lakes.filter((l) => inBand(l.x, l.z)),
};

// The Tunnelking rare (declared inline in the built-in CAMPS table): its dig
// sits inside the band, so the city keeps it, in its built-in order slot.
const GRIX_CAMP: CampDef = {
  mobId: 'grix_the_tunnelking',
  center: { x: -95, z: -78 },
  radius: 4,
  count: 1,
};

// A camp stays only when its whole spawn circle fits inside the band, so no
// mob ever spawns past the fence on unrendered ground.
const campInBand = (c: CampDef): boolean => inBand(c.center.x, c.center.z, c.radius);

const NPCS_IN_BAND: Record<string, NpcDef> = Object.fromEntries(
  Object.entries(ZONE1_NPCS).filter(([, npc]) => inBand(npc.pos.x, npc.pos.z)),
);

// The invisible edge fence: four blocker walls just inside the band edge.
const FENCE_BLOCKERS: BlockerDef[] = [
  { x1: -FENCE, z1: -FENCE, x2: FENCE, z2: -FENCE }, // south
  { x1: -FENCE, z1: FENCE, x2: FENCE, z2: FENCE }, // north
  { x1: -FENCE, z1: -FENCE, x2: -FENCE, z2: FENCE }, // west
  { x1: FENCE, z1: -FENCE, x2: FENCE, z2: FENCE }, // east
];

export const DUSKSPIRE_CITY: WorldContent = {
  zones: [DUSKSPIRE_CITY_ZONE],
  camps: [...ZONE1_CAMPS, ...ZONE1_CHAPEL_CAMPS, GRIX_CAMP].filter(campInBand),
  npcs: NPCS_IN_BAND,
  groundObjects: ZONE1_OBJECTS.map((o) => ({
    ...o,
    positions: o.positions.filter((p) => inBand(p.x, p.z)),
  })).filter((o) => o.positions.length > 0),
  roads: ZONE1_ROADS.filter((road) => road.every((p) => inBand(p.x, p.z))),
  props: ZONE1_PROPS,
  playerStart: { ...EASTBROOK_LAYOUT.services.playerStart.position },
  services: {
    stations: STATIONS.filter((s) => s.zoneId === ZONE1_ZONE.id),
    mailboxes: MAILBOXES.filter((m) => inBand(m.x, m.z)),
    noticeboards: NOTICEBOARDS.filter((n) => inBand(n.x, n.z)),
    graveyards: OVERWORLD_GRAVEYARDS.filter((g) => inBand(g.x, g.z)),
  },
  blockers: FENCE_BLOCKERS,
};
