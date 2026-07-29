//! Confidential transfer flow (`work.md` §4.4), run under litesvm.
//!
//! This cannot run on devnet or mainnet: the ZK ElGamal proof program is
//! feature-disabled on both (`disable_zk_elgamal_proof_program` active,
//! `reenable_…` inactive). litesvm boots `FeatureSet::all_enabled()`, which
//! activates both gates, so the program's `disable && !reenable` guard is false
//! and it runs.
//!
//! litesvm's bundled Token-2022 program also has `zk-ops` compiled out
//! (matches the verified mainnet binary, built `--no-default-features`), which
//! would fail every value-moving confidential instruction regardless of the
//! proof-program gate. `common::Env` swaps in a `zk-ops`-enabled build; see
//! the comment on `TOKEN_2022_ZK_OPS_ELF` there.
//!
//! The mint here carries TransferHook, ConfidentialTransferMint, and
//! PermanentDelegate together — the point of the project is what happens when
//! they are stacked, not each in isolation. That stacking is why the transfer
//! below appends the hook's extra accounts: Token-2022 invokes the transfer
//! hook on confidential transfers exactly as it does on plain ones.
//!
//! Note: `spl-token-2022-interface` 2.1.0 ships no `account_info` helper module
//! (`ApplyPendingBalanceAccountInfo`, `TransferAccountInfo` live in the program
//! crate, not the interface crate), so the balance arithmetic here is done
//! against the raw `ConfidentialTransferAccount` fields.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_interface::spl_token_2022::{
    extension::{
        confidential_transfer::{
            instruction as confidential_ix, ConfidentialTransferAccount,
            PENDING_BALANCE_LO_BIT_LENGTH,
        },
        BaseStateWithExtensions, PodStateWithExtensions,
    },
    pod::PodAccount,
    ID as TOKEN_2022_ID,
};
use common::{Env, DECIMALS};
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;
use transfer_hook::ID as HOOK_PROGRAM_ID;
use solana_zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalCiphertext, ElGamalKeypair},
    },
    zk_elgamal_proof_program::proof_data::PubkeyValidityProofData,
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use spl_token_confidential_transfer_proof_generation::transfer::transfer_split_proof_data;

const ONE_TOKEN: u64 = 10u64.pow(DECIMALS as u32);

/// A holder's client-side keys. Both are generated locally and never leave the
/// client — that is what makes the balance confidential. Real wallets derive
/// them deterministically from a signature; random is fine here.
struct HolderKeys {
    elgamal: ElGamalKeypair,
    aes: AeKey,
}

impl HolderKeys {
    fn new() -> Self {
        Self {
            elgamal: ElGamalKeypair::new_rand(),
            aes: AeKey::new_rand(),
        }
    }
}

fn confidential_state(env: &Env, token_account: &Pubkey) -> ConfidentialTransferAccount {
    let account = env.svm.get_account(token_account).expect("account missing");
    let state = PodStateWithExtensions::<PodAccount>::unpack(&account.data).unwrap();
    *state
        .get_extension::<ConfidentialTransferAccount>()
        .expect("account is not configured for confidential transfers")
}

/// Decrypts the available balance using the holder's AES key.
///
/// Token-2022 keeps the available balance twice: once ElGamal-encrypted for
/// homomorphic arithmetic, and once AES-encrypted purely so the owner can read
/// it cheaply. This reads the second.
fn available_balance(env: &Env, token_account: &Pubkey, keys: &HolderKeys) -> u64 {
    let state = confidential_state(env, token_account);
    let ciphertext: AeCiphertext = state.decryptable_available_balance.try_into().unwrap();
    ciphertext.decrypt(&keys.aes).expect("decrypt available balance")
}

/// Decrypts the pending balance, which is only ElGamal-encrypted.
///
/// Split across two ciphertexts — low 16 bits and high 32 — because ElGamal
/// decryption is a discrete-log search and stays tractable only over a small
/// range. Recombining is `lo + hi << 16`.
fn pending_balance(env: &Env, token_account: &Pubkey, keys: &HolderKeys) -> u64 {
    let state = confidential_state(env, token_account);
    let secret = keys.elgamal.secret();

    let lo: ElGamalCiphertext = state.pending_balance_lo.try_into().unwrap();
    let hi: ElGamalCiphertext = state.pending_balance_hi.try_into().unwrap();

    let lo = secret.decrypt_u32(&lo).expect("decrypt pending lo");
    let hi = secret.decrypt_u32(&hi).expect("decrypt pending hi");

    lo + (hi << PENDING_BALANCE_LO_BIT_LENGTH)
}

