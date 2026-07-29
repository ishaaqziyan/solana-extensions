use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{constants::ALLOWLIST_SEED, state::Allowlist};

#[derive(Accounts)]
pub struct InitializeAllowlist<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Issuer key that will gate `add_address` / `remove_address`.
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = Allowlist::SPACE,
        seeds = [ALLOWLIST_SEED, mint.key().as_ref()],
        bump
    )]
    pub allowlist: Account<'info, Allowlist>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_allowlist(ctx: Context<InitializeAllowlist>) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;
    allowlist.authority = ctx.accounts.authority.key();
    allowlist.mint = ctx.accounts.mint.key();
    allowlist.bump = ctx.bumps.allowlist;
    allowlist.addresses = Vec::new();

    msg!("Allowlist initialized for mint {}", allowlist.mint);
    Ok(())
}
