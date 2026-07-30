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

## The escrow program

`programs/duskspire_escrow/` is the arena stake escrow (Anchor): the server
creates a match at a stake tier, both players deposit SPIRE into a PDA-owned
vault, and only the match authority can settle (winner gets the pot minus the
rake, rake to the treasury fixed at creation, hard-capped at 20 percent) or
refund. Players never trust the server with custody; the server is trusted
only to name the winner, which is the game's normal authority model.

Devnet deployment: program id `DpJDnYmfYoW5Ciw475SyKzkFXjHwnN1YrBVaUiBdtDXH`
(the id is baked into `declare_id!` and Anchor.toml; the deploy keypair lives
in gitignored `target/deploy/`, regenerate and re-sync ids for a fresh
deployment).

Build and test (see the Windows notes below):

```bash
cd chain
anchor build -- --tools-version v1.53 --skip-tools-install   # program .so
anchor idl build -o target/idl/duskspire_escrow.json          # IDL (separate: the
                                                              # extra args above break the IDL cargo test)
solana program deploy target/deploy/duskspire_escrow.so \
  --program-id target/deploy/duskspire_escrow-keypair.json --url devnet
npx tsx tests/escrow.devnet.ts                                # 6-check lifecycle + adversarial run
```

### Windows build notes (as of agave 3.0.14 / anchor 0.31)

- The stock platform-tools (v1.51, rust 1.84) cannot parse current crates.io
  manifests (edition2024). Use `--tools-version v1.53` (rust 1.89).
- `cargo-build-sbf` panics on any non-default `--tools-version` on Windows: it
  probes `rust/bin/rustc` without the `.exe` extension. Workaround: copy
  `rustc.exe` to an extensionless `rustc` inside
  `%USERPROFILE%\.cache\solana\v1.53\platform-tools\rust\bin\`, and link the
  toolchain as `rustup toolchain link 1.89.0-sbpf-solana-v1.53 <that rust dir>`.
- The workspace members list avoids `programs/*` globs (they fail under
  Windows verbatim paths), and Cargo.lock pins a few crates below their
  edition2024 releases; keep the lockfile.

## Never

- Never point these scripts at mainnet.
- Never commit anything under `.keys/`, and never use the devnet authority
  keypair for anything of value.
