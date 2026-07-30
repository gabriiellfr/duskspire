# Live rehearsal log

## 2026-07-30: full money loop on devnet (PASS, 2 bugs found and fixed)

Stack: local Postgres (docker), the real game server with
P2E_DEPOSITS_ENABLED=1 against devnet, the chain workspace as the player and
payout sides. Flow exercised end to end with real transactions:

1. Registered an account, linked the demo player wallet through the real
   challenge/sign flow.
2. Player deposited 100 SPIRE on devnet with the dsk1:deposit memo
   (tx 2UQkNh8VzNzmfsNdq9n8f6MutjrW7WefBtXRaodFjUrgZ4na19bXF2WBiXsMHJaY3BpWyj9JLMpejUdkPptRVytZ).
3. The deposit indexer credited it: GET /api/p2e/balance 100 SPIRE, ledger
   entry ref = the tx signature.
4. POST /api/p2e/withdraw for 20 SPIRE: debited to 80, queue row pending,
   destination forced to the linked wallet.
5. The payout worker claimed and sent it on-chain
   (tx dabCYbsh7uFn873rg5qqwKKjHDTu2kcWogHoteCw1tGBsVLPQx9yG7VYzfKM72tQXMG1KPbgXcZC3u4GTvzL4TG,
   see the row's tx_signature for the exact value), row stamped sent, player
   token account grew by 20 SPIRE.
6. A full-history rescan after a cursor reset credited nothing twice (ledger
   idempotency observed live).

Bugs the rehearsal caught, both fixed with regression tests in
tests/server/p2e_deposit.test.ts:

- **Length-prefixed memos.** The umi toolbox addMemo serializer writes the
  memo string with a 4-byte length prefix, so the parsed memo arrives as
  "#\0\0\0dsk1:deposit:...". The parser's startsWith never matched and the
  deposit was classified foreign. Fix: match the marker anywhere in the memo
  and return the clean suffix.
- **Cursor advance past unfetchable transactions.** When getTransaction
  returns null for a listed signature (finalization lag, a lagging node), the
  scan classified it foreign and advanced the cursor PAST a possibly real
  deposit forever. Fix: halt the scan without advancing and retry next pass
  (haltedMissingTx in the scan result).

Operational notes:

- The public devnet RPC 429s hard on burst getTransaction reads; the indexer
  now paces per-transaction reads (250ms) and each aborted scan resumes
  cleanly next tick. Production needs a dedicated RPC endpoint
  (SOLANA_RPC_URL), same as the existing woc_balance guidance.
- A fresh deployment against a treasury with existing history takes several
  scan passes to chew through it; harmless, and bounded by the cursor once
  caught up.
