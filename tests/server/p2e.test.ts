process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5433/wocc_new_endpoint_scaffold';

import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../server/http/compose';
import {
  creditP2e,
  debitP2e,
  resetP2eDbForTests,
  routes,
  setP2eDbForTests,
} from '../../server/p2e';
import type { P2eLedgerEntry, P2eMutationOutcome, P2eWithdrawalOutcome } from '../../server/p2e_db';
import { fakeCtx } from './helpers';

interface FakeResShape {
  statusCode: number;
  body: string;
}

function captured(res: http.ServerResponse): { status: number; body: unknown } {
  const fake = res as unknown as FakeResShape;
  return { status: fake.statusCode, body: fake.body ? JSON.parse(fake.body) : undefined };
}

// Full AccountModerationStatus fixtures for the guard's moderation gate.
function okStatus() {
  return {
    locked: false,
    banned: false,
    suspendedUntil: null,
    reason: '',
    message: '',
    chatMutedUntil: null,
    chatStrikes: 0,
  };
}
function bannedStatus() {
  return {
    locked: true,
    banned: true,
    suspendedUntil: null,
    reason: 'banned',
    message: 'This account has been banned.',
    chatMutedUntil: null,
    chatStrikes: 0,
  };
}

const VALID_BEARER = `Bearer ${'a'.repeat(64)}`;

// In-memory fake of the ledger contract: idempotency by ref, no overdraft,
// append-only entries, newest-first pages. Mirrors p2e_db.ts semantics.
class FakeLedger {
  balances = new Map<number, bigint>();
  entries: (P2eLedgerEntry & { accountId: number })[] = [];
  refs = new Set<string>();
  withdrawals: { id: string; accountId: number; amount: bigint; destination: string }[] = [];
  wallets = new Map<number, string>();

  linkedWallet = async (accountId: number): Promise<string | null> =>
    this.wallets.get(accountId) ?? null;

  requestWithdrawal = async (
    accountId: number,
    amount: bigint,
    destination: string,
  ): Promise<P2eWithdrawalOutcome> => {
    const balance = this.balances.get(accountId) ?? 0n;
    if (balance - amount < 0n) return { ok: false, error: 'insufficient_funds' };
    this.balances.set(accountId, balance - amount);
    const id = String(this.withdrawals.length + 1);
    this.withdrawals.push({ id, accountId, amount, destination });
    return { ok: true, id, balance: balance - amount };
  };

  balanceFor = async (accountId: number): Promise<bigint> => this.balances.get(accountId) ?? 0n;

  ledgerPage = async (accountId: number, offset: number, limit: number) => {
    const mine = this.entries.filter((e) => e.accountId === accountId).reverse();
    return {
      entries: mine.slice(offset, offset + limit),
      hasMore: mine.length > offset + limit,
    };
  };

