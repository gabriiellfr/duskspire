// Duskspire game-mode E2E: enter the offline city in a real browser and prove
// (1) the world IS the city (one-zone terrain grid, city zone, city spawn),
// (2) the idle pilot fights hands-free via /dev pilot on,
// (3) a screenshot for the delivery record.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { BROWSER_PATH } from './browser_path.mjs';
import { enterOfflineGame } from './enter_offline_game.mjs';

const GAME_URL = process.env.GAME_URL ?? 'http://localhost:5173';
const checks = [];
const check = (name, ok, extra = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};

mkdirSync('tmp', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: BROWSER_PATH,
  headless: 'new',
  args: ['--window-size=1600,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
await enterOfflineGame(page, { charClass: 'warrior', charName: 'Duskproof' });

const world = await page.evaluate(() => {
  const g = window.__game;
  const grid = g.renderer.terrainView.groundResidency().grid;
  const p = g.sim.player;
  return {
    grid: {
      countX: grid.countX,
      countZ: grid.countZ,
      originX: grid.originX,
      originZ: grid.originZ,
    },
    pos: { x: p.pos.x, z: p.pos.z },
    zones: g.sim.cfg.world?.zones.map((z) => z.id) ?? null,
    terrainMeshes: g.renderer.terrainView.group.children.length,
  };
});
console.log('world state:', JSON.stringify(world));
check(
  'client runs the Duskspire city world (one zone)',
  world.zones?.length === 1 && world.zones[0] === 'eastbrook_vale',
);
check(
  'terrain grid is the compact city band 4x4, not the 14-zone strip',
  world.grid.countX === 4 && world.grid.countZ === 4,
  `${world.grid.countX}x${world.grid.countZ}`,
);
check(
  'grid origin matches the city band',
  world.grid.originX === -120 && world.grid.originZ === -120,
);
check(
  'player spawned at the city start',
  Math.hypot(world.pos.x, world.pos.z) < 40,
  `(${world.pos.x.toFixed(1)}, ${world.pos.z.toFixed(1)})`,
);

// Idle pilot via the dev chat surface, exactly as a dev-mode player would:
// walk (teleport) to the wolf-run outskirts, then switch the pilot on.
await page.evaluate(() => window.__game.sim.chat('/dev tp -2 70'));
await page.evaluate(() => window.__game.sim.chat('/dev pilot on'));
const pilot = await page.evaluate(() => window.__game.sim.isIdlePilot());
check('/dev pilot on enables the idle pilot', pilot === true);

// Let it hunt: the offline loop ticks the sim; watch for a mob death + xp.
const before = await page.evaluate(() => ({ xp: window.__game.sim.xp }));
const outcome = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const g = window.__game;
      let kills = 0;
      const started = performance.now();
      const timer = setInterval(() => {
        // drainEvents is consumed by the HUD loop; watch entity state instead.
        for (const e of g.sim.entities.values()) {
          if (e.kind === 'mob' && e.dead) kills++;
        }
        const fighting = g.sim.player.autoAttack || g.sim.player.inCombat;
        if (kills > 0 || performance.now() - started > 90_000) {
          clearInterval(timer);
          resolve({ kills, fighting, xp: g.sim.xp, dead: g.sim.player.dead });
        }
      }, 1000);
    }),
);
console.log('pilot outcome:', JSON.stringify(outcome));
check('pilot engaged and killed at least one mob hands-free', outcome.kills > 0 && !outcome.dead);
check('pilot earned xp', outcome.xp > before.xp, `${before.xp} -> ${outcome.xp}`);

await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: 'tmp/duskspire-city-idle.png' });
console.log('screenshot: tmp/duskspire-city-idle.png');

await browser.close();
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} Duskspire game-mode checks passed`);
process.exit(passed === checks.length ? 0 : 1);
