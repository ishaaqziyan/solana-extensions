# Session log — 2026-07-29

Handoff notes for the Solana Token Extensions compliance token (`work.md` is the
architecture spec; this file is where the build actually stands).

## Environment (verified)

| Tool | Version |
|---|---|
| anchor-cli | 1.1.2 |
| solana-cli | 3.1.10 (Agave) |
| cargo / rustc | 1.97.1 |
| node | v25.0.0 |

Program ID (from `target/deploy/transfer_hook-keypair.json`):
`DLfQ9dhxsXkur98Vze8L1sPHc14pVhkpdNSQqP3Qa3Bo`

## What is done

### Workspace scaffolded

Anchor 1.1.2 workspace lives at the repo root (`/home/iz/solana-extensions`),
scaffolded in a scratch dir and moved in, so `work.md` and the workspace share a
root. Files: `Cargo.toml`, `Anchor.toml`, `rust-toolchain.toml` (pins 1.89.0),
`.gitignore`, `.prettierignore`, `programs/transfer-hook/`.

Two deviations from `work.md` §8, both deliberate:

1. `work.md` places `Anchor.toml` inside `programs/`. It belongs at the workspace
   root and is there instead.
2. Anchor 1.1.2's default template ships **Rust `litesvm` tests**, not a
   TypeScript/mocha harness. `Anchor.toml` sets `test = "cargo test"` and
   `skip_local_validator = true`. Program tests will be Rust; the demo scripts in
   `scripts/` stay TypeScript as specced.

### Dependencies resolved — `cargo check -p transfer-hook` is green

This was the main risk and it is cleared. `programs/transfer-hook/Cargo.toml`:

```toml
anchor-lang = "1.1.2"
anchor-spl = { version = "1.1.2", features = ["token_2022"] }
spl-transfer-hook-interface = "2.1.0"
spl-tlv-account-resolution = "0.11.1"
spl-discriminator = "0.5.2"
```

Resolves to a **single** `spl-token-2022-interface v2.1.0` — no duplicate
solana-crate versions, which is the usual failure mode when stacking Anchor with
the SPL interface crates. `spl-pod` resolves to 0.7.3.

Note: `anchor-spl` 1.1.2 depends on `spl-token-2022-**interface**`, not
`spl-token-2022`. `anchor_spl::token_interface::spl_token_2022` is an alias for
it, so imports still read the familiar way.

### API facts confirmed by reading the vendored crate sources

Worth keeping — these are what the implementation is built on, and the published
docs for this version combination are thin.

- **Anchor 1.1.2 supports custom instruction discriminators**:
  `#[instruction(discriminator = <CONST_EXPR>)]`. Dispatch is
  `if data.starts_with(DISCRIMINATOR)`, so variable-length works. This means
  `execute` can carry the interface discriminator directly and the old
  `fallback` + `__private::__global` routing hack from the 0.29-era examples is
  **not needed**.
- Interface discriminator to use:
  `spl_transfer_hook_interface::instruction::ExecuteInstruction::SPL_DISCRIMINATOR_SLICE`
  (needs `spl_discriminator::SplDiscriminate` in scope — that is why
  `spl-discriminator` is a direct dep).
- After the discriminator, `execute` payload is just `amount: u64` LE, which
  matches borsh, so Anchor deserializes it correctly with no special handling.
- Validation-account PDA seed is `b"extra-account-metas"` + mint. The interface
  keeps the seed constant private and exposes only
  `get_extra_account_metas_address(&mint, &program_id)`.
- `ExtraAccountMetaList::{init, size_of}`, `ExtraAccountMeta::new_with_seeds`,
  and `spl_tlv_account_resolution::seeds::Seed` are the pieces needed for the
  validation account.
- Transferring-flag guard path:
  `anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::TransferHookAccount`
  with `PodStateWithExtensions::<PodAccount>::unpack` + `get_extension`.

### Program source written

`programs/transfer-hook/src/`:

- `constants.rs` — `ALLOWLIST_SEED`, `EXTRA_ACCOUNT_METAS_SEED`,
  `MAX_ALLOWLIST_ADDRESSES = 64`.
- `error.rs` — `HookError`: `SenderNotAllowlisted`, `RecipientNotAllowlisted`,
  `AddressAlreadyPresent`, `AddressNotFound`, `AllowlistFull`,
  `UnauthorizedAuthority`, `NotTransferring`, `ValidationAccountMismatch`.
