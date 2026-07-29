use anchor_lang::prelude::*;

use crate::{constants::ALLOWLIST_SEED, error::HookError, state::Allowlist};

#[derive(Accounts)]
pub struct RemoveAddress<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOWLIST_SEED, allowlist.mint.as_ref()],
        bump = allowlist.bump,
        has_one = authority @ HookError::UnauthorizedAuthority,
    )]
    pub allowlist: Account<'info, Allowlist>,
}

pub fn handle_remove_address(ctx: Context<RemoveAddress>, address: Pubkey) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;

    let index = allowlist
        .addresses
        .iter()
        .position(|entry| entry == &address)
        .ok_or(HookError::AddressNotFound)?;

    allowlist.addresses.swap_remove(index);

    msg!("Removed {} from allowlist", address);
    Ok(())
}
