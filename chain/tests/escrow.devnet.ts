// Devnet exercise of the duskspire_escrow program: the full stake-match
// lifecycle with real SPIRE on the real cluster, plus the two adversarial
// checks that define the trust model (a player cannot settle, the pot math
// pays winner + rake exactly). Run via `npx tsx tests/escrow.devnet.ts` after
// `anchor deploy` (Anchor.toml wires it as the anchor test script).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  transfer,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHAIN = join(here, '..');
const RPC = process.env.DUSKSPIRE_RPC ?? 'https://api.devnet.solana.com';

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
}

function loadOrCreate(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Array.from(kp.secretKey))}\n`);
  return kp;
}

const connection = new Connection(RPC, 'confirmed');
const authority = loadKeypair(
  process.env.DUSKSPIRE_AUTHORITY_KEY ?? join(homedir(), '.config', 'solana', 'id.json'),
);
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), {
  commitment: 'confirmed',
});
anchor.setProvider(provider);

const idl = JSON.parse(readFileSync(join(CHAIN, 'target', 'idl', 'duskspire_escrow.json'), 'utf8'));
const program = new anchor.Program(idl, provider);
const programId = new PublicKey(idl.address);

const state = JSON.parse(readFileSync(join(CHAIN, 'state', 'devnet.json'), 'utf8'));
const mint = new PublicKey(state.mint);

const playerA = loadOrCreate(join(CHAIN, '.keys', 'demo-player.json'));
const playerB = loadOrCreate(join(CHAIN, '.keys', 'demo-player-b.json'));

const DECIMALS = 9n;
const spire = (n: number) => BigInt(n) * 10n ** DECIMALS;

async function fundSol(to: PublicKey, sol: number): Promise<void> {
  const balance = await connection.getBalance(to);
  if (balance >= sol * LAMPORTS_PER_SOL) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: to,
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    }),
  );
  await provider.sendAndConfirm(tx);
}

async function main(): Promise<void> {
  console.log('program', programId.toBase58());
  await fundSol(playerA.publicKey, 0.05);
  await fundSol(playerB.publicKey, 0.05);

  const ata = async (owner: PublicKey) =>
    (await getOrCreateAssociatedTokenAccount(connection, authority, mint, owner)).address;
  const authorityAta = await ata(authority.publicKey);
  const playerAAta = await ata(playerA.publicKey);
  const playerBAta = await ata(playerB.publicKey);

  // Seed both players with stake money from the treasury.
  for (const dest of [playerAAta, playerBAta]) {
    await transfer(connection, authority, authorityAta, dest, authority, spire(50));
  }

  const balanceOf = async (addr: PublicKey) => (await getAccount(connection, addr)).amount;

  const stake = spire(10);
  const rakeBps = 1000; // 10 percent, economy.md section 6
  const matchId = new anchor.BN(Date.now());
  const [matchState] = PublicKey.findProgramAddressSync(
    [Buffer.from('match'), matchId.toArrayLike(Buffer, 'le', 8)],
    programId,
  );
  const vault = getAssociatedTokenAddressSync(mint, matchState, true);

  await program.methods
    .createMatch(matchId, new anchor.BN(stake.toString()), rakeBps)
    .accounts({
      authority: authority.publicKey,
      mint,
      treasury: authority.publicKey,
      playerA: playerA.publicKey,
      playerB: playerB.publicKey,
      matchState,
      vault,
    })
    .rpc();
  check('create_match on devnet', true);

  for (const [player, token] of [
    [playerA, playerAAta],
    [playerB, playerBAta],
  ] as const) {
    await program.methods
      .deposit(matchId)
      .accounts({
        player: player.publicKey,
        matchState,
        playerToken: token,
        vault,
      })
      .signers([player])
      .rpc();
  }
  check('both players deposited', (await balanceOf(vault)) === stake * 2n);

  // Adversarial: player A tries to settle themselves the pot. Must fail.
  let playerSettleRejected = false;
  try {
    await program.methods
      .settle(matchId)
      .accounts({
        authority: playerA.publicKey,
        matchState,
        winner: playerA.publicKey,
        winnerToken: playerAAta,
        treasuryToken: authorityAta,
        vault,
      })
      .signers([playerA])
      .rpc();
  } catch {
    playerSettleRejected = true;
  }
  check('player cannot settle the pot (authority only)', playerSettleRejected);

  const winnerBefore = await balanceOf(playerAAta);
  const treasuryBefore = await balanceOf(authorityAta);
  await program.methods
    .settle(matchId)
    .accounts({
      authority: authority.publicKey,
      matchState,
      winner: playerA.publicKey,
      winnerToken: playerAAta,
      treasuryToken: authorityAta,
      vault,
    })
    .rpc();
  const pot = stake * 2n;
  const rake = (pot * BigInt(rakeBps)) / 10_000n;
  check('winner received pot minus rake', (await balanceOf(playerAAta)) - winnerBefore === pot - rake);
  check('treasury received the rake', (await balanceOf(authorityAta)) - treasuryBefore === rake);

  // Refund path: new match, one deposit, authority refunds.
  const matchId2 = new anchor.BN(Date.now() + 1);
  const [matchState2] = PublicKey.findProgramAddressSync(
    [Buffer.from('match'), matchId2.toArrayLike(Buffer, 'le', 8)],
    programId,
  );
  const vault2 = getAssociatedTokenAddressSync(mint, matchState2, true);
  await program.methods
    .createMatch(matchId2, new anchor.BN(stake.toString()), rakeBps)
    .accounts({
      authority: authority.publicKey,
      mint,
      treasury: authority.publicKey,
      playerA: playerA.publicKey,
      playerB: playerB.publicKey,
      matchState: matchState2,
      vault: vault2,
    })
    .rpc();
  const bBefore = await balanceOf(playerBAta);
  await program.methods
    .deposit(matchId2)
    .accounts({
      player: playerB.publicKey,
      matchState: matchState2,
      playerToken: playerBAta,
      vault: vault2,
    })
    .signers([playerB])
    .rpc();
  await program.methods
    .refund(matchId2)
    .accounts({
      authority: authority.publicKey,
      matchState: matchState2,
      playerAToken: playerAAta,
      playerBToken: playerBAta,
      vault: vault2,
    })
    .rpc();
  check('refund returned the lone deposit', (await balanceOf(playerBAta)) === bBefore);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} escrow checks passed on devnet`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