/// `ConfigureAccount`, with the pubkey-validity proof supplied inline.
///
/// The proof rides in the same transaction at instruction offset 1, and the
/// token instruction reaches it through the instructions sysvar. This is the
/// simplest of the three proof-delivery modes; a transfer needs three proofs
/// and cannot always use it.
fn configure_account(env: &mut Env, wallet: &Keypair, token_account: &Pubkey, keys: &HolderKeys) {
    let proof = PubkeyValidityProofData::new(&keys.elgamal).expect("pubkey validity proof");

    let instructions = confidential_ix::configure_account(
        &TOKEN_2022_ID,
        token_account,
        &env.mint,
        &keys.aes.encrypt(0).into(),
        u16::MAX.into(),
        &wallet.pubkey(),
        &[],
        ProofLocation::InstructionOffset(1.try_into().unwrap(), &proof),
    )
    .expect("configure_account");

    let issuer = env.issuer.insecure_clone();
    let wallet = wallet.insecure_clone();
    env.send(&instructions, &[&issuer, &wallet])
        .expect("ConfigureAccount failed");
}

/// Moves public tokens into the confidential pending balance, then applies that
/// pending balance so it becomes spendable.
fn deposit_and_apply(
    env: &mut Env,
    wallet: &Keypair,
    token_account: &Pubkey,
    keys: &HolderKeys,
    amount: u64,
) {
    let deposit = confidential_ix::deposit(
        &TOKEN_2022_ID,
        token_account,
        &env.mint,
        amount,
        DECIMALS,
        &wallet.pubkey(),
        &[],
    )
    .expect("deposit");

    let issuer = env.issuer.insecure_clone();
    let signer = wallet.insecure_clone();
    env.send(&[deposit], &[&issuer, &signer])
        .expect("Deposit failed");

    // Applying the pending balance is a separate, holder-initiated step. That is
    // deliberate anti-griefing design: nobody can force decryption work on a
    // recipient by spamming tiny transfers, because the recipient decides when
    // to fold pending into available.
    let state = confidential_state(env, token_account);
    let new_available =
        available_balance(env, token_account, keys) + pending_balance(env, token_account, keys);

    let apply = confidential_ix::apply_pending_balance(
        &TOKEN_2022_ID,
        token_account,
        state.pending_balance_credit_counter.into(),
        &keys.aes.encrypt(new_available).into(),
        &wallet.pubkey(),
        &[],
    )
    .expect("apply_pending_balance");

    let signer = wallet.insecure_clone();
    env.send(&[apply], &[&issuer, &signer])
        .expect("ApplyPendingBalance failed");
}

#[test]
fn deposit_hides_the_balance_from_everyone_but_the_owner() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (alice, alice_token) = env.new_holder();
    env.add_address(&alice.pubkey(), &issuer).unwrap();
    env.mint_to(&alice_token, 10 * ONE_TOKEN);

    let keys = HolderKeys::new();
    configure_account(&mut env, &alice, &alice_token, &keys);
    deposit_and_apply(&mut env, &alice, &alice_token, &keys, 4 * ONE_TOKEN);

    // The public balance dropped by the deposited amount...
    assert_eq!(env.token_balance(&alice_token), 6 * ONE_TOKEN);

    // ...and the deposit is now readable only with Alice's key.
    assert_eq!(available_balance(&env, &alice_token, &keys), 4 * ONE_TOKEN);

    // The confidentiality claim, tested rather than asserted: a different key
    // cannot read the balance.
    let stranger = HolderKeys::new();
    let state = confidential_state(&env, &alice_token);
    let ciphertext: AeCiphertext = state.decryptable_available_balance.try_into().unwrap();
    assert!(
        ciphertext.decrypt(&stranger.aes).is_none(),
        "balance decrypted with the wrong key"
    );
}

