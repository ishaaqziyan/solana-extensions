# Extensions deep-dive

Design tradeoffs, one bug found and fixed, and the cluster constraints that
shaped where each piece of this demo runs. Written for a reader who already
knows the three extensions in the abstract and wants the parts that aren't
obvious from the docs.

## The clawback design flaw: sanctioning a holder made their tokens unseizable

`execute` (`programs/transfer-hook/src/instructions/execute.rs`) checks
allowlist membership against the token accounts' **owners**. On a
permanent-delegate clawback, the source owner is still the holder being
seized from — the delegate only replaces the transfer authority, not the
account owner. So the first version of this program required:

- the issuer allowlisted (destination owner) — already necessary, why
  `create-mint.ts` self-allowlists the issuer at mint creation, and
- **the holder also still allowlisted** — which is exactly what a sanctions
  response removes first.

That's backwards for a compliance token. The real sequence is *freeze, then
seize*; the original design only permitted *seize, then freeze*, leaving a
window where a sanctioned holder could still move funds before the seizure
lands.

This wasn't a bug in the demo scripts or a gap in the litesvm tests — the
suite already asserted this behavior
(`transfer_fails_when_sender_not_allowlisted`). It just hadn't been framed
as a clawback path until building `demo-clawback.ts` surfaced it.

### The fix

`execute` now exempts the permanent-delegate path, checked after the
`transferring` guard and before the allowlist check:

```rust
let delegate = permanent_delegate(&ctx.accounts.mint.to_account_info())?;
if delegate == Some(ctx.accounts.owner.key()) {
    msg!("Permanent delegate clawback of {} — allowlist not enforced", amount);
    return Ok(());
}
```

`permanent_delegate()` wraps the interface's `get_permanent_delegate`, which
returns `None` both when the extension is absent and when the delegate is
unset — a mint without the extension gets no exemption, and an all-zero
`OptionalNonZeroPubkey` can never match a real authority, so there's no
accidental universal bypass.

Ordering matters: the exemption sits *after* `require_transferring`, so a
direct call carrying a forged authority is rejected before the exemption is
even consulted. In a genuine transfer, Token-2022 has already verified the
delegate's signature by the time it invokes the hook — the exemption trusts
that verification, it doesn't repeat it.

Two tests cover this (`programs/transfer-hook/tests/allowlist_hook.rs`):

- `clawback_succeeds_even_when_the_holder_is_not_allowlisted` — fund,
  sanction, seize, with neither party allowlisted at seizure time.
- `clawback_exemption_does_not_leak_to_ordinary_transfers` — same accounts
  and amount, but the holder signs instead of the delegate; must still be
  rejected. This is the test that actually matters — an over-broad
  exemption would otherwise look identical to a passing test suite.

Deploying the fix grew the binary past its allocated programdata
(208,712 → 211,920 bytes), so a plain `anchor upgrade` wasn't enough:

```
solana program extend <program-id> 10240 -u devnet   # 8192 was rejected; 10240 is the minimum
anchor upgrade target/deploy/transfer_hook.so --program-id <program-id> --provider.cluster devnet
```

`demo-transfer` was re-run against the upgraded program afterward to
confirm the exemption didn't loosen anything else — unchanged.

## Confidential transfers do fire the hook

Open question going in: does a `ConfidentialTransferInstruction::Transfer`
invoke the transfer hook at all, or does the encrypted path bypass it?

Resolved in
`confidential_transfer_moves_value_without_revealing_the_amount`
(`programs/transfer-hook/tests/confidential.rs`): the test appends the
allowlist, hook program, and validation account to a confidential transfer
instruction the same way a plain `TransferChecked` would, and it succeeds
only when both parties are allowlisted. So the allowlist guarantee holds
across both transfer paths — there's no hole where switching a holder to
confidential transfers would let them route around the compliance check.

## Why the confidential flow can't run on devnet — three independent reasons

Any one of these would be enough on its own; all three apply.

1. **No local validator, ever, on this machine.** The CPU (Intel Pentium
   5405U) has no AVX — `/proc/cpuinfo` stops at `sse4_2`.
   `solana-test-validator` requires AVX and core-dumps on start
   (`Incompatible CPU detected: missing AVX support`). This is hardware,
   not configuration, and is why `Anchor.toml` sets
   `skip_local_validator = true` — not merely an Anchor 1.1.2 template
   default.

