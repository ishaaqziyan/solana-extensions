use anchor_lang::prelude::*;

use crate::constants::MAX_ALLOWLIST_ADDRESSES;

/// Protocol-level allowlist for a single mint, read by `execute` on every
/// transfer and mutated only by `authority`.
#[account]
pub struct Allowlist {
    /// The only key allowed to add or remove addresses.
    pub authority: Pubkey,
    /// Mint this allowlist governs, also the second PDA seed.
    pub mint: Pubkey,
    /// Canonical bump for `["allowlist", mint]`.
    pub bump: u8,
    /// Approved wallet addresses (token account owners, not token accounts).
    pub addresses: Vec<Pubkey>,
}

impl Allowlist {
    /// discriminator + authority + mint + bump + vec length + max elements
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 4 + MAX_ALLOWLIST_ADDRESSES * 32;

    pub fn contains(&self, address: &Pubkey) -> bool {
        self.addresses.contains(address)
    }
}
