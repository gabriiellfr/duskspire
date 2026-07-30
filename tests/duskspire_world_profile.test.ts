import { describe, expect, it } from 'vitest';
import { ONLINE_WORLD_AUTH_TYPE, onlineWorldAuthType } from '../src/world_api';

// The Duskspire world discriminator (docs/p2e/PLAN.md Phase 1 host wiring):
// hosts that serve the city world derive a shifted first-frame auth type so a
// vanilla client and a city realm (either direction) fail closed through the
// existing strict check in server/ws_auth.ts.

describe('onlineWorldAuthType', () => {
  it('is the unmodified epoch discriminator when the flag is off', () => {
    expect(onlineWorldAuthType(false)).toBe(ONLINE_WORLD_AUTH_TYPE);
  });

  it('derives a distinct city-world discriminator when the flag is on', () => {
    const dusk = onlineWorldAuthType(true);
    expect(dusk).toBe('auth-world-3-dusk1');
    expect(dusk).not.toBe(ONLINE_WORLD_AUTH_TYPE);
  });

  it('keeps the auth-world- prefix so a mismatch classifies as an incompatible layout', () => {
    // server/ws_auth.ts routes any 'auth-world-'-prefixed mismatch to the
    // incompatible-world rejection (not the missing-auth one); the suffix
    // must not break that classification.
    expect(onlineWorldAuthType(true).startsWith('auth-world-')).toBe(true);
  });
});