- `state.rs` — `Allowlist { authority, mint, bump, addresses: Vec<Pubkey> }`,
  `SPACE = 8 + 32 + 32 + 1 + 4 + 64*32`, `contains()`.
- `instructions.rs` — module wiring.
- `instructions/initialize_allowlist.rs` — creates the `["allowlist", mint]` PDA.
- `instructions/add_address.rs` — `has_one = authority`, dedupe, capacity check.
- `instructions/remove_address.rs` — `has_one = authority`, `swap_remove`.
- `instructions/initialize_extra_account_meta_list.rs` — manual `create_account`
  CPI with PDA signer seeds, then `ExtraAccountMetaList::init::<ExecuteInstruction>`.
  Declares one extra account: the allowlist PDA, via
  `Seed::Literal{ALLOWLIST_SEED} + Seed::AccountKey{index: 1}` (mint).
  Asserts the Anchor-derived address equals `get_extra_account_metas_address`.

`state.rs` adds `mint` and `bump` beyond the two fields `work.md` §4.3 lists —
`bump` for PDA signing/verification, `mint` so `add_address`/`remove_address` can
re-derive seeds without the caller passing the mint.

`initialize_allowlist` is also an addition; `work.md` §8 lists only four
instruction files but never says how the allowlist PDA gets created.

### `execute` and `lib.rs` — landed

`instructions/execute.rs` and the real `lib.rs` are on disk; `anchor build` is
green and produces `target/deploy/transfer_hook.so` plus the IDL.

Two pre-existing compile errors in `initialize_extra_account_meta_list.rs` had to
be cleared first — they had been masked by the missing `execute` module, so the
"cargo check is green" note above predates that file:

- `COption` was unimported; now `anchor_lang::solana_program::program_option::COption`.
- Anchor 1.1.2's `CpiContext::new` takes a `Pubkey`, not an `AccountInfo`. It is
  now `ctx.accounts.system_program.key()`. Worth remembering — this differs from
  every pre-1.0 Anchor example.

The custom discriminator works as designed. IDL shows `execute` =
`[105, 37, 101, 197, 75, 251, 102, 26]` = `sha256("spl-transfer-hook-interface:execute")[..8]`,
not the Anchor `global:execute` value. Token-2022 dispatches to it directly; no
`fallback` routing hack.

### Design used for `execute`

Account order is fixed by the interface: `source_token` (0), `mint` (1),
`destination_token` (2), `owner` (3), `extra_account_meta_list` (4), then extras
from index 5 — here just `allowlist`.

Three points that matter and are easy to get wrong:

1. **Do not** put a `token::authority = owner` constraint on `source_token`. On a
   permanent-delegate clawback the authority is the delegate, not the token
   account owner, and that constraint would make the clawback demo fail account
   validation instead of running the allowlist check. `owner` stays an
   `UncheckedAccount`.
2. Guard against direct invocation by asserting
   `TransferHookAccount::transferring` is true on both token accounts. Token-2022
   sets this flag only for the duration of the transfer CPI. Without it the
   instruction is callable outside a transfer.
3. Check allowlist membership against the token accounts' **owners** (wallets),
   not the token account addresses — the allowlist stores wallet pubkeys.

Carries `#[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]`
— on the handler fn inside `#[program]`, not on the `Accounts` struct.

### litesvm tests — done, 11 passing

`programs/transfer-hook/tests/common/mod.rs` (harness) and
`tests/allowlist_hook.rs` (the tests). Covers auth gating on add/remove,
duplicate and unknown-address rejection, transfer pass/fail for non-allowlisted
sender and recipient, revocation blocking a later transfer, and direct-call
rejection via the transferring flag.

Transfers go through a real Token-2022 `transfer_checked`, so the hook runs as a
genuine CPI. Three things that cost time and are easy to get wrong again:

1. Extra-account tail order for `transfer_checked` is
   `[…extras, hook_program_id, validation_account]` — the resolved extras come
   *first*, then the program and validation account. Confirmed against
   `spl_transfer_hook_interface::offchain::add_extra_account_metas_for_execute`;
   built by hand in the harness because that helper is async.
2. Token accounts must be sized for `ExtensionType::TransferHookAccount` or
   `InitializeAccount3` rejects them. That extension holds the `transferring`
   flag.
3. The harness calls `svm.expire_blockhash()` before every send. Several tests
   submit byte-identical transactions; without it the VM returns
   `AlreadyProcessed` before the program runs, which would look like a passing
   negative test that never reached the allowlist check.

The harness `include_bytes!`es `target/deploy/transfer_hook.so`, so `anchor build`
must precede `cargo test`. `anchor test` already orders it that way.

