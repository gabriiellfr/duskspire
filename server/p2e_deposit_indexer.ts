// The P2E deposit indexer: the background worker that turns confirmed on-chain
// SPIRE deposits into server-ledger credits (docs/p2e/PLAN.md Phase 5).
//
// Shape: a pure-ish scan function behind an injected deps bag (unit-tested
// with fakes, the ws_auth/moderation_service pattern), plus a thin env-gated
// self-clocked loop main.ts starts after listen. Dark by default: without
// P2E_DEPOSITS_ENABLED=1 and a configured treasury token account it never
// runs, so the upstream game is unaffected.
//
// Correctness model:
// - The LEDGER is the idempotency authority: every credit uses the transaction
//   signature as its ref, so rescans, cursor loss, and overlapping processes
//   are all safe (a replay applies nothing). The cursor is purely a work bound.
// - Signatures are listed with `until` = the stored cursor (newest-first),
//   then processed OLDEST-first so the cursor only ever advances past work
//   that has been attempted.
// - Only `finalized` transactions are read: a deposit is real value, so the
//   indexer never credits from a slot that could still be rolled back.
// - A deposit from an UNLINKED wallet is skipped and retried on later scans
//   within the rescan window (the cursor still advances; the player support
//   path is a manual re-credit by signature, which idempotency makes safe).
import { accountForWallet } from './db';
import { logger } from './http/logger';
import { creditP2e } from './p2e';
import { p2eIndexerCursor, p2eSetIndexerCursor } from './p2e_db';
import { parseDepositTransaction } from './p2e_deposit_core';

export const DEPOSIT_CURSOR_KEY = 'deposit_cursor';
export const DEPOSIT_REASON = 'deposit';
const SIGNATURE_PAGE_LIMIT = 200;

interface SignatureEntry {
  signature: string;
  err: unknown;
}

export interface DepositIndexerDeps {
  /** Raw JSON-RPC call; returns the `result` field. */
  rpc(method: string, params: unknown[]): Promise<unknown>;
  accountForWallet(pubkey: string): Promise<number | null>;
  credit(
    accountId: number,
    amountBase: bigint,
    reason: string,
    ref: string,
  ): Promise<{ ok: boolean }>;
  getCursor(): Promise<string | null>;
  setCursor(signature: string): Promise<void>;
}

export interface DepositIndexerConfig {
  treasuryAta: string;
  mint: string;
  /** Pause between per-transaction RPC reads (devnet public RPCs 429 hard). */
  interTxDelayMs?: number;
}

export interface DepositScanResult {
  scanned: number;
  credited: number;
  skippedUnlinked: number;
  skippedForeign: number;
  /** 1 when the scan halted on a listed-but-unfetchable transaction. */
  haltedMissingTx: number;
}

/** One scan pass: list new signatures since the cursor, credit every deposit. */
export async function runDepositScan(
  deps: DepositIndexerDeps,
  cfg: DepositIndexerConfig,
): Promise<DepositScanResult> {
  const result: DepositScanResult = {
    scanned: 0,
    credited: 0,
    skippedUnlinked: 0,
    skippedForeign: 0,
    haltedMissingTx: 0,
  };
  const cursor = await deps.getCursor();
  const listed = await deps.rpc('getSignaturesForAddress', [
    cfg.treasuryAta,
    {
      limit: SIGNATURE_PAGE_LIMIT,
      commitment: 'finalized',
      ...(cursor ? { until: cursor } : {}),
    },
  ]);
  if (!Array.isArray(listed) || listed.length === 0) return result;

  // Newest-first from the RPC; process oldest-first so the cursor never jumps
  // past unattempted work.
  const entries = (listed as SignatureEntry[])
    .filter((e) => typeof e?.signature === 'string')
    .reverse();

  for (const entry of entries) {
    result.scanned++;
    if (entry.err !== null && entry.err !== undefined) {
      await deps.setCursor(entry.signature);
      continue;
    }
    if (cfg.interTxDelayMs && cfg.interTxDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, cfg.interTxDelayMs));
    }
    const tx = await deps.rpc('getTransaction', [
      entry.signature,
      {
        encoding: 'jsonParsed',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (tx === null || tx === undefined) {
      // Listed but not fetchable (finalization lag, a node behind the one that
      // listed it). Classifying it foreign would advance the cursor PAST a
      // possibly real deposit forever (live-rehearsal finding); halt instead
      // and retry the whole tail next pass.
      result.haltedMissingTx = 1;
      break;
    }
    const deposit = parseDepositTransaction(tx, cfg.treasuryAta, cfg.mint);
    if (deposit === null) {
      result.skippedForeign++;
      await deps.setCursor(entry.signature);
      continue;
    }
    const accountId = await deps.accountForWallet(deposit.senderWallet);
    if (accountId === null) {
      // Unlinked sender: leave the cursor BEHIND this signature so later scans
      // retry it (the player may link their wallet), bounded by the page limit.
      result.skippedUnlinked++;
      logger.warn(
        { signature: entry.signature, wallet: deposit.senderWallet },
        'p2e deposit from unlinked wallet held for retry',
      );
      continue;
    }
    await deps.credit(accountId, deposit.amountBase, DEPOSIT_REASON, entry.signature);
    result.credited++;
    await deps.setCursor(entry.signature);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Production wiring (env-gated loop).
// ---------------------------------------------------------------------------

const RPC_URL = (process.env.SOLANA_RPC_URL ?? process.env.VITE_SOLANA_RPC_URL ?? '').trim();

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`p2e deposit rpc ${method} failed: HTTP ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (data.error) throw new Error(`p2e deposit rpc ${method} failed: ${data.error.message}`);
  return data.result;
}

const REAL_DEPS: DepositIndexerDeps = {
  rpc: rpcCall,
  accountForWallet,
  credit: (accountId, amountBase, reason, ref) => creditP2e(accountId, amountBase, reason, ref),
  getCursor: () => p2eIndexerCursor(DEPOSIT_CURSOR_KEY),
  setCursor: (signature) => p2eSetIndexerCursor(DEPOSIT_CURSOR_KEY, signature),
};

/**
 * Start the self-clocked deposit poll loop. Returns a stop function. No-ops
 * (and says why, once) unless P2E_DEPOSITS_ENABLED=1, the treasury token
 * account and mint are configured, and an RPC URL is set.
 */
export function startDepositIndexer(): () => void {
  if (process.env.P2E_DEPOSITS_ENABLED !== '1') return () => {};
  const treasuryAta = (process.env.P2E_TREASURY_ATA ?? '').trim();
  const mint = (process.env.P2E_SPIRE_MINT ?? '').trim();
  if (!treasuryAta || !mint || !RPC_URL) {
    logger.warn(
      'P2E_DEPOSITS_ENABLED=1 but P2E_TREASURY_ATA, P2E_SPIRE_MINT, or SOLANA_RPC_URL is unset; deposit indexer stays off',
    );
    return () => {};
  }
  const intervalMs = Math.max(5_000, Number(process.env.P2E_DEPOSIT_POLL_MS) || 30_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    try {
      const outcome = await runDepositScan(REAL_DEPS, {
        treasuryAta,
        mint,
        interTxDelayMs: 250,
      });
      if (outcome.credited > 0 || outcome.skippedUnlinked > 0) {
        logger.info({ ...outcome }, 'p2e deposit scan');
      }
    } catch (err) {
      logger.error({ err }, 'p2e deposit scan failed');
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  logger.info({ treasuryAta, intervalMs }, 'p2e deposit indexer started');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
