// P2E token-ledger API surface and service seam (docs/p2e/PLAN.md Phase 4).
//
// The service functions (creditP2e / debitP2e) are the ONE doorway every later
// caller uses to move SPIRE on the server book: the deposit indexer credits
// confirmed on-chain deposits, the withdrawal pipeline debits before paying
// out, stake matches escrow entry fees, box purchases spend. Each mutation is
// idempotent by ref (a chain signature, a match id) and can never overdraw;
// both guarantees live in the SQL transaction (p2e_db.ts), not in caller
// discipline. The REST surface is read-only: balance and ledger history.
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
  type P2eLedgerEntry,
  type P2eMutationOutcome,
  type P2eWithdrawalOutcome,
  p2eApplyMutation,
  p2eBalanceFor,
  p2eLedgerPage,
  p2eRequestWithdrawal,
} from './p2e_db';

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
}

const REAL_P2E_DB: P2eDb = {
  accountAndScopeForToken,
  moderationStatusForAccount,
  balanceFor: p2eBalanceFor,
  ledgerPage: p2eLedgerPage,
  applyMutation: p2eApplyMutation,
  requestWithdrawal: p2eRequestWithdrawal,
  linkedWallet: async (accountId) => (await walletForAccount(accountId))?.pubkey ?? null,
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
];
