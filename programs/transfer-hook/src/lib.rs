use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("DLfQ9dhxsXkur98Vze8L1sPHc14pVhkpdNSQqP3Qa3Bo");

#[program]
pub mod transfer_hook {
    use super::*;

    /// Create the `["allowlist", mint]` PDA that `execute` reads on every
    /// transfer.
    pub fn initialize_allowlist(ctx: Context<InitializeAllowlist>) -> Result<()> {
        handle_initialize_allowlist(ctx)
    }

    pub fn add_address(ctx: Context<AddAddress>, address: Pubkey) -> Result<()> {
        handle_add_address(ctx, address)
    }

    pub fn remove_address(ctx: Context<RemoveAddress>, address: Pubkey) -> Result<()> {
        handle_remove_address(ctx, address)
    }

    /// Write the validation account Token-2022 reads to learn which extra
    /// accounts to pass into `execute`.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        handle_initialize_extra_account_meta_list(ctx)
    }

    /// Invoked by Token-2022 during every transfer of this mint.
    ///
    /// Carries the transfer hook interface's own discriminator instead of an
    /// Anchor-derived one, so Token-2022's CPI dispatches here directly. The
    /// payload after the discriminator is a bare `amount: u64` LE, which matches
    /// borsh, so no manual deserialization is needed.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        handle_execute(ctx, amount)
    }
}
