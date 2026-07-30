// Duskspire devnet end-to-end: proves every v1 on-chain flow against the real
// devnet cluster. Idempotent: addresses persist in state/devnet.json, so reruns
// reuse the existing mint/collections and only re-run the transfer flows.
//
//   npm run e2e              all steps
//   npm run token            create the SPIRE mint + mint the fixed supply
//   npm run collections      create the Heroes + Relics Core collections
//   npm run hero             mint a demo hero NFT to the demo player
//   npm run deposit          player deposits SPIRE to the treasury (with memo ref)
//   npm run withdraw         treasury pays SPIRE out to the player (payout pattern)
//   npm run status           balances + addresses
//
// The deposit/withdraw shapes mirror the game server's existing rails: a
// deposit is a player-signed transfer carrying a reference memo the server
// indexes (the Claudium purchase pattern), a withdrawal is a treasury-signed
// transfer the payout pipeline records (the Daily Rewards pattern).
import { create, createCollection, fetchAsset } from '@metaplex-foundation/mpl-core';
import {
  TokenStandard,
  createFungible,
  mintV1,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  addMemo,
  createTokenIfMissing,
  fetchToken,
  findAssociatedTokenPda,
  mplToolbox,
  transferTokens,
} from '@metaplex-foundation/mpl-toolbox';
import {
  createSignerFromKeypair,
  generateSigner,
  percentAmount,
  publicKey,
  signerIdentity,
  some,
} from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import {
  TOKEN_DECIMALS,
  TOKEN_NAME,
  TOKEN_SUPPLY_BASE,
  TOKEN_SYMBOL,
  demoPlayer,
  ensurePlayerFunded,
  explorer,
  fmtSpire,
  loadState,
  makeUmi,
  note,
  saveState,
  solBalance,
  spire,
} from './lib.js';

const step = process.argv.find((a) => a.startsWith('--step='))?.slice(7) ?? 'all';
const umi = makeUmi().use(mplTokenMetadata());
const state = loadState();
state.authority = umi.identity.publicKey;
const player = demoPlayer(umi);
state.demoPlayer = player.publicKey;
saveState(state);

const sigOf = (result: { signature: Uint8Array }) => base58.deserialize(result.signature)[0];

async function tokenBalance(owner: string): Promise<bigint> {
  if (!state.mint) return 0n;
  const pda = findAssociatedTokenPda(umi, {
    mint: publicKey(state.mint),
    owner: publicKey(owner),
  });
  try {
    return (await fetchToken(umi, pda)).amount;
  } catch {
    return 0n;
  }
}

async function ensureAta(owner: string): Promise<void> {
  const result = await createTokenIfMissing(umi, {
    mint: publicKey(state.mint as string),
    owner: publicKey(owner),
  }).sendAndConfirm(umi);
  void result;
}

async function stepToken(): Promise<void> {
  if (state.mint) {
    console.log(`[token] mint already exists: ${state.mint}`);
    return;
  }
  const mint = generateSigner(umi);
  const created = await createFungible(umi, {
    mint,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: 'https://duskspire.example/token.json',
    sellerFeeBasisPoints: percentAmount(0),
    decimals: some(TOKEN_DECIMALS),
  }).sendAndConfirm(umi);
  state.mint = mint.publicKey;
  note(state, 'token:create', sigOf(created), `${TOKEN_SYMBOL} mint ${mint.publicKey}`);

  const minted = await mintV1(umi, {
    mint: mint.publicKey,
    authority: umi.identity,
    amount: TOKEN_SUPPLY_BASE,
    tokenOwner: umi.identity.publicKey,
    tokenStandard: TokenStandard.Fungible,
  }).sendAndConfirm(umi);
  note(state, 'token:mint-supply', sigOf(minted), `minted ${fmtSpire(TOKEN_SUPPLY_BASE)} to treasury`);
}

async function stepCollections(): Promise<void> {
  if (state.heroCollection && state.relicCollection) {
    console.log(`[collections] already exist: heroes ${state.heroCollection}, relics ${state.relicCollection}`);
    return;
  }
  if (!state.heroCollection) {
    const heroes = generateSigner(umi);
    const r = await createCollection(umi, {
      collection: heroes,
      name: 'Duskspire Heroes',
      uri: 'https://duskspire.example/collections/heroes.json',
    }).sendAndConfirm(umi);
    state.heroCollection = heroes.publicKey;
    note(state, 'collections:heroes', sigOf(r), heroes.publicKey);
  }
  if (!state.relicCollection) {
    const relics = generateSigner(umi);
    const r = await createCollection(umi, {
      collection: relics,
      name: 'Duskspire Relics',
      uri: 'https://duskspire.example/collections/relics.json',
    }).sendAndConfirm(umi);
    state.relicCollection = relics.publicKey;
    note(state, 'collections:relics', sigOf(r), relics.publicKey);
  }
}

