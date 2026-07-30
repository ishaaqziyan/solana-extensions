/**
 * Hand-rolled `ConfidentialTransferInstruction` builders — same reason as
 * `scripts/lib/confidential-transfer.ts`'s `InitializeMint` builder: no
 * first-party JS package ships these. Layouts are `ConfigureAccountInstructionData`,
 * `DepositInstructionData`, `ApplyPendingBalanceData`, `TransferInstructionData`
 * from `spl-token-2022-interface`'s `extension/confidential_transfer/instruction.rs`
 * (tag `program@v10.0.0`). Every builder here always uses `ProofLocation::InstructionOffset`
 * (proofs ride in sibling instructions in the same transaction) — never a
 * context-state account — matching `programs/transfer-hook/tests/confidential.rs`.
 */
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
    AeCiphertext,
    ElGamalCiphertext,
    ElGamalKeypair,
    PubkeyValidityProofData,
    type BatchedGroupedCiphertext3HandlesValidityProofData,
    type BatchedRangeProofU128Data,
    type CiphertextCommitmentEqualityProofData,
} from '@solana/zk-sdk/bundler';

const TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION = 27;
const enum ConfidentialTransferInstruction {
    ConfigureAccount = 2,
    Deposit = 5,
    Transfer = 7,
    ApplyPendingBalance = 8,
}

/**
 * `ZkE1Gama1Proof11111111111111111111111111111` — the ZK ElGamal proof
 * program's fixed address (`solana-sdk-ids`). Feature-disabled on devnet and
 * mainnet as of 2026-07-29; see `programs/transfer-hook/tests/confidential.rs`.
 */
export const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
    'ZkE1Gama1Proof11111111111111111111111111111',
);

const enum ProofInstructionOrdinal {
    VerifyCiphertextCommitmentEquality = 3,
    VerifyPubkeyValidity = 4,
    VerifyBatchedRangeProofU128 = 7,
    VerifyBatchedGroupedCiphertext3HandlesValidity = 12,
}

/**
 * Port of `ProofInstruction::encode_verify_proof` with `context_state_info:
 * None` — the proof rides entirely in this sibling instruction's data, no
 * context-state account created.
 */
function encodeVerifyProofInstruction(
    ordinal: ProofInstructionOrdinal,
    proofData: { toBytes(): Uint8Array },
): TransactionInstruction {
    return new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [],
        data: Buffer.concat([Buffer.from([ordinal]), proofData.toBytes()]),
    });
}

/**
 * `ConfigureAccount`, with the pubkey-validity proof as the very next
 * instruction (offset 1). Returns both instructions — send them together in
 * one transaction, in this order.
 */
export function createConfigureAccountInstructions(
    tokenAccount: PublicKey,
    mint: PublicKey,
    authority: PublicKey,
    elgamalKeypair: ElGamalKeypair,
    maximumPendingBalanceCreditCounter: bigint,
): TransactionInstruction[] {
    const proof = new PubkeyValidityProofData(elgamalKeypair);
    const zeroBalance = new Uint8Array(36); // AeCiphertext of 0 is all-zero bytes.

    const data = Buffer.alloc(2 + 36 + 8 + 1);
    data.writeUInt8(TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION, 0);
    data.writeUInt8(ConfidentialTransferInstruction.ConfigureAccount, 1);
    data.set(zeroBalance, 2);
    data.writeBigUInt64LE(maximumPendingBalanceCreditCounter, 38);
    data.writeInt8(1, 46); // proof_instruction_offset = 1 (the very next instruction)

    const configureAccount = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: authority, isSigner: true, isWritable: false },
        ],
        data,
    });

    return [
        configureAccount,
        encodeVerifyProofInstruction(ProofInstructionOrdinal.VerifyPubkeyValidity, proof),
    ];
}

/** `Deposit` — no proof needed; it only moves value into the *pending* (still encrypted) balance. */
export function createDepositInstruction(
    tokenAccount: PublicKey,
    mint: PublicKey,
    authority: PublicKey,
    amount: bigint,
    decimals: number,
): TransactionInstruction {
    const data = Buffer.alloc(2 + 8 + 1);
    data.writeUInt8(TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION, 0);
    data.writeUInt8(ConfidentialTransferInstruction.Deposit, 1);
    data.writeBigUInt64LE(amount, 2);
    data.writeUInt8(decimals, 10);

    return new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: authority, isSigner: true, isWritable: false },
        ],
        data,
    });
}

