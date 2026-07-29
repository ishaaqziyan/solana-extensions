# Solana Token Extensions Compliance Token — Architecture (MVP scope)

A regulated-asset reference token built on SPL Token-2022, combining transfer
hooks, confidential transfers, and a permanent delegate. Portfolio / DevRel
reference implementation, scoped to MVP.

## 1. Goals

- Demonstrate Token-2022's three most relevant extensions for a regulated
  asset, stacked on a single mint, at full mechanism depth.
- Show a working allowlist enforced at the protocol level via a transfer hook,
  not just in a frontend.
- Show confidential balances that remain auditable by an issuer-controlled
  permanent delegate.
- Ship as a teachable artifact: clean program code, a runnable demo, a
  walkthrough post, since Token Extensions hook documentation is currently thin.

## 1.1 MVP scope note

- Every mechanism below is kept at full depth, transfer hook enforcement,
  confidential transfer proofs, and permanent delegate clawback are all fully
  implemented, this is what makes the project advanced.
- What's cut is surrounding surface area: admin dashboard polish, the DAS API
  fallback, and a scalable allowlist structure. A simple `Vec<Pubkey>` PDA
  stands in for the allowlist, with the merkle/bitmap upgrade path documented
  rather than built. Wallet flow is single-role for the demo rather than a
  full multi-role admin/holder split.

## 2. Extensions used, and why each one matters

| Extension | Purpose | Compliance angle |
|---|---|---|
| `TransferHook` | Calls a custom program on every transfer | Enforces allowlist / jurisdiction checks on-chain, at the protocol level |
| `ConfidentialTransferMint` | Encrypts transfer amounts and balances | Hides amounts from the public ledger while preserving auditability |
| `PermanentDelegate` | Grants one authority permanent transfer/burn rights over any account | Standard clawback mechanism regulated issuers require |

## 3. Roles (MVP: two roles, not three)

| Role | Description | Capabilities |
|---|---|---|
| Issuer | Mint authority, permanent delegate, allowlist admin, hook admin | Mint, update allowlist, claw back tokens, view confidential balances |
| Holder | Regular wallet holding the token | Hold, transfer to allowlisted peers, view own balance |

- Compliance Officer as a separate role is cut for MVP, Issuer holds all admin
  capabilities in one keypair. Docs note how to split this into a multisig or
  a dedicated compliance authority in a production version.

## 4. On-chain architecture

### 4.1 Mint account (Token-2022)
- Extensions enabled at mint creation: `TransferHook`, `ConfidentialTransferMint`,
  `PermanentDelegate`.
- Mint authority: Issuer.
- Permanent delegate: Issuer (or a separate compliance authority PDA).
- Transfer hook program ID: points to the custom Anchor program below.

### 4.2 Transfer hook program (Anchor)
- Implements the `TransferHookInterface`: `initialize_extra_account_meta_list`
  and `execute`.
- `execute` is invoked automatically by the token program on every transfer,
  via CPI, this is what makes the check unavoidable rather than optional.
- Reads an `Allowlist` PDA (seeded by mint) containing approved addresses.
- Aborts the transfer if either sender or recipient is not on the allowlist.
- `extra_account_meta_list` declares the additional accounts (allowlist PDA)
  the token program must pass into the hook CPI, required by the interface.

### 4.3 Allowlist PDA (MVP: simple vector, not a scalable structure)
- Seeds: `["allowlist", mint_pubkey]`
- Fields: `authority` (who can modify it), `addresses: Vec<Pubkey>`.
- Instructions: `add_address`, `remove_address`, both gated to `authority`.
- A `Vec<Pubkey>` is fine at demo scale, a handful to a few dozen addresses.
  Production upgrade path (bitmap or merkle-proof allowlist for larger sets)
  is documented in `docs/extensions-deep-dive.md`, not built for MVP, since it
  adds real complexity without changing what the project demonstrates.

### 4.4 Confidential transfers
- Holders configure a confidential balance for their token account via
  `ConfigureAccount`, generating an ElGamal keypair client-side.
- Transfers use `ConfidentialTransfer` instructions with client-generated
  zero-knowledge proofs (equality, range, ciphertext validity) via the
  `zk-token-sdk` / `zk-elgamal-proof` program.
- Permanent delegate retains decryption capability over holder balances for
  audit purposes, documented clearly as the tradeoff being demonstrated,
  confidential from the public, not from the regulator-equivalent role.

### 4.5 Permanent delegate
- Set at mint creation, cannot be revoked, this is inherent to the extension.
- Issuer can call `TransferChecked` or `Burn` on any holder's account without
  their signature, standard clawback path for sanctions or court orders.
- Demo includes one explicit "clawback" flow so the capability is visible,
  not just theoretical.

## 5. Program layer

