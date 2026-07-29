use anchor_lang::prelude::*;

use crate::{
    constants::{ALLOWLIST_SEED, MAX_ALLOWLIST_ADDRESSES},
    error::HookError,
    state::Allowlist,
};

#[derive(Accounts)]
pub struct AddAddress<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOWLIST_SEED, allowlist.mint.as_ref()],
        bump = allowlist.bump,
        has_one = authority @ HookError::UnauthorizedAuthority,
    )]
    pub allowlist: Account<'info, Allowlist>,
}

pub fn handle_add_address(ctx: Context<AddAddress>, address: Pubkey) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;

    require!(
        !allowlist.contains(&address),
        HookError::AddressAlreadyPresent
    );
    require!(
        allowlist.addresses.len() < MAX_ALLOWLIST_ADDRESSES,
        HookError::AllowlistFull
    );

    allowlist.addresses.push(address);

    msg!("Allowlisted {}", address);
    Ok(())
}
