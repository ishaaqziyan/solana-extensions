//! Shared litesvm harness: a Token-2022 mint with the transfer hook extension
//! pointing at this program, plus the allowlist and validation accounts.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{system_instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token_interface::spl_token_2022::{
    extension::{transfer_hook as transfer_hook_extension, ExtensionType},
    instruction as token_ix,
    state::{Account as TokenAccountState, Mint as MintState},
    ID as TOKEN_2022_ID,
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_transfer_hook_interface::get_extra_account_metas_address;

use transfer_hook::{
    accounts as hook_accounts, constants::ALLOWLIST_SEED, instruction as hook_ix, state::Allowlist,
    ID as HOOK_PROGRAM_ID,
};

/// Built by `anchor build`. Run that before `cargo test` or this fails to compile.
const HOOK_ELF: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/transfer_hook.so"
));

pub const DECIMALS: u8 = 6;

pub struct Env {
    pub svm: LiteSVM,
    /// Fee payer, mint authority, and allowlist authority.
    pub issuer: Keypair,
    pub mint: Pubkey,
    pub allowlist: Pubkey,
    pub extra_account_meta_list: Pubkey,
}

impl Env {
    /// Boots the VM, deploys the hook, creates the mint, and initializes both
    /// the allowlist and the validation account. The allowlist starts empty.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(HOOK_PROGRAM_ID, HOOK_ELF)
            .expect("failed to load transfer_hook.so");

        let issuer = Keypair::new();
        svm.airdrop(&issuer.pubkey(), 100 * 1_000_000_000).unwrap();

        let mint_keypair = Keypair::new();
        let mint = mint_keypair.pubkey();

