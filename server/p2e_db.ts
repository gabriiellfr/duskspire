// P2E token-ledger SQL boundary (the fork's on-chain economy bridge,
// docs/p2e/PLAN.md Phase 4). Owns the DDL and every query for the server-side
// SPIRE ledger: an append-only entry log plus a per-account balance row, the
// off-chain book that deposits credit, withdrawals debit, and stake matches
// escrow against. Amounts are BIGINT base units (10^-9 SPIRE) end to end and
// cross this module as bigint/string, never number: a JS double cannot hold
// the full range.
import { pool } from './db';
import { deriveHeroName, drawHero, type HeroDraw, type PityState } from './p2e_draw_core';
import { REALM } from './realm';

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
-- Hero-box gacha (docs/p2e/economy.md section 5). p2e_heroes marks a character
-- row as a drawn hero and carries its rarity (immutable) and, once minted, its
-- on-chain identity. p2e_draws is the per-draw audit the commit-reveal seed
-- verifies against: KEEP FOREVER (players recompute their draws at reveal).
-- p2e_pity is the per-season deterministic guarantee state; the row lock on it
-- serializes an account's box opens.
CREATE TABLE IF NOT EXISTS p2e_heroes (
  character_id INT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  rarity TEXT NOT NULL,
  draw_id BIGINT,
  mint_address TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2e_heroes_account ON p2e_heroes(account_id);
-- Starter heroes (heroes.md section 4): free, never NFTs, never counted
-- against the roster cap; at most one per account (the partial unique index).
ALTER TABLE p2e_heroes ADD COLUMN IF NOT EXISTS is_starter BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS p2e_heroes_one_starter
  ON p2e_heroes(account_id) WHERE is_starter;
CREATE TABLE IF NOT EXISTS p2e_draws (
  id BIGSERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  season TEXT NOT NULL,
  draw_index INT NOT NULL,
  box TEXT NOT NULL,
  rarity TEXT NOT NULL,
  hero_class TEXT NOT NULL,
  rarity_roll INT NOT NULL,
  class_roll INT NOT NULL,
  pity_applied TEXT NOT NULL,
  character_id INT REFERENCES characters(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT p2e_draws_unique_index UNIQUE (account_id, season, draw_index)
);
CREATE TABLE IF NOT EXISTS p2e_pity (
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  season TEXT NOT NULL,
  draw_count INT NOT NULL DEFAULT 0,
  since_epic INT NOT NULL DEFAULT 0,
  since_legendary INT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, season)
);
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

export type P2eHeroBoxOutcome =
  | {
      ok: true;
      characterId: number;
      name: string;
      draw: HeroDraw;
      drawIndex: number;
      balance: bigint;
    }
  | { ok: false; error: 'insufficient_funds' | 'roster_full' | 'name_collision' };

// Open one Hero Box: ONE transaction covering the whole grant, keyed by the
// pity-row lock (FOR UPDATE serializes an account's opens, which also makes
// the draw_index allocation race-free):
//   1. lock/read pity -> drawIndex = draw_count + 1
//   2. debit the box price in-statement (no overdraft) + ledger row with the
//      deterministic ref herobox:<season>:<account>:<index>
//   3. roster-cap check, then the character INSERT (the hero IS a character
//      row; deliberately inline rather than createCharacterCapped, which owns
//      its own transaction and would break the all-or-nothing grant)
//   4. p2e_heroes + p2e_draws rows, pity update
// Any failure rolls the whole box open back: the player keeps their SPIRE and
// no partial hero exists. The name candidates are deterministic per attempt;
// ten straight UNIQUE collisions abort as name_collision (retryable).
export async function p2eOpenHeroBox(
  accountId: number,
  season: string,
  seasonSeed: string,
  priceBase: bigint,
  rosterLimit: number,
): Promise<P2eHeroBoxOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO p2e_pity (account_id, season) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [accountId, season],
    );
    const pityRow = await client.query(
      `SELECT draw_count, since_epic, since_legendary FROM p2e_pity
         WHERE account_id = $1 AND season = $2 FOR UPDATE`,
      [accountId, season],
    );
    const drawIndex = Number(pityRow.rows[0].draw_count) + 1;
    const pity: PityState = {
      sinceEpic: Number(pityRow.rows[0].since_epic),
      sinceLegendary: Number(pityRow.rows[0].since_legendary),
    };

    await client.query(
      'INSERT INTO p2e_balances (account_id, balance) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING',
      [accountId],
    );
    const debited = await client.query(
      `UPDATE p2e_balances SET balance = balance - $2, updated_at = now()
         WHERE account_id = $1 AND balance - $2 >= 0 RETURNING balance`,
      [accountId, priceBase.toString()],
    );
    if (debited.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'insufficient_funds' };
    }
    const balance = BigInt(debited.rows[0].balance);
    await client.query(
      `INSERT INTO p2e_ledger (account_id, delta, balance_after, reason, ref)
         VALUES ($1, $2, $3, 'hero_box', $4)`,
      [
        accountId,
        (-priceBase).toString(),
        balance.toString(),
        `herobox:${season}:${accountId}:${drawIndex}`,
      ],
    );

    const rosterCount = await client.query(
      `SELECT count(*)::int AS n FROM characters c
         JOIN p2e_heroes h ON h.character_id = c.id
         WHERE c.account_id = $1 AND c.realm = $2 AND NOT h.is_starter`,
      [accountId, REALM],
    );
    if (Number(rosterCount.rows[0]?.n ?? 0) >= rosterLimit) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'roster_full' };
    }

    const draw = drawHero(seasonSeed, accountId, drawIndex, pity);

    let name: string | null = null;
    for (let attempt = 0; attempt < 10 && name === null; attempt++) {
      const candidate = deriveHeroName(seasonSeed, accountId, drawIndex, attempt);
      const taken = await client.query('SELECT 1 FROM characters WHERE name = $1', [candidate]);
      if (taken.rows.length === 0) name = candidate;
    }
    if (name === null) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'name_collision' };
    }

    const character = await client.query(
      `INSERT INTO characters (account_id, name, class, realm, state)
         VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [accountId, name, draw.heroClass, REALM],
    );
    const characterId = Number(character.rows[0].id);
    const drawRow = await client.query(
      `INSERT INTO p2e_draws
         (account_id, season, draw_index, box, rarity, hero_class, rarity_roll, class_roll, pity_applied, character_id)
         VALUES ($1, $2, $3, 'hero', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        accountId,
        season,
        drawIndex,
        draw.rarity,
        draw.heroClass,
        draw.rarityRoll,
        draw.classRoll,
        draw.pityApplied,
        characterId,
      ],
    );
    await client.query(
      `INSERT INTO p2e_heroes (character_id, account_id, rarity, draw_id)
         VALUES ($1, $2, $3, $4)`,
      [characterId, accountId, draw.rarity, drawRow.rows[0].id],
    );
    await client.query(
      `UPDATE p2e_pity SET draw_count = $3, since_epic = $4, since_legendary = $5
         WHERE account_id = $1 AND season = $2`,
      [accountId, season, drawIndex, draw.nextPity.sinceEpic, draw.nextPity.sinceLegendary],
    );
    await client.query('COMMIT');
    return { ok: true, characterId, name, draw, drawIndex, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A concurrent global name claim raced the pre-check: retryable.
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, error: 'name_collision' };
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface P2eHeroView {
  characterId: number;
  name: string;
  heroClass: string;
  level: number;
  rarity: string;
  isStarter: boolean;
  mintAddress: string | null;
}

