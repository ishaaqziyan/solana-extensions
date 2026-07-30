/**
 * Reads and decrypts the `ConfidentialTransferAccount` extension.
 *
 * `@solana/spl-token` knows the extension's `ExtensionType` (5) and can hand
 * back its raw TLV bytes via `getExtensionData`, but ships no struct decoder
 * for it — same gap as the instruction side (see `zkProofHelpers.ts`).
 *
 * Field layout is `ConfidentialTransferAccount` from
 * `spl-token-2022-interface`'s `extension/confidential_transfer/mod.rs`
 * (`#[repr(C)]`, all fields byte-aligned, no padding):
 *
 * ```
 * offset  size  field
 * 0       1     approved                                  (bool)
 * 1       32    elgamal_pubkey
 * 33      64    pending_balance_lo                         (ElGamal ciphertext)
 * 97      64    pending_balance_hi                          (ElGamal ciphertext)
 * 161     64    available_balance                           (ElGamal ciphertext)
 * 225     36    decryptable_available_balance               (AeCiphertext)
 * 261     1     allow_confidential_credits                 (bool)
 * 262     1     allow_non_confidential_credits              (bool)
 * 263     8     pending_balance_credit_counter              (u64 LE)
 * 271     8     maximum_pending_balance_credit_counter      (u64 LE)
 * 279     8     expected_pending_balance_credit_counter     (u64 LE)
 * 287     8     actual_pending_balance_credit_counter       (u64 LE)
 * ```
 * total 295 bytes.
 */
import { type AccountInfo, PublicKey } from '@solana/web3.js';
import { ExtensionType, getExtensionData, unpackAccount, unpackMint } from '@solana/spl-token';
import {
    AeCiphertext,
    AeKey,
    ElGamalCiphertext,
    ElGamalKeypair,
    ElGamalPubkey,
} from '@solana/zk-sdk/bundler';

export interface ConfidentialTransferAccountState {
    approved: boolean;
    elgamalPubkey: Uint8Array;
    pendingBalanceLo: ElGamalCiphertext;
    pendingBalanceHi: ElGamalCiphertext;
    availableBalance: ElGamalCiphertext;
    decryptableAvailableBalance: AeCiphertext;
    allowConfidentialCredits: boolean;
    allowNonConfidentialCredits: boolean;
    pendingBalanceCreditCounter: bigint;
    maximumPendingBalanceCreditCounter: bigint;
    expectedPendingBalanceCreditCounter: bigint;
    actualPendingBalanceCreditCounter: bigint;
}

export function decodeConfidentialTransferAccount(
    tokenAccount: PublicKey,
    accountInfo: AccountInfo<Buffer>,
): ConfidentialTransferAccountState | null {
    const account = unpackAccount(tokenAccount, accountInfo);
    const tlv = getExtensionData(ExtensionType.ConfidentialTransferAccount, account.tlvData);
    if (!tlv) return null;

    const readCiphertext = (offset: number) => {
        const ciphertext = ElGamalCiphertext.fromBytes(tlv.subarray(offset, offset + 64));
        if (!ciphertext) throw new Error(`invalid ElGamal ciphertext at offset ${offset}`);
        return ciphertext;
    };
    const readU64 = (offset: number) => tlv.readBigUInt64LE(offset);

    const decryptableAvailableBalance = AeCiphertext.fromBytes(tlv.subarray(225, 261));
    if (!decryptableAvailableBalance) {
        throw new Error('invalid AeCiphertext for decryptable_available_balance');
    }

    return {
        approved: tlv[0] !== 0,
        elgamalPubkey: new Uint8Array(tlv.subarray(1, 33)),
        pendingBalanceLo: readCiphertext(33),
        pendingBalanceHi: readCiphertext(97),
        availableBalance: readCiphertext(161),
        decryptableAvailableBalance,
        allowConfidentialCredits: tlv[261] !== 0,
        allowNonConfidentialCredits: tlv[262] !== 0,
        pendingBalanceCreditCounter: readU64(263),
        maximumPendingBalanceCreditCounter: readU64(271),
        expectedPendingBalanceCreditCounter: readU64(279),
        actualPendingBalanceCreditCounter: readU64(287),
    };
}

export interface HolderKeys {
    elgamal: ElGamalKeypair;
    aes: AeKey;
}

/**
 * Derives both confidential-transfer keys from two wallet signatures — no
 * local storage, no separate secret to back up. The holder can always
 * recover the same keys for the same token account by reconnecting the same
 * wallet and signing again.
 *
 * Two distinct messages, hence two signature prompts: the ElGamal and AES
 * keys are deliberately independent secrets, matching how real Solana
 * wallets derive confidential-transfer keys today.
 */
export async function deriveHolderKeys(
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
    tokenAccount: PublicKey,
): Promise<HolderKeys> {
    const seed = tokenAccount.toBytes();

    const elgamalMessage = ElGamalKeypair.signerMessage(seed);
    const elgamalSignature = await signMessage(elgamalMessage);
    const elgamal = ElGamalKeypair.fromSignature(elgamalSignature);

    const aesMessage = AeKey.signerMessage(seed);
    const aesSignature = await signMessage(aesMessage);
    const aes = AeKey.fromSignature(aesSignature);

    return { elgamal, aes };
}

/**
 * `ConfidentialTransferMint` layout (`extension/confidential_transfer/mod.rs`):
 * `authority: OptionalNonZeroPubkey`(32) + `auto_approve_new_accounts: PodBool`(1)
 * + `auditor_elgamal_pubkey: OptionalNonZeroElGamalPubkey`(32) = 65 bytes.
 *
 * `auditorElgamalPubkey` is never `null` here — an unset auditor is encoded
 * as 32 zero bytes, which happens to be ristretto255's canonical encoding of
 * the identity point (a real, decodable `ElGamalPubkey`), matching
 * `ElGamalPubkey::default()` in the Rust proof-generation crate. Passing it
 * through unmodified is exactly what `transfer_split_proof_data` does when
 * no auditor is configured.
 */
export function decodeConfidentialTransferMintAuditor(
    mint: PublicKey,
    accountInfo: AccountInfo<Buffer>,
): ElGamalPubkey {
    const state = unpackMint(mint, accountInfo);
    const tlv = getExtensionData(ExtensionType.ConfidentialTransferMint, state.tlvData);
    if (!tlv) {
        throw new Error(`Mint ${mint.toBase58()} has no ConfidentialTransferMint extension`);
    }
    return ElGamalPubkey.fromBytes(tlv.subarray(33, 65));
}
