// P2E token-ledger API surface and service seam (docs/p2e/PLAN.md Phase 4).
//
// The service functions (creditP2e / debitP2e) are the ONE doorway every later
// caller uses to move SPIRE on the server book: the deposit indexer credits
// confirmed on-chain deposits, the withdrawal pipeline debits before paying
// out, stake matches escrow entry fees, box purchases spend. Each mutation is
// idempotent by ref (a chain signature, a match id) and can never overdraw;
// both guarantees live in the SQL transaction (p2e_db.ts), not in caller
// discipline. The REST surface is read-only: balance and ledger history.
import { offensiveName, validCharName } from './auth';
import { accountAndScopeForToken, moderationStatusForAccount, walletForAccount } from './db';
import { HttpError } from './http/errors';
import {
  type BearerActiveGuardDb,
  createActiveGuard,
  createReadGuard,
} from './http/middleware/bearer_active_guard';
import { withBody } from './http/middleware/body';
import { type Infer, num, object, optional, str } from './http/schema';
import type { Ctx, RouteDef } from './http/types';
import { json } from './http_util';
import {
  type P2eHeroBoxOutcome,
  type P2eHeroView,
  type P2eLedgerEntry,
  type P2eMutationOutcome,
  type P2eStarterOutcome,
  type P2eWithdrawalOutcome,
  p2eApplyMutation,
  p2eBalanceFor,
  p2eGrantStarter,
  p2eHeroRoster,
  p2eLedgerPage,
  p2eOpenHeroBox,
  p2eRequestWithdrawal,
} from './p2e_db';
import {
  EPIC_PITY,
  HERO_BOX_PRICE_BASE,
  LEGENDARY_PITY,
  RARITY_ODDS_BP,
  seasonSeedHash,
  starterRotation,
} from './p2e_draw_core';

// The db seam: the bearer guard reads plus the ledger reads/mutation. The
// production default is the real p2e_db.ts SQL; tests swap in a fake.
export interface P2eDb extends BearerActiveGuardDb {
  balanceFor(accountId: number): Promise<bigint>;
  ledgerPage(
    accountId: number,
    offset: number,
    limit: number,
  ): Promise<{ entries: P2eLedgerEntry[]; hasMore: boolean }>;
  applyMutation(
    accountId: number,
    delta: bigint,
    reason: string,
    ref: string | null,
  ): Promise<P2eMutationOutcome>;
  requestWithdrawal(
    accountId: number,
    amount: bigint,
    destination: string,
  ): Promise<P2eWithdrawalOutcome>;
  /** The account's linked wallet pubkey, or null when none is linked. */
  linkedWallet(accountId: number): Promise<string | null>;
  openHeroBox(
    accountId: number,
    season: string,
    seasonSeed: string,
    priceBase: bigint,
    rosterLimit: number,
  ): Promise<P2eHeroBoxOutcome>;
  heroRoster(accountId: number): Promise<P2eHeroView[]>;
  grantStarter(accountId: number, heroClass: string, name: string): Promise<P2eStarterOutcome>;
}

const REAL_P2E_DB: P2eDb = {
  accountAndScopeForToken,
  moderationStatusForAccount,
  balanceFor: p2eBalanceFor,
  ledgerPage: p2eLedgerPage,
  applyMutation: p2eApplyMutation,
  requestWithdrawal: p2eRequestWithdrawal,
  linkedWallet: async (accountId) => (await walletForAccount(accountId))?.pubkey ?? null,
  openHeroBox: p2eOpenHeroBox,
  heroRoster: p2eHeroRoster,
  grantStarter: p2eGrantStarter,
};
let p2eDb: P2eDb = REAL_P2E_DB;

/** Override the db seam with a fake (test-only; merges over the real reads). */
export function setP2eDbForTests(overrides: Partial<P2eDb>): void {
  p2eDb = { ...REAL_P2E_DB, ...overrides };
}

/** Restore the real db seam after an override (test-only). */
export function resetP2eDbForTests(): void {
  p2eDb = REAL_P2E_DB;
}

// ---------------------------------------------------------------------------
// Service seam (used by the deposit indexer, withdrawals, stakes, purchases).
// ---------------------------------------------------------------------------

function assertPositiveAmount(amount: bigint): void {
  if (amount <= 0n) throw new Error(`p2e amount must be positive, got ${amount}`);
}

/** Credit SPIRE base units to an account's ledger. Idempotent by ref. */
export async function creditP2e(
  accountId: number,
  amount: bigint,
  reason: string,
  ref: string | null,
): Promise<P2eMutationOutcome> {
  assertPositiveAmount(amount);
  return p2eDb.applyMutation(accountId, amount, reason, ref);
}

/**
 * Debit SPIRE base units. Idempotent by ref; throws the stable
 * p2e.insufficient_funds HttpError (409) when the balance cannot cover it, so
 * a future spend route surfaces the code with no extra mapping.
 */
