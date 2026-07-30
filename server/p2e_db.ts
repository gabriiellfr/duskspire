// P2E token-ledger SQL boundary (the fork's on-chain economy bridge,
// docs/p2e/PLAN.md Phase 4). Owns the DDL and every query for the server-side
// SPIRE ledger: an append-only entry log plus a per-account balance row, the
// off-chain book that deposits credit, withdrawals debit, and stake matches
// escrow against. Amounts are BIGINT base units (10^-9 SPIRE) end to end and
// cross this module as bigint/string, never number: a JS double cannot hold
// the full range.
import { pool } from './db';

export const P2E_SCHEMA = `
CREATE TABLE IF NOT EXISTS p2e_balances (
  account_id INT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Append-only financial audit trail: KEEP FOREVER, deliberately no retention
-- registration. Every token movement must stay reconstructable for reconciliation
-- against the chain (the bank_ledger posture, with real value attached).
-- account_id is SET NULL on account deletion so the audit rows outlive the account.
CREATE TABLE IF NOT EXISTS p2e_ledger (
  id BIGSERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS p2e_ledger_ref ON p2e_ledger(ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS p2e_ledger_account_created ON p2e_ledger(account_id, id DESC);
-- Small key/value state for the P2E background workers (the deposit indexer's
-- last-processed signature cursor). Bounded by its key vocabulary: keep forever.
CREATE TABLE IF NOT EXISTS p2e_indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Withdrawal queue: the request debits the ledger in the SAME transaction that
-- inserts the row (ref 'withdraw:<id>'), then the external payout worker
-- (chain/src/payout_worker.ts, the Daily Rewards private-payout pattern) sends
-- the on-chain transfer and stamps sent/tx_signature. A 'failed' row keeps its
-- debit and waits for operator action (re-run or manual re-credit by ref):
-- funds can be delayed, never duplicated. Financial audit: KEEP FOREVER,
-- deliberately no retention registration; account_id survives account deletion.
CREATE TABLE IF NOT EXISTS p2e_withdrawals (
  id BIGSERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  tx_signature TEXT,
  failure TEXT
);
CREATE INDEX IF NOT EXISTS p2e_withdrawals_status ON p2e_withdrawals(status, id);
CREATE INDEX IF NOT EXISTS p2e_withdrawals_account ON p2e_withdrawals(account_id, id DESC);
`;

export interface P2eLedgerEntry {
  id: string;
  delta: string; // signed base units, stringified BIGINT
  balanceAfter: string;
  reason: string;
  ref: string | null;
  createdAt: string; // ISO timestamp
}

export type P2eMutationOutcome =
  | { ok: true; applied: boolean; balance: bigint }
  | { ok: false; error: 'insufficient_funds' };

interface LedgerRow {
  id: string;
  delta: string;
  balance_after: string;
  reason: string;
  ref: string | null;
  created_at: Date;
}

function rowToEntry(row: LedgerRow): P2eLedgerEntry {
  return {
    id: String(row.id),
    delta: String(row.delta),
    balanceAfter: String(row.balance_after),
    reason: row.reason,
    ref: row.ref,
    createdAt: row.created_at.toISOString(),
  };
}

export async function p2eBalanceFor(accountId: number): Promise<bigint> {
  const res = await pool.query('SELECT balance FROM p2e_balances WHERE account_id = $1', [
    accountId,
  ]);
  return res.rows.length > 0 ? BigInt(res.rows[0].balance) : 0n;
}