        let (allowlist, _) =
            Pubkey::find_program_address(&[ALLOWLIST_SEED, mint.as_ref()], &HOOK_PROGRAM_ID);
        let extra_account_meta_list = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);

        let mut env = Self {
            svm,
            issuer,
            mint,
            allowlist,
            extra_account_meta_list,
        };

        env.create_mint(&mint_keypair);
        env.initialize_allowlist();
        env.initialize_extra_account_meta_list();
        env
    }

    /// Token-2022 mint carrying `TransferHook` (wired to this program) and
    /// `PermanentDelegate` (the issuer), matching the devnet mint minus the
    /// confidential-transfer extension, which needs no hook involvement.
    ///
    /// Every extension initializer must run before `InitializeMint2`.
    fn create_mint(&mut self, mint_keypair: &Keypair) {
        let space = ExtensionType::try_calculate_account_len::<MintState>(&[
            ExtensionType::TransferHook,
            ExtensionType::PermanentDelegate,
        ])
        .unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let issuer = self.issuer.pubkey();

        let instructions = [
            system_instruction::create_account(
                &issuer,
                &self.mint,
                lamports,
                space as u64,
                &TOKEN_2022_ID,
            ),
            transfer_hook_extension::instruction::initialize(
                &TOKEN_2022_ID,
                &self.mint,
                Some(issuer),
                Some(HOOK_PROGRAM_ID),
            )
            .unwrap(),
            token_ix::initialize_permanent_delegate(&TOKEN_2022_ID, &self.mint, &issuer).unwrap(),
            token_ix::initialize_mint2(&TOKEN_2022_ID, &self.mint, &issuer, None, DECIMALS).unwrap(),
        ];

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&instructions, &[&issuer_keypair, mint_keypair])
            .expect("mint creation failed");
    }

    fn initialize_allowlist(&mut self) {
        let issuer = self.issuer.pubkey();
        let instruction = Instruction {
            program_id: HOOK_PROGRAM_ID,
            accounts: hook_accounts::InitializeAllowlist {
                payer: issuer,
                authority: issuer,
                mint: self.mint,
                allowlist: self.allowlist,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_ix::InitializeAllowlist {}.data(),
        };

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&[instruction], &[&issuer_keypair])
            .expect("initialize_allowlist failed");
    }

    fn initialize_extra_account_meta_list(&mut self) {
        let issuer = self.issuer.pubkey();
        let instruction = Instruction {
            program_id: HOOK_PROGRAM_ID,
            accounts: hook_accounts::InitializeExtraAccountMetaList {
                payer: issuer,
                authority: issuer,
                mint: self.mint,
                extra_account_meta_list: self.extra_account_meta_list,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hook_ix::InitializeExtraAccountMetaList {}.data(),
        };

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&[instruction], &[&issuer_keypair])
            .expect("initialize_extra_account_meta_list failed");
    }

    /// The first signer pays.
    ///
    /// Advances the blockhash first: several tests send byte-identical
    /// transactions (retrying an add, or transferring twice), which the VM would
    /// otherwise reject as `AlreadyProcessed` before the program ever runs.
    pub fn send(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let message = Message::new(instructions, Some(&payer));
        let transaction = Transaction::new(signers, message, self.svm.latest_blockhash());
        self.svm.send_transaction(transaction)
    }

    /// Funded wallet with an empty token account for the mint.
    ///
    /// The account is sized for `TransferHookAccount`, which Token-2022 requires
    /// on every account of a hooked mint — that extension holds the
    /// `transferring` flag `execute` guards on.
    pub fn new_holder(&mut self) -> (Keypair, Pubkey) {
        let wallet = Keypair::new();
        self.svm
            .airdrop(&wallet.pubkey(), 10 * 1_000_000_000)
            .unwrap();

        let token_keypair = Keypair::new();
        let token_account = token_keypair.pubkey();

        let space = ExtensionType::try_calculate_account_len::<TokenAccountState>(&[
            ExtensionType::TransferHookAccount,
        ])
        .unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let issuer = self.issuer.pubkey();

        let instructions = [
            system_instruction::create_account(
                &issuer,
                &token_account,
                lamports,
                space as u64,
                &TOKEN_2022_ID,
            ),
            token_ix::initialize_account3(
                &TOKEN_2022_ID,
                &token_account,
                &self.mint,
                &wallet.pubkey(),
            )
            .unwrap(),
        ];

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&instructions, &[&issuer_keypair, &token_keypair])
            .expect("token account creation failed");

        (wallet, token_account)
    }

    pub fn mint_to(&mut self, token_account: &Pubkey, amount: u64) {
        let issuer = self.issuer.pubkey();
        let instruction = token_ix::mint_to(
            &TOKEN_2022_ID,
            &self.mint,
            token_account,
            &issuer,
            &[],
            amount,
        )
        .unwrap();

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&[instruction], &[&issuer_keypair])
            .expect("mint_to failed");
    }

    pub fn add_address(&mut self, address: &Pubkey, authority: &Keypair) -> TransactionResult {
        let instruction = Instruction {
            program_id: HOOK_PROGRAM_ID,
            accounts: hook_accounts::AddAddress {
                authority: authority.pubkey(),
                allowlist: self.allowlist,
            }
            .to_account_metas(None),
            data: hook_ix::AddAddress { address: *address }.data(),
        };
        let authority = authority.insecure_clone();
        self.send(&[instruction], &[&authority])
    }

    pub fn remove_address(&mut self, address: &Pubkey, authority: &Keypair) -> TransactionResult {
        let instruction = Instruction {
            program_id: HOOK_PROGRAM_ID,
            accounts: hook_accounts::RemoveAddress {
                authority: authority.pubkey(),
                allowlist: self.allowlist,
            }
            .to_account_metas(None),
            data: hook_ix::RemoveAddress { address: *address }.data(),
        };
        let authority = authority.insecure_clone();
        self.send(&[instruction], &[&authority])
    }

    /// `transfer_checked` with the hook's extra accounts appended.
    ///
    /// The tail order is fixed by the transfer hook interface: first the extras
    /// resolved from the validation account (here just the allowlist), then the
    /// hook program id, then the validation account itself. This mirrors what
    /// `spl_transfer_hook_interface::offchain::add_extra_account_metas_for_execute`
    /// builds; it is done by hand because that helper is async and the resolved
    /// set here is a single known PDA.
    pub fn transfer(
        &mut self,
        source: &Pubkey,
        destination: &Pubkey,
        owner: &Keypair,
        amount: u64,
    ) -> TransactionResult {
        let mut instruction = token_ix::transfer_checked(
            &TOKEN_2022_ID,
            source,
            &self.mint,
            destination,
            &owner.pubkey(),
            &[],
            amount,
            DECIMALS,
        )
        .unwrap();

        instruction
            .accounts
            .push(AccountMeta::new_readonly(self.allowlist, false));
        instruction
            .accounts
            .push(AccountMeta::new_readonly(HOOK_PROGRAM_ID, false));
        instruction
            .accounts
            .push(AccountMeta::new_readonly(self.extra_account_meta_list, false));

        let issuer_keypair = self.issuer.insecure_clone();
        let owner = owner.insecure_clone();
        self.send(&[instruction], &[&issuer_keypair, &owner])
    }

    /// Permanent-delegate clawback: the issuer moves a holder's tokens with only
    /// its own signature. The holder's keypair is deliberately not involved.
    pub fn clawback(
        &mut self,
        source: &Pubkey,
        destination: &Pubkey,
        amount: u64,
    ) -> TransactionResult {
        let issuer = self.issuer.pubkey();
        let mut instruction = token_ix::transfer_checked(
            &TOKEN_2022_ID,
            source,
            &self.mint,
            destination,
            &issuer,
            &[],
            amount,
            DECIMALS,
        )
        .unwrap();

        instruction
            .accounts
            .push(AccountMeta::new_readonly(self.allowlist, false));
        instruction
            .accounts
            .push(AccountMeta::new_readonly(HOOK_PROGRAM_ID, false));
        instruction
            .accounts
            .push(AccountMeta::new_readonly(self.extra_account_meta_list, false));

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&[instruction], &[&issuer_keypair])
    }

    /// Calls `execute` directly rather than through a Token-2022 transfer, which
    /// is what the `transferring` flag guard exists to reject.
    pub fn execute_directly(
        &mut self,
        source: &Pubkey,
        destination: &Pubkey,
        owner: &Pubkey,
        amount: u64,
    ) -> TransactionResult {
        let mut instruction = spl_transfer_hook_interface::instruction::execute(
            &HOOK_PROGRAM_ID,
            source,
            &self.mint,
            destination,
            owner,
            amount,
        );
        instruction
            .accounts
            .push(AccountMeta::new_readonly(self.extra_account_meta_list, false));
        instruction
            .accounts
            .push(AccountMeta::new_readonly(self.allowlist, false));

        let issuer_keypair = self.issuer.insecure_clone();
        self.send(&[instruction], &[&issuer_keypair])
    }

    pub fn allowlist_state(&self) -> Allowlist {
        let account = self
            .svm
            .get_account(&self.allowlist)
            .expect("allowlist account missing");
        Allowlist::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn token_balance(&self, token_account: &Pubkey) -> u64 {
        let account = self
            .svm
            .get_account(token_account)
            .expect("token account missing");
        // Amount is at offset 64 of the base account layout, ahead of any
        // extension TLV data.
        u64::from_le_bytes(account.data[64..72].try_into().unwrap())
    }
}

/// Extracts the custom program error code from a failed transaction.
pub fn custom_error_code(result: TransactionResult) -> u32 {
    match result.expect_err("expected the transaction to fail").err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => code,
        other => panic!("expected a custom program error, got {other:?}"),
    }
}
