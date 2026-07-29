use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    spl_token_2022::{
        extension::{
            transfer_hook::TransferHookAccount, BaseStateWithExtensions, PodStateWithExtensions,
        },
        pod::PodAccount,
    },
    Mint, TokenAccount,
};

use crate::{constants::{ALLOWLIST_SEED, EXTRA_ACCOUNT_METAS_SEED}, error::HookError, state::Allowlist};

/// Account order is dictated by the transfer hook interface and must not be
/// reordered: source (0), mint (1), destination (2), owner (3), validation
/// account (4), then the extras declared in the validation account from index 5.
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: deliberately unchecked. On a permanent-delegate clawback Token-2022
    /// passes the delegate here rather than the token account owner, so a
    /// `token::authority = owner` constraint would fail validation on exactly the
    /// path this token is built to support. Authorization is Token-2022's job;
    /// this program only decides whether the transfer is allowed.
    pub owner: UncheckedAccount<'info>,

    /// CHECK: interface-owned layout, validated by address derivation only.
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [ALLOWLIST_SEED, mint.key().as_ref()],
        bump = allowlist.bump,
    )]
    pub allowlist: Account<'info, Allowlist>,
}

/// Assert Token-2022 set the account's `transferring` flag.
///
/// The flag is only true for the duration of a transfer CPI, so this is what
/// stops anyone from calling `execute` directly to probe or grief the program.
fn require_transferring(account: &AccountInfo) -> Result<()> {
    let data = account.try_borrow_data()?;
    let state = PodStateWithExtensions::<PodAccount>::unpack(&data)?;
    let extension = state.get_extension::<TransferHookAccount>()?;

    require!(bool::from(extension.transferring), HookError::NotTransferring);
    Ok(())
}

pub fn handle_execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
    require_transferring(&ctx.accounts.source_token.to_account_info())?;
    require_transferring(&ctx.accounts.destination_token.to_account_info())?;

    let allowlist = &ctx.accounts.allowlist;

    // The allowlist stores wallet pubkeys, so compare against the token accounts'
    // owners rather than the token account addresses themselves.
    let sender = ctx.accounts.source_token.owner;
    let recipient = ctx.accounts.destination_token.owner;

    require!(allowlist.contains(&sender), HookError::SenderNotAllowlisted);
    require!(
        allowlist.contains(&recipient),
        HookError::RecipientNotAllowlisted
    );

    msg!("Transfer of {} approved: {} -> {}", amount, sender, recipient);
    Ok(())
}