  applyMutation = async (
    accountId: number,
    delta: bigint,
    reason: string,
    ref: string | null,
  ): Promise<P2eMutationOutcome> => {
    if (ref !== null && this.refs.has(ref)) {
      return { ok: true, applied: false, balance: await this.balanceFor(accountId) };
    }
    const next = (this.balances.get(accountId) ?? 0n) + delta;
    if (next < 0n) return { ok: false, error: 'insufficient_funds' };
    this.balances.set(accountId, next);
    if (ref !== null) this.refs.add(ref);
    this.entries.push({
      accountId,
      id: String(this.entries.length + 1),
      delta: delta.toString(),
      balanceAfter: next.toString(),
      reason,
      ref,
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    return { ok: true, applied: true, balance: next };
  };
}

function installFake(ledger: FakeLedger): void {
  setP2eDbForTests({
    accountAndScopeForToken: async () => ({ accountId: 1, scope: 'full' }),
    moderationStatusForAccount: async () => okStatus(),
    balanceFor: ledger.balanceFor,
    ledgerPage: ledger.ledgerPage,
    applyMutation: ledger.applyMutation,
    requestWithdrawal: ledger.requestWithdrawal,
    linkedWallet: ledger.linkedWallet,
  });
}

function runRoute(path: string, ctx: Parameters<(typeof routes)[0]['handler']>[0]): Promise<void> {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error(`no route for ${path}`);
  return compose([...(route.middleware ?? [])])(ctx, async () => {
    await route.handler(ctx);
  });
}

afterEach(() => resetP2eDbForTests());

describe('p2e ledger service', () => {
  it('credits then debits, tracking the balance in base units', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    await creditP2e(1, 500n, 'deposit', 'sig1');
    const outcome = await debitP2e(1, 200n, 'stake_entry', 'match1');
    expect(outcome).toEqual({ ok: true, applied: true, balance: 300n });
  });

  it('is idempotent by ref: a replayed credit applies once', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    await creditP2e(1, 500n, 'deposit', 'sig1');
    const replay = await creditP2e(1, 500n, 'deposit', 'sig1');
    expect(replay).toEqual({ ok: true, applied: false, balance: 500n });
    expect(ledger.entries.length).toBe(1);
  });

  it('throws the stable insufficient_funds HttpError on overdraft', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    await creditP2e(1, 100n, 'deposit', 'sig1');
    const overdraft = debitP2e(1, 200n, 'stake_entry', 'match1');
    await expect(overdraft).rejects.toMatchObject({
      name: 'HttpError',
      status: 409,
      code: 'p2e.insufficient_funds',
    });
    expect(await ledger.balanceFor(1)).toBe(100n);
  });

  it('rejects non-positive amounts on both service arms', async () => {
    installFake(new FakeLedger());
    await expect(creditP2e(1, 0n, 'deposit', null)).rejects.toThrow(/positive/);
    await expect(debitP2e(1, -5n, 'spend', null)).rejects.toThrow(/positive/);
  });
});

describe('GET /api/p2e/balance', () => {
  it('serves the balance as a base-unit string', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    await creditP2e(1, 123_000_000_000n, 'deposit', 'sig1');
    const ctx = fakeCtx({
      method: 'GET',
      url: '/api/p2e/balance',
      headers: { authorization: VALID_BEARER },
      query: {},
    });
    await runRoute('/api/p2e/balance', ctx);
    expect(captured(ctx.res)).toEqual({ status: 200, body: { balance: '123000000000' } });
  });

  it('401s without a bearer token', async () => {
    installFake(new FakeLedger());
    const ctx = fakeCtx({ method: 'GET', url: '/api/p2e/balance', query: {} });
    await runRoute('/api/p2e/balance', ctx);
    expect(captured(ctx.res).status).toBe(401);
  });

  it('403s a banned account (moderation gate)', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    setP2eDbForTests({
      accountAndScopeForToken: async () => ({ accountId: 1, scope: 'full' }),
      moderationStatusForAccount: async () => bannedStatus(),
      balanceFor: ledger.balanceFor,
      ledgerPage: ledger.ledgerPage,
      applyMutation: ledger.applyMutation,
    });
    const ctx = fakeCtx({
      method: 'GET',
      url: '/api/p2e/balance',
      headers: { authorization: VALID_BEARER },
      query: {},
    });
    await runRoute('/api/p2e/balance', ctx);
    expect(captured(ctx.res).status).toBe(403);
  });
});

