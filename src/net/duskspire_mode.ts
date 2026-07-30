// Fork (Duskspire): the CLIENT-side game-mode switch. Duskspire city mode is
// the fork's DEFAULT: it must not depend on anyone remembering an env flag at
// dev-server start (a stale terminal or IDE task would silently boot the
// original world). Resolution order:
//   1. VITE_DUSKSPIRE_WORLD explicitly '1' or '0' always wins,
//   2. under vitest the default is OFF (the upstream suites pin vanilla),
//   3. otherwise ON.
// The server twin is server/duskspire_mode.ts; both feed onlineWorldAuthType
// so a mismatched client/server pairing still fails closed.
const raw = import.meta.env?.VITE_DUSKSPIRE_WORLD as string | undefined;

export const DUSKSPIRE_WORLD_CLIENT: boolean =
  raw === '1' || (raw !== '0' && !import.meta.env?.VITEST);
