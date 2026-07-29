use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("Sender is not on the allowlist")]
    SenderNotAllowlisted,
    #[msg("Recipient is not on the allowlist")]
    RecipientNotAllowlisted,
    #[msg("Address is already on the allowlist")]
    AddressAlreadyPresent,
    #[msg("Address is not on the allowlist")]
    AddressNotFound,
    #[msg("Allowlist is at capacity")]
    AllowlistFull,
    #[msg("Signer is not the allowlist authority")]
    UnauthorizedAuthority,
    #[msg("Program called outside of a Token-2022 transfer")]
    NotTransferring,
    #[msg("Derived validation account does not match the transfer hook interface address")]
    ValidationAccountMismatch,
}
