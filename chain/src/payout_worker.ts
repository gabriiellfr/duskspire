// The Duskspire payout worker: sends queued withdrawals on-chain.
//
// This is the fork's version of the Daily Rewards "private payout service"
// pattern: a process OUTSIDE the game server that talks straight to Postgres
// (the admin-utils precedent), holds the treasury signing key, and drains the
// p2e_withdrawals queue the game server fills. Keeping the signer out of the
// game-server process keeps a server compromise from being a treasury
// compromise, and lets the key live on hardened ops infrastructure later.
//
// Per row: claim it (pending -> sending, guarded so two workers cannot both
// claim), send SPIRE treasury -> destination ATA with memo dsk1:payout:<id>,
// stamp sent + tx_signature. Any failure stamps failed + the message; a failed
// row KEEPS its ledger debit and waits for an operator (re-running with
// --retry-failed re-claims failed rows; the memo/id makes accidental double
// sends visible on-chain, and the claim guard makes them not happen).
//
// DEVNET-FIRST: point DATABASE_URL at the game database and DUSKSPIRE_RPC at
// devnet. Usage:
//   npm run payouts            one drain pass
//   npm run payouts -- --watch poll forever (10s)
//   npm run payouts -- --retry-failed  also re-claim failed rows this pass
import {
  addMemo,
  createTokenIfMissing,
  findAssociatedTokenPda,
  mplToolbox,
  transferTokens,
} from '@metaplex-foundation/mpl-toolbox';
import { publicKey } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import pg from 'pg';
import { loadState, makeUmi } from './lib.js';

const WATCH = process.argv.includes('--watch');
const RETRY_FAILED = process.argv.includes('--retry-failed');
const POLL_MS = 10_000;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (the game database holding p2e_withdrawals)');
  process.exit(1);
}

const state = loadState();
if (!state.mint) {
  console.error('state/devnet.json has no mint; run the token step first');
  process.exit(1);
}
const MINT = publicKey(state.mint);

const umi = makeUmi().use(mplToolbox());
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

interface WithdrawalRow {
  id: string;
  amount: string;
  destination: string;
}

async function claimNext(): Promise<WithdrawalRow | null> {
  const statuses = RETRY_FAILED ? ['pending', 'failed'] : ['pending'];
  const res = await pool.query(
    `UPDATE p2e_withdrawals SET status = 'sending'
       WHERE id = (
         SELECT id FROM p2e_withdrawals WHERE status = ANY($1)
           ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, amount, destination`,
    [statuses],
  );
  return (res.rows[0] as WithdrawalRow | undefined) ?? null;
}

async function sendOne(row: WithdrawalRow): Promise<string> {
  const destinationOwner = publicKey(row.destination);
  const result = await transferTokens(umi, {
    source: findAssociatedTokenPda(umi, { mint: MINT, owner: umi.identity.publicKey }),
    destination: findAssociatedTokenPda(umi, { mint: MINT, owner: destinationOwner }),
    authority: umi.identity,
    amount: BigInt(row.amount),
  })
    .prepend(createTokenIfMissing(umi, { mint: MINT, owner: destinationOwner }))
    .add(addMemo(umi, { memo: `dsk1:payout:${row.id}` }))
    .sendAndConfirm(umi);
  return base58.deserialize(result.signature)[0];
}

async function drain(): Promise<number> {
  let sent = 0;
  for (;;) {
    const row = await claimNext();
    if (!row) return sent;
    try {
      const signature = await sendOne(row);
      await pool.query(
        `UPDATE p2e_withdrawals SET status = 'sent', sent_at = now(), tx_signature = $2, failure = NULL
           WHERE id = $1`,
        [row.id, signature],
      );
      console.log(`[payout] sent #${row.id}: ${row.amount} base units -> ${row.destination} (${signature})`);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE p2e_withdrawals SET status = 'failed', failure = $2 WHERE id = $1`,
        [row.id, message.slice(0, 500)],
      );
      console.error(`[payout] FAILED #${row.id}: ${message}`);
    }
  }
}

async function main(): Promise<void> {
  do {
    const sent = await drain();
    if (sent > 0 || !WATCH) console.log(`[payout] pass complete: ${sent} sent`);
    if (WATCH) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (WATCH);
  await pool.end();
}

main().catch((err) => {
  console.error('[payout] fatal:', err);
  process.exit(1);
});