### Consequence for the clawback demo

Because `execute` runs on the permanent-delegate path too, the **issuer must be
on its own allowlist** or clawback transfers will be rejected by the hook. Worth
calling out explicitly in `docs/walkthrough.md`.

## Cluster targets — settled 2026-07-29

Two hard constraints, both verified rather than assumed:

1. **No local validator, ever, on this machine.** The CPU (Intel Pentium 5405U)
   has no AVX; `/proc/cpuinfo` stops at `sse4_2`. `solana-test-validator` aborts
   with `Incompatible CPU detected: missing AVX support` and dumps core. This is
   hardware, not config. It retroactively justifies `skip_local_validator = true`
   in `Anchor.toml` — that was not merely an Anchor 1.1.2 template quirk.
2. **The ZK ElGamal proof program is disabled on devnet and mainnet.**

   | Gate | devnet | mainnet |
   |---|---|---|
   | `zkhiy…tnv` enable (SIMD-0153) | active, epoch 801 | active |
   | `zkdo…rnC` disable | active, epoch 899 | active, epoch 805 |
   | `zkes…FMW` reenable | inactive | inactive |

   The program guards on `disable && !reenable` and returns
   `InvalidInstructionData` with `"zk-elgamal-proof program is temporarily disabled"`.
   litesvm boots `FeatureSet::all_enabled()`, activating *both* gates, so the
   guard is false and the program runs. Confirmed by probe, not by reading alone.
   Re-check before trusting — it is designed to be reversed.

Decision: **split targets.**

| Work | Target |
|---|---|
| #4 mint creation, #5 allowlist + transfers, #7 clawback | devnet, TypeScript scripts |
| #6 confidential transfer flow | litesvm, Rust tests |

This departs from `work.md` §8, which puts the confidential flow in `scripts/`
as TypeScript. It cannot run there. Creating a mint *with* the
`ConfidentialTransferMint` extension is still fine on devnet — initializing the
extension needs no proof; only `ConfigureAccount` and the transfers themselves
touch the proof program.

Devnet wallet: `2oE9AWmKKzJ2xMdJe4ay3wxebRxvYH27aymb3ZBMLFj2`, funded 3.37 SOL.

## Task list state

| # | Task | Status |
|---|---|---|
| 1 | Scaffold workspace + resolve Token-2022 dep versions | done |
| 2 | Implement transfer-hook program (allowlist + execute) | done |
| 3 | litesvm tests for hook program | done — 11 tests, all passing |
| 4 | Mint creation script (Token-2022, 3 extensions) | pending — devnet |
| 5 | Allowlist setup + demo transfer scripts | pending — devnet |
| 6 | Confidential transfer flow | pending — litesvm, not devnet |
| 7 | Permanent delegate clawback script | pending — devnet |
| 8 | Indexer (Axum + Helius webhooks) | pending |
| 9 | Astro + Tailwind frontend | pending |
| 10 | Docs: walkthrough + deep-dive + README | pending |

## Next, in order

1. `git init` — see housekeeping, do this before the TypeScript tree lands so the
   scaffold arrives as a first commit rather than untracked.
2. Task #4, `scripts/create-mint.ts`. Nothing TypeScript exists yet: no
   `scripts/`, no `package.json`, no `node_modules`. Bootstrap that first
   (`package.json`, `tsconfig.json`, `@solana/web3.js`, `@solana/spl-token`, a
   `tsx` runner), then the script itself. Two things it must get right:
   - All three extension initializers run **before** `InitializeMint2`, and mint
     space comes from `getMintLen([TransferHook, ConfidentialTransferMint, PermanentDelegate])`
     computed up front.
   - `createInitializeConfidentialTransferMintInstruction` is absent from older
     `@solana/spl-token` releases, which pins the dependency version.
3. Task #5 setup-allowlist. Add the issuer to its own allowlist immediately after
   `initialize_allowlist` — see the clawback consequence above; leaving it to a
   later script means the clawback demo fails.
4. Task #6 confidential flow as Rust litesvm tests, per the cluster split.

Open question for the deep-dive, unresolved: confidential transfers do not route
through `TransferChecked`, so whether the hook fires on the confidential path is
unknown. If it does not, the allowlist guarantee has a hole worth documenting
plainly — that interaction is the thinnest-documented part of the whole stack and
is the most valuable thing this repo could answer.

## Housekeeping

The repo is **not** a git repo yet (`anchor init` ran with `--no-git`). Worth a
`git init` before the next round of changes.
