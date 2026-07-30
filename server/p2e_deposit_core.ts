// PURE deposit-transaction parser for the P2E deposit indexer (no IO, no pg,
// unit-tested directly). Given one jsonParsed Solana transaction, decide
// whether it is a valid SPIRE deposit into the treasury token account and
// extract the sender wallet, the base-unit amount, and the reference memo.
//
// The wire shape it consumes is what the chain workspace's deposit flow emits
// (chain/src/e2e.ts): one SPL transfer (or transferChecked) whose destination
// is the treasury's associated token account, plus an spl-memo instruction
// carrying a `dsk1:deposit:` reference. Anything else parses to null: a failed
// transaction, a transfer to any other account, a wrong-mint transferChecked,
// or a missing/foreign memo. Rejecting is always safe (the transfer stays
// on-chain; a rescan after a rule fix can still credit it, idempotent by
// signature), while wrongly accepting would mint ledger balance, so every
// ambiguity resolves to null.
export const DEPOSIT_MEMO_PREFIX = 'dsk1:deposit:';

export interface ParsedDeposit {
  senderWallet: string;
  amountBase: bigint;
  memo: string;
}

interface ParsedInstruction {
  program?: unknown;
  parsed?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function instructionsOf(tx: unknown): ParsedInstruction[] {
  const message = asRecord(asRecord(asRecord(tx)?.transaction)?.message);
  const list = message?.instructions;
  return Array.isArray(list) ? (list as ParsedInstruction[]) : [];
}

function memoOf(instructions: ParsedInstruction[]): string | null {
  for (const ins of instructions) {
    if (ins.program !== 'spl-memo') continue;
    if (typeof ins.parsed !== 'string') continue;
    // Live-devnet finding (tx 2UQkNh8V...): the umi toolbox addMemo serializer
    // writes the string with a 4-byte little-endian length prefix, so the
    // parsed memo arrives as "#\0\0\0dsk1:deposit:...". Match the marker
    // anywhere and return the clean suffix, so both raw and length-prefixed
    // memo encodings parse.
    const idx = ins.parsed.indexOf(DEPOSIT_MEMO_PREFIX);
    if (idx >= 0) return ins.parsed.slice(idx);
  }
  return null;
}

function baseAmountOf(info: Record<string, unknown>, type: string): bigint | null {
  const raw =
    type === 'transferChecked'
      ? asRecord(info.tokenAmount)?.amount
      : type === 'transfer'
        ? info.amount
        : undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const amount = BigInt(raw);
  return amount > 0n ? amount : null;
}

function senderOf(info: Record<string, unknown>): string | null {
  const { authority, multisigAuthority } = info;
  if (typeof authority === 'string' && authority) return authority;
  if (typeof multisigAuthority === 'string' && multisigAuthority) return multisigAuthority;
  return null;
}

/**
 * Parse one jsonParsed transaction into a deposit, or null when it is not a
 * valid deposit to `treasuryAta`. `mint` guards the transferChecked arm; a
 * plain `transfer` carries no mint field, which is still safe because the
 * destination is the treasury's ATA FOR THE SPIRE MINT: the token program
 * rejects a transfer of any other mint into it on-chain.
 */
export function parseDepositTransaction(
  tx: unknown,
  treasuryAta: string,
  mint: string,
): ParsedDeposit | null {
  const record = asRecord(tx);
  if (!record) return null;
  // A failed transaction moved nothing, whatever its instructions say.
  const meta = asRecord(record.meta);
  if (!meta || meta.err !== null) return null;

  const instructions = instructionsOf(record);
  const memo = memoOf(instructions);
  if (memo === null) return null;

  for (const ins of instructions) {
    if (ins.program !== 'spl-token') continue;
    const parsed = asRecord(ins.parsed);
    const type = parsed?.type;
    if (type !== 'transfer' && type !== 'transferChecked') continue;
    const info = asRecord(parsed?.info);
    if (!info || info.destination !== treasuryAta) continue;
    if (type === 'transferChecked' && info.mint !== mint) continue;
    const amountBase = baseAmountOf(info, type);
    const senderWallet = senderOf(info);
    if (amountBase === null || senderWallet === null) continue;
    return { senderWallet, amountBase, memo };
  }
  return null;
}