2. **The ZK ElGamal proof program is disabled on public clusters.**

   | Gate | devnet | mainnet |
   |---|---|---|
   | `zkhiy…tnv` enable (SIMD-0153) | active, epoch 801 | active |
   | `zkdo…rnC` disable | active, epoch 899 | active, epoch 805 |
   | `zkes…FMW` reenable | inactive | inactive |

   The program guards on `disable && !reenable` and returns
   `InvalidInstructionData` ("zk-elgamal-proof program is temporarily
   disabled") whenever that holds — which it currently does on both
   devnet and mainnet. `ConfigureAccount` and confidential transfers both
   need this program; only mint-level initialization of the
   `ConfidentialTransferMint` extension does not, which is why
   `create-mint.ts` can still create a mint with the extension enabled on
   devnet.

   litesvm boots with `FeatureSet::all_enabled()`, which activates *both*
   the disable and reenable gates — the guard's `!reenable` term goes
   false, so the check passes and the program runs. This was confirmed by
   probing the running program, not by reading the gate list alone, since
   the combination of "both gates active" is easy to get backwards by
   inspection. It's designed to be reversible — re-check before trusting
   this if picking the project back up much later.

3. **`@solana/spl-token` has no confidential-transfer support.** Version
   0.4.15 ships no `extensions/confidentialTransfer/` module and no
   instruction builders for it, and there's no first-party alternative on
   npm. It does know `ExtensionType.ConfidentialTransferMint = 4`, so
   `getMintLen` sizes the mint account correctly — but that's the extent
   of it. `InitializeConfidentialTransferMint` is hand-encoded in
   `scripts/lib/confidential-transfer.ts`:

   ```
   [0]      u8        TokenInstruction::ConfidentialTransferExtension = 27
   [1]      u8        ConfidentialTransferInstruction::InitializeMint = 0
   [2..34]  [u8; 32]  authority              (OptionalNonZeroPubkey, all-zero = None)
   [34]     u8        autoApproveNewAccounts (PodBool)
   [35..67] [u8; 32]  auditorElGamalPubkey   (all-zero = None)
   ```

   67 bytes total, not the 69 a borsh `Option` encoding would produce —
   `OptionalNonZeroPubkey` carries no discriminant byte; all-zero bytes
   *are* the `None` representation. Validated independently by confirming
   `spl-token display` decodes the resulting mint correctly.

**Decision:** split targets by what each task needs.

| Work | Target |
|---|---|
| Mint creation, allowlist setup, transfers, clawback | devnet, TypeScript scripts |
| Confidential transfer flow | litesvm, Rust tests |

This departs from the original architecture doc, which placed the
confidential flow in `scripts/` as TypeScript. It can't run there for any
of the three reasons above.

## Allowlist upgrade path (cut from MVP)

The `Allowlist` account (`programs/transfer-hook/src/state.rs`) is a flat
`Vec<Pubkey>`, capped at `MAX_ALLOWLIST_ADDRESSES = 64`
(`programs/transfer-hook/src/constants.rs`), checked linearly in `execute`.
Fine at demo scale — a handful to a few dozen addresses — but doesn't scale:

- **Linear scan cost.** Every transfer pays `O(n)` compute for the
  membership check on both sender and recipient. At 64 entries this is
  cheap; at thousands it isn't, and compute budget becomes the limiting
  factor before storage does.
- **Account size ceiling.** A `Vec<Pubkey>` account has to be sized up
  front (or reallocated), and Solana account size has practical and
  economic limits — rent scales with space, and very large accounts get
  unwieldy to update atomically.

Two production upgrade paths, not built here because they add real
complexity without changing what this project demonstrates about hook
enforcement itself:

- **Bitmap allowlist** — for a bounded, pre-enumerable address space (e.g.
  KYC'd holders assigned dense indices by an off-chain system), a bitmap
  gives O(1) membership checks and compact storage, at the cost of needing
  an external index-assignment step.
- **Merkle-proof allowlist** — the allowlist root lives on-chain (32 bytes,
  fixed size regardless of list size); each transfer carries a Merkle proof
  of membership as instruction data. Scales to arbitrarily large allowlists
  with no per-transfer storage read of the full list, at the cost of the
  caller needing to fetch and supply a fresh proof (and the on-chain root
  needing an update whenever the off-chain set changes).

Either replaces `Allowlist.contains()` and the two `require!` checks in
`execute` — the rest of the hook (the `transferring` guard, the
permanent-delegate exemption, the account ordering) is unaffected.

## Clawback operational note

The issuer must be on its own allowlist before any clawback can succeed —
`execute` checks the destination owner too, and on a clawback the
destination is the issuer's own token account. `create-mint.ts` handles
this at mint creation time; a fresh deployment that skips that step (or a
setup that later removes the issuer from the allowlist for any reason)
will find every clawback attempt rejected with `RecipientNotAllowlisted`.