async function stepHero(): Promise<void> {
  if (!state.heroCollection) throw new Error('run collections first');
  if (state.demoHeroAsset) {
    console.log(`[hero] demo hero already minted: ${state.demoHeroAsset}`);
    return;
  }
  const { fetchCollection } = await import('@metaplex-foundation/mpl-core');
  const collection = await fetchCollection(umi, publicKey(state.heroCollection));
  const asset = generateSigner(umi);
  // The draw itself (rarity/class) is the SERVER's job under commit-reveal rng
  // (docs/p2e/economy.md section 5); this devnet demo fixes an example result.
  const r = await create(umi, {
    asset,
    collection,
    name: 'Duskspire Hero: Epic Warrior',
    uri: 'https://duskspire.example/heroes/demo.json',
    owner: player.publicKey,
    plugins: [
      {
        type: 'Attributes',
        attributeList: [
          { key: 'archetype', value: 'warrior' },
          { key: 'rarity', value: 'epic' },
          { key: 'season', value: '0-devnet' },
        ],
      },
    ],
  }).sendAndConfirm(umi);
  state.demoHeroAsset = asset.publicKey;
  note(state, 'hero:mint', sigOf(r), `hero NFT ${asset.publicKey} owner ${player.publicKey}`);

  const fetched = await fetchAsset(umi, asset.publicKey);
  if (fetched.owner !== player.publicKey) throw new Error('hero owner mismatch after mint');
  console.log('[hero] on-chain owner verified:', fetched.owner);
}

// Player buys 500 SPIRE worth of ledger balance? No: deposits flow player ->
// treasury. For the demo the treasury first SEEDS the player (standing in for
// "player bought SPIRE on a DEX"), then the player deposits 100 with a memo
// reference, exactly the shape the server's deposit indexer will consume.
async function stepDeposit(): Promise<void> {
  if (!state.mint) throw new Error('run token first');
  await ensurePlayerFunded(umi, player);
  await ensureAta(player.publicKey);
  await ensureAta(umi.identity.publicKey);

  const seed = await transferTokens(umi, {
    source: findAssociatedTokenPda(umi, {
      mint: publicKey(state.mint),
      owner: umi.identity.publicKey,
    }),
    destination: findAssociatedTokenPda(umi, {
      mint: publicKey(state.mint),
      owner: player.publicKey,
    }),
    authority: umi.identity,
    amount: spire(500),
  }).sendAndConfirm(umi);
  note(state, 'deposit:seed-player', sigOf(seed), 'treasury -> player 500 SPIRE (stand-in for a DEX buy)');

  const playerUmi = makeUmi()
    .use(mplToolbox())
    .use(signerIdentity(createSignerFromKeypair(umi, player)));
  const reference = `dsk1:deposit:${player.publicKey.slice(0, 8)}:${Date.now()}`;
  const depositTx = await transferTokens(playerUmi, {
    source: findAssociatedTokenPda(playerUmi, {
      mint: publicKey(state.mint),
      owner: player.publicKey,
    }),
    destination: findAssociatedTokenPda(playerUmi, {
      mint: publicKey(state.mint),
      owner: umi.identity.publicKey,
    }),
    authority: playerUmi.identity,
    amount: spire(100),
  })
    .add(addMemo(playerUmi, { memo: reference }))
    .sendAndConfirm(playerUmi);
  note(state, 'deposit:player-deposit', sigOf(depositTx), `player -> treasury 100 SPIRE, memo ${reference}`);
}

async function stepWithdraw(): Promise<void> {
  if (!state.mint) throw new Error('run token first');
  await ensureAta(player.publicKey);
  const before = await tokenBalance(player.publicKey);
  const r = await transferTokens(umi, {
    source: findAssociatedTokenPda(umi, {
      mint: publicKey(state.mint),
      owner: umi.identity.publicKey,
    }),
    destination: findAssociatedTokenPda(umi, {
      mint: publicKey(state.mint),
      owner: player.publicKey,
    }),
    authority: umi.identity,
    amount: spire(250),
  })
    .add(addMemo(umi, { memo: `dsk1:payout:${player.publicKey.slice(0, 8)}` }))
    .sendAndConfirm(umi);
  const after = await tokenBalance(player.publicKey);
  if (after - before !== spire(250)) throw new Error('withdraw balance delta mismatch');
  note(state, 'withdraw:payout', sigOf(r), `treasury -> player ${fmtSpire(spire(250))} (verified on-chain)`);
}

async function stepStatus(): Promise<void> {
  console.log('cluster           devnet');
  console.log('authority         ', state.authority, `(${await solBalance(umi, umi.identity.publicKey)} SOL)`);
  console.log('demo player       ', state.demoPlayer, `(${await solBalance(umi, player.publicKey)} SOL)`);
  console.log('SPIRE mint        ', state.mint ?? '(not created)');
  if (state.mint) {
    console.log('  treasury balance', fmtSpire(await tokenBalance(state.authority as string)));
    console.log('  player balance  ', fmtSpire(await tokenBalance(state.demoPlayer as string)));
    console.log('  explorer        ', explorer(state.mint, 'address'));
  }
  console.log('hero collection   ', state.heroCollection ?? '(not created)');
  console.log('relic collection  ', state.relicCollection ?? '(not created)');
  console.log('demo hero asset   ', state.demoHeroAsset ?? '(not minted)');
  if (state.demoHeroAsset) console.log('  explorer        ', explorer(state.demoHeroAsset, 'address'));
}

const steps: Record<string, () => Promise<void>> = {
  token: stepToken,
  collections: stepCollections,
  hero: stepHero,
  deposit: stepDeposit,
  withdraw: stepWithdraw,
  status: stepStatus,
};

if (step === 'all') {
  await stepToken();
  await stepCollections();
  await stepHero();
  await stepDeposit();
  await stepWithdraw();
  await stepStatus();
} else if (steps[step]) {
  await steps[step]();
} else {
  console.error(`unknown step "${step}" (token|collections|hero|deposit|withdraw|status|all)`);
  process.exit(1);
}