export async function debitP2e(
  accountId: number,
  amount: bigint,
  reason: string,
  ref: string | null,
): Promise<P2eMutationOutcome> {
  assertPositiveAmount(amount);
  const outcome = await p2eDb.applyMutation(accountId, -amount, reason, ref);
  if (!outcome.ok) throw new HttpError(409, 'p2e.insufficient_funds');
  return outcome;
}

// ---------------------------------------------------------------------------
// REST surface (read-only).
// ---------------------------------------------------------------------------

// Shared bearer guard (moderation-gated + scope-enforced): accepts a read OR full token.
const authGuard = createReadGuard(() => p2eDb);

function accountIdOf(ctx: Ctx): number {
  const account = ctx.account;
  if (!account) throw new HttpError(401, 'auth.token_missing');
  return account.accountId;
}

/** GET /api/p2e/balance: the caller's SPIRE ledger balance in base units. */
async function balanceHandler(ctx: Ctx): Promise<void> {
  const balance = await p2eDb.balanceFor(accountIdOf(ctx));
  // BIGINT base units as a string: a JS double cannot hold the full range.
  json(ctx.res, 200, { balance: balance.toString() });
}

export const p2eLedgerQuerySchema = object({
  page: optional(num({ int: true, min: 0, max: 1_000_000 }), 0),
  pageSize: optional(num({ int: true, min: 1, max: 50 }), 20),
});
export type P2eLedgerQuery = Infer<typeof p2eLedgerQuerySchema>;

/** GET /api/p2e/ledger: newest-first page of the caller's ledger entries. */
async function ledgerHandler(ctx: Ctx): Promise<void> {
  const decoded = p2eLedgerQuerySchema.decode(ctx.query);
  // A schema-shape failure maps to 422 validation.failed through the pipeline.
  if (!decoded.ok) throw decoded;
  const { page, pageSize } = decoded.value;
  const { entries, hasMore } = await p2eDb.ledgerPage(accountIdOf(ctx), page * pageSize, pageSize);
  json(ctx.res, 200, { entries, page, pageSize, hasMore });
}

// Withdrawals need a FULL-scope session (a read token must never move funds).
const fullAuthGuard = createActiveGuard(() => p2eDb);

// Minimum withdrawal in base units (economy.md section 7): default 10 SPIRE.
export function withdrawMinBase(): bigint {
  const raw = (process.env.P2E_WITHDRAW_MIN_BASE ?? '').trim();
  return /^\d+$/.test(raw) && BigInt(raw) > 0n ? BigInt(raw) : 10_000_000_000n;
}

export const p2eWithdrawBodySchema = object({
  // Base units as a decimal string (a JSON number cannot hold the range).
  amount: str({ maxLength: 24 }),
});
export type P2eWithdrawBody = Infer<typeof p2eWithdrawBodySchema>;

/**
 * POST /api/p2e/withdraw: debit the ledger and queue an on-chain payout to the
 * caller's LINKED wallet (never a caller-supplied destination: a session
 * hijack must not be able to redirect funds). The payout worker sends it.
 */
async function withdrawHandler(ctx: Ctx): Promise<void> {
  const decoded = p2eWithdrawBodySchema.decode(ctx.body);
  if (!decoded.ok) throw decoded;
  const raw = decoded.value.amount.trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new HttpError(400, 'p2e.invalid_input');
  }
  const amount = BigInt(raw);
  if (amount < withdrawMinBase()) throw new HttpError(400, 'p2e.below_minimum');
  const accountId = accountIdOf(ctx);
  const destination = await p2eDb.linkedWallet(accountId);
  if (destination === null) throw new HttpError(409, 'p2e.wallet_not_linked');
  const outcome = await p2eDb.requestWithdrawal(accountId, amount, destination);
  if (!outcome.ok) throw new HttpError(409, 'p2e.insufficient_funds');
  json(ctx.res, 200, {
    id: outcome.id,
    balance: outcome.balance.toString(),
    destination,
    status: 'pending',
  });
}

// ---------------------------------------------------------------------------
// Hero boxes (docs/p2e/economy.md section 5).
// ---------------------------------------------------------------------------

/** The season identity and seed for the commit-reveal draws. */
export function seasonConfig(): { season: string; seed: string } {
  return {
    season: (process.env.P2E_SEASON ?? 'dev0').trim(),
    // The dev fallback is deliberately labeled unsafe: production sets a
    // strong secret and reveals it at season end.
    seed: (process.env.P2E_SEASON_SEED ?? 'dev-season-seed-unsafe').trim(),
  };
}

export const HERO_ROSTER_LIMIT = 20; // docs/p2e/heroes.md section 3

/**
 * GET /api/p2e/season: the public transparency read: season id, the seed
 * commitment (sha256), the published odds, pity thresholds, and the box
 * price. This is the loot-box odds disclosure surface.
 */