/** `ApplyPendingBalance` — folds the pending balance into the available one. No proof. */
export function createApplyPendingBalanceInstruction(
    tokenAccount: PublicKey,
    authority: PublicKey,
    expectedPendingBalanceCreditCounter: bigint,
    newDecryptableAvailableBalance: AeCiphertext,
): TransactionInstruction {
    const data = Buffer.alloc(2 + 8 + 36);
    data.writeUInt8(TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION, 0);
    data.writeUInt8(ConfidentialTransferInstruction.ApplyPendingBalance, 1);
    data.writeBigUInt64LE(expectedPendingBalanceCreditCounter, 2);
    data.set(newDecryptableAvailableBalance.toBytes(), 10);

    return new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: false },
        ],
        data,
    });
}

export interface TransferProofs {
    equalityProofData: CiphertextCommitmentEqualityProofData;
    ciphertextValidityProofData: BatchedGroupedCiphertext3HandlesValidityProofData;
    transferAmountAuditorCiphertextLo: ElGamalCiphertext;
    transferAmountAuditorCiphertextHi: ElGamalCiphertext;
    rangeProofData: BatchedRangeProofU128Data;
}

/**
 * `Transfer`, with its three proofs as the next three instructions (offsets
 * 1, 2, 3). Returns four instructions — send together, in order.
 *
 * Does **not** append the transfer-hook's extra accounts: the mint here
 * carries `TransferHook`, and Token-2022 invokes the hook on confidential
 * transfers exactly as it does on plain ones (verified in
 * `programs/transfer-hook/tests/confidential.rs`). Callers must append
 * `[allowlist, hookProgramId, extraAccountMetaList]` (all readonly) to the
 * returned `instructions[0]` before sending.
 */
export function createTransferInstructions(
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    newSourceDecryptableAvailableBalance: AeCiphertext,
    proofs: TransferProofs,
): TransactionInstruction[] {
    const data = Buffer.alloc(2 + 36 + 64 + 64 + 1 + 1 + 1);
    data.writeUInt8(TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION, 0);
    data.writeUInt8(ConfidentialTransferInstruction.Transfer, 1);
    data.set(newSourceDecryptableAvailableBalance.toBytes(), 2);
    data.set(proofs.transferAmountAuditorCiphertextLo.toBytes(), 38);
    data.set(proofs.transferAmountAuditorCiphertextHi.toBytes(), 102);
    data.writeInt8(1, 166); // equality proof: next instruction
    data.writeInt8(2, 167); // ciphertext validity proof: two after
    data.writeInt8(3, 168); // range proof: three after

    const transfer = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: authority, isSigner: true, isWritable: false },
        ],
        data,
    });

    return [
        transfer,
        encodeVerifyProofInstruction(
            ProofInstructionOrdinal.VerifyCiphertextCommitmentEquality,
            proofs.equalityProofData,
        ),
        encodeVerifyProofInstruction(
            ProofInstructionOrdinal.VerifyBatchedGroupedCiphertext3HandlesValidity,
            proofs.ciphertextValidityProofData,
        ),
        encodeVerifyProofInstruction(
            ProofInstructionOrdinal.VerifyBatchedRangeProofU128,
            proofs.rangeProofData,
        ),
    ];
}

/** Appends the transfer-hook's extra accounts to a confidential `Transfer` instruction in place. */
export function appendHookAccounts(
    transferInstruction: TransactionInstruction,
    allowlist: PublicKey,
    hookProgramId: PublicKey,
    extraAccountMetaList: PublicKey,
): void {
    transferInstruction.keys.push(
        { pubkey: allowlist, isSigner: false, isWritable: false },
        { pubkey: hookProgramId, isSigner: false, isWritable: false },
        { pubkey: extraAccountMetaList, isSigner: false, isWritable: false },
    );
}