- **Anchor** for the transfer-hook program, Anchor's account constraint macros
  handle the extra-account-meta-list plumbing with far less boilerplate than
  raw `solana-program`.
- **Token-2022 program** (`spl-token-2022`) invoked via CPI for all mint,
  transfer, and confidential-transfer instructions, not reimplemented.
- Anchor program only owns the allowlist logic and the hook entrypoint,
  everything else defers to the standard Token-2022 program, keeping the
  custom surface area small and auditable.

## 6. Indexing / off-chain layer (MVP: minimal)

- **Helius webhooks** subscribed to the mint address and the hook program,
  since Token-2022 extension state (allowlist changes, confidential transfer
  configuration) isn't always convenient to reconstruct from plain RPC polling.
- Lightweight Rust service (Axum, matching your existing stack) consuming
  webhook events, storing a simple event log, enough to display recent
  transfers and clawback events in the frontend.
- DAS API fallback cut for MVP, direct RPC calls cover the demo's basic
  account/mint lookups without the extra integration.

## 7. Frontend (MVP: one page, role-aware, not two separate views)

- **Astro** as the shell, static-first, matches the demo's mostly-read shape.
- **Tailwind CSS** for styling.
- **Islands** (Preact or vanilla TS), trimmed to what each mechanism needs to
  be visible and provable, nothing else:
  - Wallet connect (Solana Wallet Adapter)
  - Mint / issuance form (shown only when connected wallet is Issuer)
  - Allowlist panel, add/remove addresses (Issuer only)
  - Transfer form, generates confidential-transfer proofs client-side
  - Balance viewer, decrypts own confidential balance client-side
  - Clawback panel (Issuer only, this is the single most important island,
    it's the one that proves the permanent delegate mechanism)

- Single page (`index.astro`) with role-aware rendering based on connected
  wallet, rather than separate holder/issuer routes, this removes routing
  complexity without hiding any capability.

```
frontend/
  src/
    layouts/
      BaseLayout.astro
    components/
      WalletConnect.tsx        (island)
      MintForm.tsx              (island, issuer-only)
      AllowlistPanel.tsx        (island, issuer-only)
      TransferForm.tsx          (island)
      ConfidentialBalance.tsx   (island)
      ClawbackPanel.tsx         (island, issuer-only)
    pages/
      index.astro                (single role-aware page)
    lib/
      solanaClient.ts
      tokenExtensionsClient.ts
      zkProofHelpers.ts
  tailwind.config.mjs
  astro.config.mjs
```

## 8. Repo layout (top level)

```
solana-token-extensions-compliance/
  programs/
    transfer-hook/
      src/
        lib.rs
        state.rs        (Allowlist account)
        instructions/
          initialize_extra_account_meta_list.rs
          execute.rs
          add_address.rs
          remove_address.rs
      Cargo.toml
    Anchor.toml
  scripts/
    create-mint.ts       (Token-2022 mint + extensions setup)
    setup-allowlist.ts
    demo-transfer.ts
    demo-clawback.ts
  indexer/
    src/
      main.rs             (Axum, Helius webhook receiver)
  frontend/
    (as above)
  docs/
    walkthrough.md
    extensions-deep-dive.md
  README.md
```

## 9. Build sequence (MVP: 1-2 weeks)

1. Anchor transfer-hook program: allowlist state, `execute`, extra-account-meta
   list, tested locally with `anchor test` against a local validator.
2. Mint creation script: Token-2022 mint with all three extensions configured,
   verified via `spl-token display`.
3. Confidential transfer flow: account configuration, proof generation,
   transfer, decrypt-and-verify balance, this is still the most fragile part
   even at MVP scope, budget the most debugging time here, don't cut corners
   on this mechanism.
4. Permanent delegate clawback script, verified against a holder account
   without that holder's signature.
5. Indexer: Helius webhook wiring, basic event log, skip DAS integration.
6. Astro + Tailwind frontend: single role-aware page, wallet connect first,
   then allowlist and clawback islands, then transfer/balance islands.
7. Docs: architecture (this file), an extensions deep-dive noting the
   production upgrade paths that were cut, and a step-by-step walkthrough
   for the DevRel writeup.

## 10. What makes this a strong portfolio piece, even at MVP scope

- Most Token-2022 content covers one extension in isolation. Stacking three
  together, especially transfer hooks with confidential transfers, is where
  the real interoperability problems show up, and where documentation is
  thinnest right now. That's fully preserved at MVP scope.
- The clawback demo is the single clearest interview moment: showing a
  regulated-asset compliance guarantee enforced at the protocol level, not
  bolted on in a frontend. Nothing about MVP scoping touches this.
- What's cut (dashboard polish, DAS fallback, scalable allowlist) is exactly
  the kind of surface area that doesn't change what a reviewer learns from
  the repo, it only changes how long the repo takes to build.