function seasonHandler(ctx: Ctx): void {
  const { season, seed } = seasonConfig();
  json(ctx.res, 200, {
    season,
    seedHash: seasonSeedHash(seed),
    oddsBp: RARITY_ODDS_BP,
    epicPity: EPIC_PITY,
    legendaryPity: LEGENDARY_PITY,
    heroBoxPrice: HERO_BOX_PRICE_BASE.toString(),
  });
}

/**
 * POST /api/p2e/boxes/hero/open: debit the box price and grant a drawn hero
 * (a new character row carrying its rarity). Full-scope sessions only.
 */
async function openHeroBoxHandler(ctx: Ctx): Promise<void> {
  const { season, seed } = seasonConfig();
  const outcome = await p2eDb.openHeroBox(
    accountIdOf(ctx),
    season,
    seed,
    HERO_BOX_PRICE_BASE,
    HERO_ROSTER_LIMIT,
  );
  if (!outcome.ok) {
    if (outcome.error === 'insufficient_funds') throw new HttpError(409, 'p2e.insufficient_funds');
    if (outcome.error === 'roster_full') throw new HttpError(409, 'p2e.roster_full');
    throw new HttpError(409, 'p2e.try_again');
  }
  json(ctx.res, 200, {
    characterId: outcome.characterId,
    name: outcome.name,
    rarity: outcome.draw.rarity,
    heroClass: outcome.draw.heroClass,
    drawIndex: outcome.drawIndex,
    pityApplied: outcome.draw.pityApplied,
    // The verifiable rolls, so a player can recompute at season reveal.
    rarityRoll: outcome.draw.rarityRoll,
    classRoll: outcome.draw.classRoll,
    balance: outcome.balance.toString(),
  });
}

/** GET /api/p2e/heroes: the caller's hero roster (starter + box heroes). */
async function heroesHandler(ctx: Ctx): Promise<void> {
  const heroes = await p2eDb.heroRoster(accountIdOf(ctx));
  const { season } = seasonConfig();
  json(ctx.res, 200, {
    heroes,
    rosterLimit: HERO_ROSTER_LIMIT,
    starterRotation: starterRotation(season),
  });
}

export const p2eStarterBodySchema = object({
  heroClass: str({ maxLength: 16 }),
  name: str({ maxLength: 16 }),
});
export type P2eStarterBody = Infer<typeof p2eStarterBodySchema>;

/**
 * POST /api/p2e/starter: claim the one free starter hero (heroes.md section
 * 4): player-named, class from the season's rotation of 3, common rarity,
 * never an NFT, never counted against the roster cap. One per account,
 * enforced in-statement.
 */
async function starterHandler(ctx: Ctx): Promise<void> {
  const decoded = p2eStarterBodySchema.decode(ctx.body);
  if (!decoded.ok) throw decoded;
  const { heroClass, name } = decoded.value;
  const { season } = seasonConfig();
  if (!starterRotation(season).includes(heroClass as never)) {
    throw new HttpError(400, 'p2e.invalid_input');
  }
  if (!validCharName(name) || offensiveName(name)) {
    throw new HttpError(400, 'p2e.invalid_input');
  }
  const outcome = await p2eDb.grantStarter(accountIdOf(ctx), heroClass, name);
  if (!outcome.ok) {
    if (outcome.error === 'starter_claimed') throw new HttpError(409, 'p2e.starter_claimed');
    throw new HttpError(409, 'character.name_taken');
  }
  json(ctx.res, 200, { characterId: outcome.characterId, name, heroClass, rarity: 'common' });
}

export const routes: RouteDef[] = [
  {
    method: 'GET',
    path: '/api/p2e/balance',
    surface: 'api',
    middleware: [authGuard],
    handler: balanceHandler,
  },
  {
    method: 'GET',
    path: '/api/p2e/ledger',
    surface: 'api',
    middleware: [authGuard],
    handler: ledgerHandler,
  },
  {
    method: 'POST',
    path: '/api/p2e/withdraw',
    surface: 'api',
    middleware: [fullAuthGuard, withBody()],
    handler: withdrawHandler,
  },
  {
    method: 'GET',
    path: '/api/p2e/season',
    surface: 'api',
    handler: seasonHandler,
  },
  {
    method: 'POST',
    path: '/api/p2e/boxes/hero/open',
    surface: 'api',
    middleware: [fullAuthGuard, withBody()],
    handler: openHeroBoxHandler,
  },
  {
    method: 'GET',
    path: '/api/p2e/heroes',
    surface: 'api',
    middleware: [authGuard],
    handler: heroesHandler,
  },
  {
    method: 'POST',
    path: '/api/p2e/starter',
    surface: 'api',
    middleware: [fullAuthGuard, withBody()],
    handler: starterHandler,
  },
];
