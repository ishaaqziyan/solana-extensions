use anchor_lang::{
    prelude::*,
    solana_program::program_option::COption,
    system_program::{create_account, CreateAccount},
};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::{
    get_extra_account_metas_address, instruction::ExecuteInstruction,
};

use crate::{
    constants::{ALLOWLIST_SEED, EXTRA_ACCOUNT_METAS_SEED},
    error::HookError,
};

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Mint authority, matching what the transfer hook interface expects to sign
    /// for validation-account setup.
    #[account(
        constraint = mint.mint_authority == COption::Some(authority.key())
            @ HookError::UnauthorizedAuthority,
    )]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: created and written by this instruction; the interface defines the
    /// layout, so it is deliberately not an Anchor account type.
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// The extra accounts Token-2022 must pass into the `execute` CPI beyond the
/// four the interface always sends.
///
/// One entry: the `Allowlist` PDA, derived from the mint at account index 1 of
/// the execute account list (source = 0, mint = 1, destination = 2, owner = 3,
/// validation account = 4, extras from 5).
fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: ALLOWLIST_SEED.to_vec(),
            },
            Seed::AccountKey { index: 1 },
        ],
        false, // is_signer
        false, // is_writable
    )?])
}

pub fn handle_initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    // The interface keeps its seed private and only exposes the address helper,
    // so assert our mirrored seed still derives the address Token-2022 will look
    // for. A mismatch here means an upstream seed change, not a caller error.
    require_keys_eq!(
        ctx.accounts.extra_account_meta_list.key(),
        get_extra_account_metas_address(&mint_key, ctx.program_id),
        HookError::ValidationAccountMismatch
    );

    let metas = extra_account_metas()?;
    let account_size = ExtraAccountMetaList::size_of(metas.len())?;
    let lamports = Rent::get()?.minimum_balance(account_size);

    let bump = &[ctx.bumps.extra_account_meta_list];
    let signer_seeds: &[&[&[u8]]] = &[&[EXTRA_ACCOUNT_METAS_SEED, mint_key.as_ref(), bump]];

    create_account(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.extra_account_meta_list.to_account_info(),
            },
        )
        .with_signer(signer_seeds),
        lamports,
        account_size as u64,
        ctx.program_id,
    )?;

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;

    msg!("Validation account initialized for mint {}", mint_key);
    Ok(())
}
