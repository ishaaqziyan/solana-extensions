//! End-to-end tests for the allowlist transfer hook, driven through a real
//! Token-2022 `transfer_checked` so the hook runs as a genuine CPI.

mod common;

use anchor_lang::prelude::Pubkey;
use common::{custom_error_code, Env, DECIMALS};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_transfer_hook_interface::get_extra_account_metas_address;
use transfer_hook::{error::HookError, ID as HOOK_PROGRAM_ID};

const ONE_TOKEN: u64 = 10u64.pow(DECIMALS as u32);

#[test]
fn setup_creates_allowlist_and_validation_account() {
    let env = Env::new();

    let allowlist = env.allowlist_state();
    assert_eq!(allowlist.authority, env.issuer.pubkey());
    assert_eq!(allowlist.mint, env.mint);
    assert!(allowlist.addresses.is_empty());

    // The validation account must live at the address Token-2022 derives, or the
    // hook CPI never resolves the extra accounts.
    assert_eq!(
        env.extra_account_meta_list,
        get_extra_account_metas_address(&env.mint, &HOOK_PROGRAM_ID)
    );
    let validation = env
        .svm
        .get_account(&env.extra_account_meta_list)
        .expect("validation account missing");
    assert_eq!(validation.owner, HOOK_PROGRAM_ID);
    assert!(!validation.data.is_empty());
}

#[test]
fn authority_can_add_and_remove_addresses() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();
    let first = Pubkey::new_unique();
    let second = Pubkey::new_unique();

    env.add_address(&first, &issuer).unwrap();
    env.add_address(&second, &issuer).unwrap();
    let state = env.allowlist_state();
    assert_eq!(state.addresses, vec![first, second]);

    env.remove_address(&first, &issuer).unwrap();
    // `swap_remove` leaves the tail element in the vacated slot.
    assert_eq!(env.allowlist_state().addresses, vec![second]);
}

#[test]
fn add_address_rejects_non_authority() {
    let mut env = Env::new();
    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();

    let result = env.add_address(&Pubkey::new_unique(), &intruder);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::UnauthorizedAuthority)
    );
}

#[test]
fn remove_address_rejects_non_authority() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();
    let target = Pubkey::new_unique();
    env.add_address(&target, &issuer).unwrap();

    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();

    let result = env.remove_address(&target, &intruder);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::UnauthorizedAuthority)
    );
    assert_eq!(env.allowlist_state().addresses, vec![target]);
}

#[test]
fn add_address_rejects_duplicates() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();
    let target = Pubkey::new_unique();

    env.add_address(&target, &issuer).unwrap();
    let result = env.add_address(&target, &issuer);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::AddressAlreadyPresent)
    );
}

#[test]
fn remove_address_rejects_unknown_address() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let result = env.remove_address(&Pubkey::new_unique(), &issuer);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::AddressNotFound)
    );
}

#[test]
fn transfer_succeeds_when_both_parties_allowlisted() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (sender, sender_token) = env.new_holder();
    let (recipient, recipient_token) = env.new_holder();
    env.mint_to(&sender_token, 10 * ONE_TOKEN);

    env.add_address(&sender.pubkey(), &issuer).unwrap();
    env.add_address(&recipient.pubkey(), &issuer).unwrap();

    env.transfer(&sender_token, &recipient_token, &sender, 3 * ONE_TOKEN)
        .expect("allowlisted transfer should succeed");

    assert_eq!(env.token_balance(&sender_token), 7 * ONE_TOKEN);
    assert_eq!(env.token_balance(&recipient_token), 3 * ONE_TOKEN);
}

#[test]
fn transfer_fails_when_sender_not_allowlisted() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (sender, sender_token) = env.new_holder();
    let (recipient, recipient_token) = env.new_holder();
    env.mint_to(&sender_token, 10 * ONE_TOKEN);

    env.add_address(&recipient.pubkey(), &issuer).unwrap();

    let result = env.transfer(&sender_token, &recipient_token, &sender, ONE_TOKEN);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::SenderNotAllowlisted)
    );
    assert_eq!(env.token_balance(&sender_token), 10 * ONE_TOKEN);
    assert_eq!(env.token_balance(&recipient_token), 0);
}

#[test]
fn transfer_fails_when_recipient_not_allowlisted() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (sender, sender_token) = env.new_holder();
    let (_recipient, recipient_token) = env.new_holder();
    env.mint_to(&sender_token, 10 * ONE_TOKEN);

    env.add_address(&sender.pubkey(), &issuer).unwrap();

    let result = env.transfer(&sender_token, &recipient_token, &sender, ONE_TOKEN);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::RecipientNotAllowlisted)
    );
    assert_eq!(env.token_balance(&sender_token), 10 * ONE_TOKEN);
}

#[test]
fn removing_the_sender_blocks_further_transfers() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (sender, sender_token) = env.new_holder();
    let (recipient, recipient_token) = env.new_holder();
    env.mint_to(&sender_token, 10 * ONE_TOKEN);

    env.add_address(&sender.pubkey(), &issuer).unwrap();
    env.add_address(&recipient.pubkey(), &issuer).unwrap();
    env.transfer(&sender_token, &recipient_token, &sender, ONE_TOKEN)
        .expect("first transfer should succeed");

    env.remove_address(&sender.pubkey(), &issuer).unwrap();

    let result = env.transfer(&sender_token, &recipient_token, &sender, ONE_TOKEN);
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::SenderNotAllowlisted)
    );
    assert_eq!(env.token_balance(&recipient_token), ONE_TOKEN);
}

#[test]
fn execute_rejects_direct_invocation() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (sender, sender_token) = env.new_holder();
    let (recipient, recipient_token) = env.new_holder();
    env.mint_to(&sender_token, 10 * ONE_TOKEN);

    // Both allowlisted, so the only thing that can reject this call is the
    // `transferring` flag guard.
    env.add_address(&sender.pubkey(), &issuer).unwrap();
    env.add_address(&recipient.pubkey(), &issuer).unwrap();

    let result = env.execute_directly(
        &sender_token,
        &recipient_token,
        &sender.pubkey(),
        ONE_TOKEN,
    );
    assert_eq!(
        custom_error_code(result),
        u32::from(HookError::NotTransferring)
    );
}
