// The Duskspire city world (docs/p2e/PLAN.md Phase 1): the fork's launch map.
// One zone, no overworld beyond it: the Eastbrook town square is the social
// hub (vendors, bank, mail, market, stations, the noticeboard), and the vale
// around it is the practice outskirts whose camps give new players their
// first combat loop; everything deeper (dungeons, delves, the arena) is
// instanced content reached from here.
//
// Data-as-code, assembled from the zone 1 content the base game already ships
// (nothing is redefined, so upstream zone 1 fixes flow into the city for
// free). Injected the same way the editor injects a custom map: pass it as
// SimConfig.world AND call setActiveWorldContent with it (the sim reads
// spawns from config, terrain/render read the data.ts registry; see the
// WorldContent doc comment in types.ts).
//
// Camp ORDER is a determinism contract (the Sim draws the shared Rng in array
// order): zone 1 camps, chapel camps, then the Tunnelking, mirroring their
// relative order in the built-in CAMPS table. Append only.
import { EASTBROOK_LAYOUT } from '../eastbrook_layout';
import type { CampDef, WorldContent } from '../types';
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

const inZoneBand = (pos: { z: number }): boolean =>
  pos.z >= ZONE1_ZONE.zMin && pos.z < ZONE1_ZONE.zMax;

// The Tunnelking rare: defined inline in the built-in CAMPS table (data.ts),
// not in a zone module, so the city re-declares it verbatim. Position is
// inside the vale band.
const GRIX_CAMP: CampDef = {
  mobId: 'grix_the_tunnelking',
  center: { x: -95, z: -78 },
  radius: 4,
  count: 1,
};

export const DUSKSPIRE_CITY: WorldContent = {
  zones: [ZONE1_ZONE],
  camps: [...ZONE1_CAMPS, ...ZONE1_CHAPEL_CAMPS, GRIX_CAMP],
  npcs: ZONE1_NPCS,
  groundObjects: ZONE1_OBJECTS,
  roads: ZONE1_ROADS,
  props: ZONE1_PROPS,
  playerStart: { ...EASTBROOK_LAYOUT.services.playerStart.position },
  services: {
    stations: STATIONS.filter((s) => s.zoneId === ZONE1_ZONE.id),
    mailboxes: MAILBOXES.filter(inZoneBand),
    noticeboards: NOTICEBOARDS.filter(inZoneBand),
    graveyards: OVERWORLD_GRAVEYARDS.filter(inZoneBand),
  },
};
