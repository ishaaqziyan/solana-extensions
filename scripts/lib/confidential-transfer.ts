import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

/**
 * Hand-rolled `InitializeConfidentialTransferMint`.
 *
 * `@solana/spl-token` 0.4.15 knows the extension exists — `ExtensionType.
 * ConfidentialTransferMint = 4`, so `getMintLen` sizes for it correctly — but
 * ships no instruction builder and no `extensions/confidentialTransfer/`
 * directory at all. There is no first-party JS package that provides one, so
 * this encodes the instruction directly.
 *
 * Layout, from `spl-token-2022-interface` `encode_instruction` plus
 * `confidential_transfer::instruction::InitializeMintData`:
 *
 * ```
 * [0]      u8   TokenInstruction::ConfidentialTransferExtension = 27
 * [1]      u8   ConfidentialTransferInstruction::InitializeMint = 0
 * [2..34]  [u8; 32]  authority             (OptionalNonZeroPubkey, all-zero = None)
 * [34]     u8        autoApproveNewAccounts (PodBool)
 * [35..67] [u8; 32]  auditorElGamalPubkey  (OptionalNonZeroElGamalPubkey, all-zero = None)
 * ```
 *
 * `OptionalNonZeroPubkey` has no discriminant byte: the all-zero value *is*
 * `None`. That is why this is 67 bytes rather than the 69 a borsh `Option`
 * would produce.
 */
export const TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION = 27;
export const CONFIDENTIAL_TRANSFER_INITIALIZE_MINT = 0;

export interface InitializeConfidentialTransferMintArgs {
    mint: PublicKey;
    /** May reconfigure the extension and approve accounts. Null leaves it unset forever. */
    authority: PublicKey | null;
    /**
     * When false, every holder's `ConfigureAccount` must be approved by
     * `authority` before they can transact confidentially.
     */
    autoApproveNewAccounts: boolean;
    /**
     * Holds the audit decryption capability over every confidential transfer
     * amount. This is the tradeoff `work.md` §4.4 exists to demonstrate:
     * confidential from the public, not from the regulator-equivalent role.
     */
    auditorElGamalPubkey: Uint8Array | null;
    programId?: PublicKey;
}

export function createInitializeConfidentialTransferMintInstruction({
    mint,
    authority,
    autoApproveNewAccounts,
    auditorElGamalPubkey,
    programId = TOKEN_2022_PROGRAM_ID,
}: InitializeConfidentialTransferMintArgs): TransactionInstruction {
    if (auditorElGamalPubkey !== null && auditorElGamalPubkey.length !== 32) {
        throw new Error(
            `auditorElGamalPubkey must be 32 bytes, got ${auditorElGamalPubkey.length}`,
        );
    }

    const data = Buffer.alloc(67);
    data.writeUInt8(TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION, 0);
    data.writeUInt8(CONFIDENTIAL_TRANSFER_INITIALIZE_MINT, 1);
    if (authority !== null) {
        data.set(authority.toBytes(), 2);
    }
    data.writeUInt8(autoApproveNewAccounts ? 1 : 0, 34);
    if (auditorElGamalPubkey !== null) {
        data.set(auditorElGamalPubkey, 35);
    }

    return new TransactionInstruction({
        programId,
        keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
        data,
    });
}
