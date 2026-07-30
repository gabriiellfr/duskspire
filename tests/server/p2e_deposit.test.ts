process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5433/wocc_new_endpoint_scaffold';

import { describe, expect, it } from 'vitest';
import { DEPOSIT_MEMO_PREFIX, parseDepositTransaction } from '../../server/p2e_deposit_core';
import {
  DEPOSIT_REASON,
  type DepositIndexerDeps,
  runDepositScan,
} from '../../server/p2e_deposit_indexer';

const TREASURY_ATA = 'TreasuryAta1111111111111111111111111111111';
const MINT = 'Mint11111111111111111111111111111111111111';
const SENDER = 'SenderWallet111111111111111111111111111111';

// One jsonParsed deposit transaction as the RPC returns it (the shape the
// chain workspace's deposit flow produces: transferChecked + spl-memo).
function depositTx(
  overrides: {
    err?: unknown;
    memo?: string | null;
    destination?: string;
    mint?: string;
    amount?: string;
    type?: 'transfer' | 'transferChecked';
    authority?: string;
  } = {},
) {
  const {
    err = null,
    memo = `${DEPOSIT_MEMO_PREFIX}JBVzPhtk:1785419589739`,
    destination = TREASURY_ATA,
    mint = MINT,
    amount = '100000000000',
    type = 'transferChecked',
    authority = SENDER,
  } = overrides;
  const info: Record<string, unknown> = {
    destination,
    authority,
    ...(type === 'transferChecked' ? { mint, tokenAmount: { amount, decimals: 9 } } : { amount }),
  };
  return {
    meta: { err },
    transaction: {
      message: {
        instructions: [
          { program: 'spl-token', parsed: { type, info } },
          ...(memo === null ? [] : [{ program: 'spl-memo', parsed: memo }]),
        ],
      },
    },
  };
}