describe('GET /api/p2e/ledger', () => {
  it('pages newest-first with hasMore', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    for (let i = 1; i <= 5; i++) await creditP2e(1, BigInt(i), 'deposit', `sig${i}`);
    const ctx = fakeCtx({
      method: 'GET',
      url: '/api/p2e/ledger',
      headers: { authorization: VALID_BEARER },
      query: { page: '0', pageSize: '2' },
    });
    await runRoute('/api/p2e/ledger', ctx);
    const { status, body } = captured(ctx.res);
    expect(status).toBe(200);
    const page = body as {
      entries: P2eLedgerEntry[];
      page: number;
      pageSize: number;
      hasMore: boolean;
    };
    expect(page.page).toBe(0);
    expect(page.pageSize).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.entries.map((e) => e.delta)).toEqual(['5', '4']);
    expect(page.entries[0]).toMatchObject({ reason: 'deposit', ref: 'sig5', balanceAfter: '15' });
  });

  it('rejects an out-of-bounds pageSize through the schema (422 path)', async () => {
    installFake(new FakeLedger());
    const ctx = fakeCtx({
      method: 'GET',
      url: '/api/p2e/ledger',
      headers: { authorization: VALID_BEARER },
      query: { pageSize: '500' },
    });
    // The thrown decode result maps to 422 validation.failed in the pipeline;
    // at this harness level it surfaces as a rejection, never a 200.
    await expect(runRoute('/api/p2e/ledger', ctx)).rejects.toBeTruthy();
  });

  it('never serves another account: the page is scoped to the bearer account', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    await creditP2e(1, 100n, 'deposit', 'sig1');
    await creditP2e(2, 999n, 'deposit', 'sig2');
    const ctx = fakeCtx({
      method: 'GET',
      url: '/api/p2e/ledger',
      headers: { authorization: VALID_BEARER },
      query: {},
    });
    await runRoute('/api/p2e/ledger', ctx);
    const page = captured(ctx.res).body as { entries: P2eLedgerEntry[] };
    expect(page.entries.map((e) => e.delta)).toEqual(['100']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/p2e/withdraw handler arms (middleware bypassed; ctx.account
// preset, the steam_routes.test.ts pattern).
// ---------------------------------------------------------------------------

describe('POST /api/p2e/withdraw', () => {
  const handler = () => {
    const route = routes.find((r) => r.path === '/api/p2e/withdraw');
    if (!route) throw new Error('withdraw route missing');
    return route.handler;
  };
  const ACCOUNT = { accountId: 1, scope: 'full' as const };
  const WALLET = 'PlayerWallet11111111111111111111111111111';

  function withdrawCtx(body: unknown) {
    return fakeCtx({ method: 'POST', url: '/api/p2e/withdraw', account: ACCOUNT, body });
  }

  it('debits and queues a payout to the LINKED wallet only', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    ledger.wallets.set(1, WALLET);
    await creditP2e(1, 50_000_000_000n, 'deposit', 'sig1');
    const ctx = withdrawCtx({ amount: '20000000000' });
    await handler()(ctx);
    expect(captured(ctx.res)).toEqual({
      status: 200,
      body: { id: '1', balance: '30000000000', destination: WALLET, status: 'pending' },
    });
    expect(ledger.withdrawals).toEqual([
      { id: '1', accountId: 1, amount: 20_000_000_000n, destination: WALLET },
    ]);
  });

  it('409s with wallet_not_linked when no wallet is linked', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    await creditP2e(1, 50_000_000_000n, 'deposit', 'sig1');
    await expect(handler()(withdrawCtx({ amount: '20000000000' }))).rejects.toMatchObject({
      status: 409,
      code: 'p2e.wallet_not_linked',
    });
    expect(ledger.withdrawals).toEqual([]);
  });

  it('409s with insufficient_funds past the balance, leaving no queue row', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    ledger.wallets.set(1, WALLET);
    await creditP2e(1, 10_000_000_000n, 'deposit', 'sig1');
    await expect(handler()(withdrawCtx({ amount: '20000000000' }))).rejects.toMatchObject({
      status: 409,
      code: 'p2e.insufficient_funds',
    });
    expect(ledger.withdrawals).toEqual([]);
    expect(await ledger.balanceFor(1)).toBe(10_000_000_000n);
  });

  it('400s below the minimum withdrawal', async () => {
    const ledger = new FakeLedger();
    installFake(ledger);
    ledger.wallets.set(1, WALLET);
    await creditP2e(1, 50_000_000_000n, 'deposit', 'sig1');
    await expect(handler()(withdrawCtx({ amount: '1' }))).rejects.toMatchObject({
      status: 400,
      code: 'p2e.below_minimum',
    });
  });

  it.each([['-5'], ['1.5'], ['abc'], ['0'], ['']])('400s a malformed amount %j', async (amount) => {
    const ledger = new FakeLedger();
    installFake(ledger);
    ledger.wallets.set(1, WALLET);
    await expect(handler()(withdrawCtx({ amount }))).rejects.toMatchObject({
      code: 'p2e.invalid_input',
    });
  });
});
