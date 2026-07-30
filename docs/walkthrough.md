# Walkthrough

Step-by-step narrative of the demo, matching what's actually deployed on
devnet (see `README.md` for addresses). Every step below is a real
transaction on a public cluster, not a simulation.

## 0. What's being proven

One Token-2022 mint carries three extensions at once:

- **TransferHook** — every transfer is routed through a custom Anchor
  program that enforces an allowlist. Rejection happens inside the CPI
  Token-2022 makes to the hook, not in client code.
- **ConfidentialTransferMint** — transfer amounts and balances are encrypted
  on-chain; the allowlist still applies to encrypted transfers.
- **PermanentDelegate** — the issuer can move any holder's tokens without
  their signature, standard clawback mechanism for a regulated asset.

## 1. Mint creation (`npm run create-mint`)

`create-mint.ts` does more than create a mint. In one transaction it sizes
the mint account for all three extensions and initializes them
(`TransferHook`, `ConfidentialTransferMint`, `PermanentDelegate`), then in a
second transaction:

1. Creates the `Allowlist` PDA (`initialize_allowlist`).
2. Creates the extra-account-meta-list validation account
   (`initialize_extra_account_meta_list`) — without this the TransferHook
   extension is inert, Token-2022 has nowhere to resolve the hook's extra
   accounts from, and every transfer fails.
3. Adds the issuer to its own allowlist.

Step 3 is not optional. `execute` runs on the permanent-delegate path too
(§3 below), so an issuer that isn't allowlisted can't claw back later.

Output on this deployment:

```
Mint created: 3eV7Ejpm3R5WVftW2G4dPatnfHXdGyW8ZrrTzURHnicT
Hook wired up:
  allowlist            ChNLQyCB6C23jfcRN1xhWj9dgtg4k138gRs4WN5HPJRX
  extraAccountMetaList BgNWreTXr4YvvBBLnz7PS4XRH9y2T25186KYZCkKAChn
```

Verify independently: `spl-token display <mint> --url devnet` shows all
three extensions.

## 2. Allowlist enforcement (`npm run demo-transfer`)

Creates two holders, Alice and Bob (issuer pays for their token accounts —
holders only ever sign, never pay). Mints 1,000 tokens to Alice, then
attempts the same 25-token transfer under three allowlist states:

```
  Bob not allowlisted     : REJECTED by the hook — RecipientNotAllowlisted
  Both allowlisted        : SUCCEEDED
  Alice removed as sender : REJECTED by the hook — SenderNotAllowlisted
```

Final balances: Alice 975, Bob 25. The script restores the allowlist to a
clean state afterward so it's re-runnable and `demo-clawback` starts sane.

The instruction is built with
`createTransferCheckedWithTransferHookInstruction`, which reads the mint's
TransferHook extension, fetches the validation account, and appends the
resolved extra accounts in interface order — the same path a real wallet
takes. Using it (rather than hand-appending accounts) proves the validation
account is genuinely well-formed.

## 3. Permanent delegate clawback (`npm run demo-clawback`)

The realistic compliance sequence is **freeze, then seize** — sanction a
holder by removing them from the allowlist, then the issuer seizes their
tokens. The demo runs exactly that order:

```
Step 1 — sanction Bob by removing him from the allowlist
Step 2 — Bob tries to move his own tokens to Alice
  REJECTED by the hook — SenderNotAllowlisted
Step 3 — issuer seizes 5 as permanent delegate
  SUCCEEDED — no signature from Bob
```

Step 2 proves the sanction holds even against the holder's own signature.
Step 3 only succeeds because `execute` carries an explicit exemption for
the permanent-delegate path — see `docs/extensions-deep-dive.md` for why
that exemption exists and why an earlier version of this program didn't
have it. The signer list on the clawback transaction is the issuer alone;
Bob's keypair is loaded in the script only to attempt step 2.

## 4. Confidential transfers (litesvm only)

Cannot run on devnet — three independent reasons, covered in
`docs/extensions-deep-dive.md`. Proven instead in
`programs/transfer-hook/tests/confidential.rs`:
`confidential_transfer_moves_value_without_revealing_the_amount` appends
the allowlist, hook program, and validation account to a
`ConfidentialTransferInstruction::Transfer` and asserts it succeeds only
when both parties are allowlisted — the same guarantee as a plain
`TransferChecked`, just against encrypted amounts. The allowlist holds
across both transfer paths.

## 5. Indexer

`npm run setup-webhook` registers a Helius webhook against the hook program
and mint; `npm run indexer` runs the Axum receiver, which verifies the
shared-secret Authorization header and appends events to
`indexer/events.jsonl`.

## 6. Frontend

`cd frontend && npm run dev`. Single role-aware page: wallet-connect first,
then mint/allowlist/clawback islands appear only when the connected wallet
matches the issuer address in `deployments/devnet.json`; transfer and
confidential-balance islands are visible to any connected wallet.
