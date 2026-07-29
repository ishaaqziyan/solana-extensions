use anchor_lang::prelude::*;

/// Seed prefix for the `Allowlist` PDA: `["allowlist", mint]`.
#[constant]
pub const ALLOWLIST_SEED: &[u8] = b"allowlist";

/// Seed prefix for the validation account the transfer hook interface reads.
///
/// The interface keeps its own copy of this seed private and only exposes it
/// through `get_extra_account_metas_address`, so this constant is mirrored here
/// to let Anchor derive the PDA declaratively. Both instructions that touch the
/// account assert the derived address matches the interface helper, so a change
/// upstream fails loudly instead of silently writing to the wrong PDA.
#[constant]
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Maximum number of addresses the MVP allowlist holds.
///
/// A flat `Vec<Pubkey>` is deliberate at demo scale. The bitmap / merkle-proof
/// upgrade path for larger sets is written up in `docs/extensions-deep-dive.md`.
pub const MAX_ALLOWLIST_ADDRESSES: usize = 64;
