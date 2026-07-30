// Shared plumbing for the Duskspire devnet scripts: umi client, key handling,
// and the persisted address state. DEVNET ONLY: the mainnet launch runs through
// a hardened path (multisig authorities, audited flows; PLAN.md Phase 5), never
// through these scripts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Keypair,
  type Umi,
  createSignerFromKeypair,
  keypairIdentity,
  lamports,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';

const here = dirname(fileURLToPath(import.meta.url));
export const CHAIN_DIR = join(here, '..');
const KEYS_DIR = join(CHAIN_DIR, '.keys');
const STATE_DIR = join(CHAIN_DIR, 'state');
const STATE_PATH = join(STATE_DIR, 'devnet.json');

export const RPC_URL = process.env.DUSKSPIRE_RPC ?? 'https://api.devnet.solana.com';

// Token economics (docs/p2e/economy.md): fixed 1B supply, 9 decimals.
export const TOKEN_NAME = 'Duskspire';
export const TOKEN_SYMBOL = 'SPIRE';
export const TOKEN_DECIMALS = 9;
export const TOKEN_SUPPLY_BASE = 1_000_000_000n * 10n ** BigInt(TOKEN_DECIMALS);

export interface ChainState {
  cluster: string;
  authority?: string;
  mint?: string;
  heroCollection?: string;
  relicCollection?: string;
  demoPlayer?: string;
  demoHeroAsset?: string;
  log: { at: string; step: string; signature?: string; note?: string }[];
}

export function loadState(): ChainState {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ChainState;
  return { cluster: 'devnet', log: [] };
}

export function saveState(state: ChainState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function readKeypairFile(umi: Umi, path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return umi.eddsa.createKeypairFromSecretKey(new Uint8Array(raw));
}

function loadOrCreateKeypair(umi: Umi, path: string): Keypair {
  if (existsSync(path)) return readKeypairFile(umi, path);
  const kp = umi.eddsa.generateKeypair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Array.from(kp.secretKey))}\n`);
  return kp;
}

// The treasury/mint authority. Defaults to the solana CLI keypair (already
// funded on devnet); override with DUSKSPIRE_AUTHORITY_KEY=<path>.
export function authorityKeyPath(): string {
  return process.env.DUSKSPIRE_AUTHORITY_KEY ?? join(homedir(), '.config', 'solana', 'id.json');
}

export function makeUmi(): Umi {
  const umi = createUmi(RPC_URL, { commitment: 'confirmed' });
  const authority = readKeypairFile(umi, authorityKeyPath());
  umi.use(keypairIdentity(authority));
  return umi;
}

// A throwaway devnet keypair standing in for a player's wallet in the flows.
export function demoPlayer(umi: Umi) {
  const kp = loadOrCreateKeypair(umi, join(KEYS_DIR, 'demo-player.json'));
  return createSignerFromKeypair(umi, kp);
}

export async function solBalance(umi: Umi, address: Parameters<Umi['rpc']['getBalance']>[0]) {
  const amount = await umi.rpc.getBalance(address);
  return Number(amount.basisPoints) / 1e9;
}

export async function ensurePlayerFunded(umi: Umi, player: { publicKey: any }): Promise<void> {
  const balance = await umi.rpc.getBalance(player.publicKey);
  if (Number(balance.basisPoints) >= 0.05 * 1e9) return;
  // Fund from the authority (more reliable than the devnet faucet) with a
  // faucet airdrop as the fallback.
  try {
    const { transferSol } = await import('@metaplex-foundation/mpl-toolbox');
    await transferSol(umi, {
      destination: player.publicKey,
      amount: lamports(BigInt(Math.round(0.1 * 1e9))),
    }).sendAndConfirm(umi);
  } catch {
    await umi.rpc.airdrop(player.publicKey, lamports(BigInt(1e9)));
  }
}

export function spire(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** TOKEN_DECIMALS));
}

export function fmtSpire(base: bigint): string {
  return `${Number(base) / 10 ** TOKEN_DECIMALS} ${TOKEN_SYMBOL}`;
}

export function explorer(signatureOrAddress: string, kind: 'tx' | 'address' = 'tx'): string {
  return `https://explorer.solana.com/${kind}/${signatureOrAddress}?cluster=devnet`;
}

export function note(state: ChainState, step: string, signature?: string, extra?: string): void {
  state.log.push({
    at: new Date().toISOString(),
    step,
    ...(signature ? { signature } : {}),
    ...(extra ? { note: extra } : {}),
  });
  saveState(state);
  const suffix = signature ? ` ${explorer(signature)}` : '';
  console.log(`[${step}]${extra ? ` ${extra}` : ''}${suffix}`);
}