describe('parseDepositTransaction (pure core)', () => {
  it('parses a valid transferChecked deposit with memo', () => {
    expect(parseDepositTransaction(depositTx(), TREASURY_ATA, MINT)).toEqual({
      senderWallet: SENDER,
      amountBase: 100_000_000_000n,
      memo: `${DEPOSIT_MEMO_PREFIX}JBVzPhtk:1785419589739`,
    });
  });

  it('parses the plain transfer form (amount on info directly)', () => {
    const tx = depositTx({ type: 'transfer', amount: '42' });
    expect(parseDepositTransaction(tx, TREASURY_ATA, MINT)?.amountBase).toBe(42n);
  });

  it.each([
    ['failed transaction', depositTx({ err: { InstructionError: [0, 'Custom'] } })],
    ['missing memo', depositTx({ memo: null })],
    ['foreign memo prefix', depositTx({ memo: 'gm:hello' })],
    ['wrong destination', depositTx({ destination: 'SomeOtherAta11111111111111111111111111111' })],
    [
      'wrong mint on transferChecked',
      depositTx({ mint: 'WrongMint111111111111111111111111111111111' }),
    ],
    ['zero amount', depositTx({ amount: '0' })],
    ['non-numeric amount', depositTx({ amount: '12.5' })],
  ])('rejects: %s', (_name, tx) => {
    expect(parseDepositTransaction(tx, TREASURY_ATA, MINT)).toBeNull();
  });

  it('rejects garbage shapes without throwing', () => {
    for (const junk of [null, undefined, 42, 'tx', {}, { meta: {} }, { meta: { err: null } }]) {
      expect(parseDepositTransaction(junk, TREASURY_ATA, MINT)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Scan loop with fake deps.
// ---------------------------------------------------------------------------

interface FakeChainTx {
  signature: string;
  err?: unknown;
  tx: unknown;
}

function makeDeps(chain: FakeChainTx[], linked: Record<string, number>) {
  const credits: { accountId: number; amount: bigint; reason: string; ref: string }[] = [];
  const refs = new Set<string>();
  let cursor: string | null = null;
  const deps: DepositIndexerDeps = {
    rpc: async (method, params) => {
      if (method === 'getSignaturesForAddress') {
        const opts = params[1] as { until?: string };
        // Newest-first, stopping at (excluding) `until`, like the real RPC.
        const newestFirst = [...chain].reverse();
        const upto = opts.until ? newestFirst.findIndex((e) => e.signature === opts.until) : -1;
        return (upto >= 0 ? newestFirst.slice(0, upto) : newestFirst).map((e) => ({
          signature: e.signature,
          err: e.err ?? null,
        }));
      }
      if (method === 'getTransaction') {
        return chain.find((e) => e.signature === params[0])?.tx ?? null;
      }
      throw new Error(`unexpected rpc method ${method}`);
    },
    accountForWallet: async (pubkey) => linked[pubkey] ?? null,
    credit: async (accountId, amount, reason, ref) => {
      if (refs.has(ref)) return { ok: true };
      refs.add(ref);
      credits.push({ accountId, amount, reason, ref });
      return { ok: true };
    },
    getCursor: async () => cursor,
    setCursor: async (signature) => {
      cursor = signature;
    },
  };
  return { deps, credits, cursorOf: () => cursor };
}

const CFG = { treasuryAta: TREASURY_ATA, mint: MINT };

describe('runDepositScan', () => {
  it('credits deposits oldest-first with the signature as the idempotency ref', async () => {
    const { deps, credits, cursorOf } = makeDeps(
      [
        { signature: 'sigA', tx: depositTx({ amount: '100' }) },
        { signature: 'sigB', tx: depositTx({ amount: '200' }) },
      ],
      { [SENDER]: 7 },
    );
    const outcome = await runDepositScan(deps, CFG);
    expect(outcome).toMatchObject({ scanned: 2, credited: 2, skippedUnlinked: 0 });
    expect(credits).toEqual([
      { accountId: 7, amount: 100n, reason: DEPOSIT_REASON, ref: 'sigA' },
      { accountId: 7, amount: 200n, reason: DEPOSIT_REASON, ref: 'sigB' },
    ]);
    expect(cursorOf()).toBe('sigB');
  });

  it('a rescan after cursor loss re-credits nothing (ledger idempotency)', async () => {
    const chain: FakeChainTx[] = [{ signature: 'sigA', tx: depositTx({ amount: '100' }) }];
    const { deps, credits } = makeDeps(chain, { [SENDER]: 7 });
    await runDepositScan(deps, CFG);
    // Simulate cursor loss: force a full rescan of the same chain.
    await deps.setCursor(undefined as unknown as string);
    const second = await runDepositScan(deps, CFG);
    expect(second.scanned).toBeGreaterThan(0);
    expect(credits.length).toBe(1);
  });

  it('skips foreign transactions and failed signatures, still advancing the cursor', async () => {
    const { deps, credits, cursorOf } = makeDeps(
      [
        { signature: 'sigFail', err: { some: 'err' }, tx: null },
        { signature: 'sigForeign', tx: depositTx({ memo: null }) },
        { signature: 'sigGood', tx: depositTx({ amount: '5' }) },
      ],
      { [SENDER]: 7 },
    );
    const outcome = await runDepositScan(deps, CFG);
    expect(outcome).toMatchObject({ scanned: 3, credited: 1, skippedForeign: 1 });
    expect(credits.map((c) => c.ref)).toEqual(['sigGood']);
    expect(cursorOf()).toBe('sigGood');
  });

  it('holds an unlinked-wallet deposit for retry: cursor stays behind it', async () => {
    const { deps, credits, cursorOf } = makeDeps(
      [
        { signature: 'sigOld', tx: depositTx({ amount: '1' }) },
        {
          signature: 'sigUnlinked',
          tx: depositTx({ authority: 'Unlinked11111111111111111111111111111111111' }),
        },
      ],
      { [SENDER]: 7 },
    );
    const outcome = await runDepositScan(deps, CFG);
    expect(outcome).toMatchObject({ credited: 1, skippedUnlinked: 1 });
    expect(cursorOf()).toBe('sigOld');
    // The wallet links later; the next scan retries from the held signature.
    const { deps: deps2, credits: credits2 } = makeDeps(
      [
        {
          signature: 'sigUnlinked',
          tx: depositTx({ authority: 'Unlinked11111111111111111111111111111111111' }),
        },
      ],
      { Unlinked11111111111111111111111111111111111: 9 },
    );
    await runDepositScan(deps2, CFG);
    expect(credits2).toEqual([
      { accountId: 9, amount: 100_000_000_000n, reason: DEPOSIT_REASON, ref: 'sigUnlinked' },
    ]);
    void credits;
  });

  it('passes the stored cursor as `until` so processed work is not relisted', async () => {
    const chain: FakeChainTx[] = [
      { signature: 'sigA', tx: depositTx({ amount: '1' }) },
      { signature: 'sigB', tx: depositTx({ amount: '2' }) },
    ];
    const { deps, credits } = makeDeps(chain, { [SENDER]: 7 });
    await runDepositScan(deps, CFG);
    chain.push({ signature: 'sigC', tx: depositTx({ amount: '3' }) });
    const second = await runDepositScan(deps, CFG);
    expect(second).toMatchObject({ scanned: 1, credited: 1 });
    expect(credits.map((c) => c.ref)).toEqual(['sigA', 'sigB', 'sigC']);
  });

  it('does nothing on an empty page', async () => {
    const { deps, cursorOf } = makeDeps([], {});
    expect(await runDepositScan(deps, CFG)).toEqual({
      scanned: 0,
      credited: 0,
      skippedUnlinked: 0,
      skippedForeign: 0,
    });
    expect(cursorOf()).toBeNull();
  });
});