/** The account's hero roster on this realm (starter + box heroes). */
export async function p2eHeroRoster(accountId: number): Promise<P2eHeroView[]> {
  const res = await pool.query(
    `SELECT c.id, c.name, c.class, c.level, h.rarity, h.is_starter, h.mint_address
       FROM p2e_heroes h JOIN characters c ON c.id = h.character_id
       WHERE h.account_id = $1 AND c.realm = $2 ORDER BY c.id`,
    [accountId, REALM],
  );
  return res.rows.map((row) => ({
    characterId: Number(row.id),
    name: row.name,
    heroClass: row.class,
    level: Number(row.level),
    rarity: row.rarity,
    isStarter: row.is_starter === true,
    mintAddress: row.mint_address ?? null,
  }));
}

export type P2eStarterOutcome =
  | { ok: true; characterId: number }
  | { ok: false; error: 'starter_claimed' | 'name_taken' };

// The one free starter hero (heroes.md section 4): a common-rarity character
// plus a starter-marked hero row, all-or-nothing. Uniqueness is enforced
// IN-STATEMENT by the two unique indexes (one starter per account, global
// character names); the 23505 catch maps the violated constraint back to the
// caller's error, so a concurrent double-claim can never grant twice.
export async function p2eGrantStarter(
  accountId: number,
  heroClass: string,
  name: string,
): Promise<P2eStarterOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const character = await client.query(
      `INSERT INTO characters (account_id, name, class, realm, state)
         VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [accountId, name, heroClass, REALM],
    );
    const characterId = Number(character.rows[0].id);
    await client.query(
      `INSERT INTO p2e_heroes (character_id, account_id, rarity, is_starter)
         VALUES ($1, $2, 'common', TRUE)`,
      [characterId, accountId],
    );
    await client.query('COMMIT');
    return { ok: true, characterId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505') {
      return {
        ok: false,
        error: pgErr.constraint === 'p2e_heroes_one_starter' ? 'starter_claimed' : 'name_taken',
      };
    }
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