#[test]
fn confidential_transfer_moves_value_without_revealing_the_amount() {
    let mut env = Env::new();
    let issuer = env.issuer.insecure_clone();

    let (alice, alice_token) = env.new_holder();
    let (bob, bob_token) = env.new_holder();
    env.add_address(&alice.pubkey(), &issuer).unwrap();
    env.add_address(&bob.pubkey(), &issuer).unwrap();
    env.mint_to(&alice_token, 10 * ONE_TOKEN);

    let alice_keys = HolderKeys::new();
    let bob_keys = HolderKeys::new();
    configure_account(&mut env, &alice, &alice_token, &alice_keys);
    configure_account(&mut env, &bob, &bob_token, &bob_keys);
    deposit_and_apply(&mut env, &alice, &alice_token, &alice_keys, 8 * ONE_TOKEN);

    let transfer_amount = 3 * ONE_TOKEN;
    let state = confidential_state(&env, &alice_token);

    // Three proofs: the new source balance is consistent with the old one
    // (equality), the amount is encrypted correctly to all parties
    // (ciphertext validity), and no value was conjured or hidden by overflow
    // (range).
    let proofs = transfer_split_proof_data(
        &state.available_balance.try_into().unwrap(),
        &state.decryptable_available_balance.try_into().unwrap(),
        transfer_amount,
        &alice_keys.elgamal,
        &alice_keys.aes,
        bob_keys.elgamal.pubkey(),
        None, // no auditor configured on this mint
    )
    .expect("transfer proof generation");

    let remaining = 8 * ONE_TOKEN - transfer_amount;
    let instructions = confidential_ix::transfer(
        &TOKEN_2022_ID,
        &alice_token,
        &env.mint,
        &bob_token,
        &alice_keys.aes.encrypt(remaining).into(),
        &proofs
            .ciphertext_validity_proof_data_with_ciphertext
            .ciphertext_lo,
        &proofs
            .ciphertext_validity_proof_data_with_ciphertext
            .ciphertext_hi,
        &alice.pubkey(),
        &[],
        ProofLocation::InstructionOffset(1.try_into().unwrap(), &proofs.equality_proof_data),
        ProofLocation::InstructionOffset(
            2.try_into().unwrap(),
            &proofs
                .ciphertext_validity_proof_data_with_ciphertext
                .proof_data,
        ),
        ProofLocation::InstructionOffset(3.try_into().unwrap(), &proofs.range_proof_data),
    )
    .expect("transfer instructions");

    // The mint carries `TransferHook`, so this program's `execute` runs on every
    // value-moving transfer, confidential ones included — that stacking is the
    // whole point of the project. `instructions[0]` is the actual
    // `ConfidentialTransferInstruction::Transfer`; the rest are sibling
    // proof-verify instructions the token program reads via the instructions
    // sysvar, not accounts it takes directly.
    let mut instructions = instructions;
    instructions[0]
        .accounts
        .push(AccountMeta::new_readonly(env.allowlist, false));
    instructions[0]
        .accounts
        .push(AccountMeta::new_readonly(HOOK_PROGRAM_ID, false));
    instructions[0]
        .accounts
        .push(AccountMeta::new_readonly(env.extra_account_meta_list, false));

    let issuer_keypair = env.issuer.insecure_clone();
    let signer = alice.insecure_clone();
    if let Err(failed) = env.send(&instructions, &[&issuer_keypair, &signer]) {
        panic!(
            "confidential transfer failed: {:?}\nlogs:\n{}",
            failed.err,
            failed.meta.logs.join("\n")
        );
    }

    // Alice's confidential balance fell by the transfer amount.
    assert_eq!(available_balance(&env, &alice_token, &alice_keys), remaining);

    // Bob received it into his pending balance, not his available one.
    assert_eq!(pending_balance(&env, &bob_token, &bob_keys), transfer_amount);

    // Public balances are untouched throughout: the value moved entirely inside
    // the confidential ledger, and the chain never saw the amount.
    assert_eq!(env.token_balance(&alice_token), 2 * ONE_TOKEN);
    assert_eq!(env.token_balance(&bob_token), 0);
}