/** Newest-first page of an account's ledger entries; fetches limit+1 to report hasMore. */
export async function p2eLedgerPage(
  accountId: number,
  offset: number,
  limit: number,
): Promise<{ entries: P2eLedgerEntry[]; hasMore: boolean }> {
  const res = await pool.query(
    `SELECT id, delta, balance_after, reason, ref, created_at
       FROM p2e_ledger WHERE account_id = $1
       ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [accountId, limit + 1, offset],
  );
  const rows = res.rows as LedgerRow[];
  return { entries: rows.slice(0, limit).map(rowToEntry), hasMore: rows.length > limit };
}

export type P2eWithdrawalOutcome =
  | { ok: true; id: string; balance: bigint }
  | { ok: false; error: 'insufficient_funds' };

// Withdrawal request: the queue row insert and the ledger debit are ONE
// transaction (same in-statement overdraft guard as p2eApplyMutation), so a
// queued withdrawal always has its debit and a refused debit leaves no row.
// The ledger ref 'withdraw:<id>' ties the debit to the queue row for
// reconciliation and makes any operator re-credit idempotent by ref.
export async function p2eRequestWithdrawal(
  accountId: number,
  amount: bigint,
  destination: string,
): Promise<P2eWithdrawalOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO p2e_withdrawals (account_id, amount, destination)
         VALUES ($1, $2, $3) RETURNING id`,
      [accountId, amount.toString(), destination],
    );
    const id = String(inserted.rows[0].id);
    const updated = await client.query(
      `UPDATE p2e_balances SET balance = balance - $2, updated_at = now()
         WHERE account_id = $1 AND balance - $2 >= 0 RETURNING balance`,
      [accountId, amount.toString()],
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'insufficient_funds' };
    }
    const balance = BigInt(updated.rows[0].balance);
    await client.query(
      `INSERT INTO p2e_ledger (account_id, delta, balance_after, reason, ref)
         VALUES ($1, $2, $3, 'withdraw_request', $4)`,
      [accountId, (-amount).toString(), balance.toString(), `withdraw:${id}`],
    );
    await client.query('COMMIT');
    return { ok: true, id, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function p2eIndexerCursor(key: string): Promise<string | null> {
  const res = await pool.query('SELECT value FROM p2e_indexer_state WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

export async function p2eSetIndexerCursor(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO p2e_indexer_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

// The one balance-mutation path: everything that moves SPIRE on the server book
// (deposit credit, withdrawal debit, stake escrow, payout, box purchase) goes
// through this transaction. Guarantees, all enforced in-statement, never
// check-then-write:
// - No overdraft: the balance UPDATE carries `balance + delta >= 0`; a debit
//   past zero updates no row and the transaction rolls back.
// - Idempotency by ref: a caller-supplied ref (a chain tx signature, a match
//   id) is UNIQUE; replaying the same mutation returns the current balance with
//   applied: false instead of double-applying. The unique index also closes the
//   race between two concurrent replays (23505 resolves to the idempotent arm).
// - Audit row per applied mutation, with the post-mutation balance snapshotted.
export async function p2eApplyMutation(
  accountId: number,
  delta: bigint,
  reason: string,
  ref: string | null,
): Promise<P2eMutationOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ref !== null) {
      const existing = await client.query('SELECT 1 FROM p2e_ledger WHERE ref = $1', [ref]);
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return { ok: true, applied: false, balance: await p2eBalanceFor(accountId) };
      }
    }
    await client.query(
      'INSERT INTO p2e_balances (account_id, balance) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING',
      [accountId],
    );
    const updated = await client.query(
      `UPDATE p2e_balances SET balance = balance + $2, updated_at = now()
         WHERE account_id = $1 AND balance + $2 >= 0 RETURNING balance`,
      [accountId, delta.toString()],
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'insufficient_funds' };
    }
    const balance = BigInt(updated.rows[0].balance);
    await client.query(
      `INSERT INTO p2e_ledger (account_id, delta, balance_after, reason, ref)
         VALUES ($1, $2, $3, $4, $5)`,
      [accountId, delta.toString(), balance.toString(), reason, ref],
    );
    await client.query('COMMIT');
    return { ok: true, applied: true, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Two replays raced past the pre-check; the unique ref index caught the
    // second. Resolve it exactly like the pre-checked replay arm.
    if (ref !== null && (err as { code?: string }).code === '23505') {
      return { ok: true, applied: false, balance: await p2eBalanceFor(accountId) };
    }
    throw err;
  } finally {
    client.release();
  }
}
