# Duskspire chain workspace

The on-chain layer for Duskspire (docs/p2e/PLAN.md Phase 5), self-contained and
independent of the game build. DEVNET ONLY as configured: mainnet launch goes
through the hardened path (multisig authorities, audit) described in the plan.

## What is here

- `src/e2e.ts` + `src/lib.ts`: the v1 on-chain flows, runnable against devnet:
  - **SPIRE token**: SPL mint with on-chain metadata (name/symbol), fixed 1B
    supply minted to the treasury (economy.md).
  - **NFT collections**: Metaplex Core collections for Heroes and Relics, and a
    demo hero mint carrying `archetype`/`rarity` attributes, owner-verified
    on-chain after mint.
  - **Deposit flow**: player-signed SPIRE transfer to the treasury carrying a
    reference memo (`dsk1:deposit:...`), the shape the server's deposit indexer
    consumes (mirrors the game's Claudium purchase rails).
  - **Withdraw flow**: treasury-signed payout transfer with a memo, balance
    delta verified on-chain (mirrors the Daily Rewards payout pipeline).
- `programs/` (added in the escrow step): the Anchor marketplace escrow program.
- `state/devnet.json`: persisted addresses and a transaction log (committed;
  contains no secrets). Delete it to start a fresh devnet deployment.
- `.keys/`: gitignored throwaway keypairs (the demo player). The
  treasury/authority defaults to the local solana CLI keypair
  (`~/.config/solana/id.json`); override with `DUSKSPIRE_AUTHORITY_KEY=<path>`.

## Run it

```bash
cd chain
npm install
npm run e2e       # all steps, idempotent
npm run status    # balances + addresses + explorer links
```

Individual steps: `npm run token | collections | hero | deposit | withdraw`.
Custom RPC: `DUSKSPIRE_RPC=<url>`.

## Never

- Never point these scripts at mainnet.
- Never commit anything under `.keys/`, and never use the devnet authority
  keypair for anything of value.
