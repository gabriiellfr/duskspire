// Fork (Duskspire): the SERVER-side game-mode switch. Duskspire city mode is
// the fork's DEFAULT so a realm cannot silently boot the original world when
// an env file is missing. Resolution order:
//   1. DUSKSPIRE_WORLD explicitly '1' or '0' always wins,
//   2. under vitest/NODE_ENV=test the default is OFF (upstream suites pin
//      vanilla),
//   3. otherwise ON.
// The client twin is src/net/duskspire_mode.ts; both feed onlineWorldAuthType
// so a mismatched pairing fails closed as an incompatible world layout.
export function duskspireWorldEnabled(): boolean {
  const raw = process.env.DUSKSPIRE_WORLD;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return process.env.VITEST === undefined && process.env.NODE_ENV !== 'test';
}
