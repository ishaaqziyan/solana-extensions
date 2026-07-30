/**
 * Client-side port of `spl-token-confidential-transfer-proof-generation`'s
 * `transfer_split_proof_data` (Rust, used in the litesvm tests at
 * `programs/transfer-hook/tests/confidential.rs`). No published JS/WASM
 * package does this orchestration — `@solana/zk-sdk` only exposes the
 * individual proof/primitive types this function combines. Ported by hand
 * from `confidential/proof-generation/src/transfer.rs` and
 * `confidential/proof-extraction/src/instruction.rs` in
 * `solana-program/token-2022` (tag `program@v10.0.0`, the same commit the
 * `zk-ops`-enabled litesvm test binary was built from — see
 * `programs/transfer-hook/tests/common/mod.rs`).
 *
 * One genuine gap: the on-chain program's ciphertext homomorphism
 * (`spl-token-confidential-transfer-ciphertext-arithmetic`) also has no WASM
 * binding. `ristretto255Subtract`/`Add`/`ScalarMultiply` below reimplement
 * the two operations this function needs directly against `@noble/curves`'
 * ristretto255 group — the same curve group `@solana/zk-sdk` binds, so a
 * `ElGamalCiphertext`'s `commitment`/`handle` (each a compressed ristretto
 * point) can be round-tripped through it losslessly.
 */
import { ristretto255 } from '@noble/curves/ed25519.js';
import {
    BatchedGroupedCiphertext3HandlesValidityProofData,
    BatchedRangeProofU128Data,
    CiphertextCommitmentEqualityProofData,
    ElGamalCiphertext,
    ElGamalKeypair,
    ElGamalPubkey,
    GroupedElGamalCiphertext3Handles,
    PedersenCommitment,
    PedersenOpening,
} from '@solana/zk-sdk/bundler';

/** `TRANSFER_AMOUNT_LO_BITS` in the Rust crate. */
const TRANSFER_AMOUNT_LO_BITS = 16;
/** `TRANSFER_AMOUNT_HI_BITS` in the Rust crate. */
const TRANSFER_AMOUNT_HI_BITS = 32;
/** `REMAINING_BALANCE_BIT_LENGTH` in the Rust crate. */
const REMAINING_BALANCE_BIT_LENGTH = 64;
/**
 * The four range-proof bit lengths (64 + 16 + 32 + 16) must sum to a power
 * of two; this padding term is what makes them add up to 128.
 */
const RANGE_PROOF_PADDING_BIT_LENGTH = 16;

function splitU64(amount: bigint, bitLength: number): { lo: bigint; hi: bigint } {
    const mask = (1n << BigInt(bitLength)) - 1n;
    return { lo: amount & mask, hi: amount >> BigInt(bitLength) };
}

function decodePoint(bytes: Uint8Array) {
    return ristretto255.Point.fromBytes(bytes);
}

/** Component-wise ristretto255 point subtraction of two 64-byte ElGamal ciphertexts. */
function ciphertextSubtract(a: ElGamalCiphertext, b: ElGamalCiphertext): ElGamalCiphertext {
    const aBytes = a.toBytes();
    const bBytes = b.toBytes();
    const commitment = decodePoint(aBytes.subarray(0, 32)).subtract(decodePoint(bBytes.subarray(0, 32)));
    const handle = decodePoint(aBytes.subarray(32, 64)).subtract(decodePoint(bBytes.subarray(32, 64)));
    const result = ElGamalCiphertext.fromBytes(concatBytes(commitment.toBytes(), handle.toBytes()));
    if (!result) throw new Error('ciphertext subtraction produced an invalid point');
    return result;
}

/** Component-wise ristretto255 scalar multiplication of a 64-byte ElGamal ciphertext. */
function ciphertextScalarMultiply(a: ElGamalCiphertext, scalar: bigint): ElGamalCiphertext {
    const aBytes = a.toBytes();
    const commitment = decodePoint(aBytes.subarray(0, 32)).multiply(scalar);
    const handle = decodePoint(aBytes.subarray(32, 64)).multiply(scalar);
    const result = ElGamalCiphertext.fromBytes(concatBytes(commitment.toBytes(), handle.toBytes()));
    if (!result) throw new Error('ciphertext scalar multiplication produced an invalid point');
    return result;
}

/** Component-wise ristretto255 point addition of two 64-byte ElGamal ciphertexts. */
function ciphertextAdd(a: ElGamalCiphertext, b: ElGamalCiphertext): ElGamalCiphertext {
    const aBytes = a.toBytes();
    const bBytes = b.toBytes();
    const commitment = decodePoint(aBytes.subarray(0, 32)).add(decodePoint(bBytes.subarray(0, 32)));
    const handle = decodePoint(aBytes.subarray(32, 64)).add(decodePoint(bBytes.subarray(32, 64)));
    const result = ElGamalCiphertext.fromBytes(concatBytes(commitment.toBytes(), handle.toBytes()));
    if (!result) throw new Error('ciphertext addition produced an invalid point');
    return result;
}

/** `try_combine_lo_hi_ciphertexts`: `lo + hi * 2^bitLength`. */
function combineLoHiCiphertexts(
    lo: ElGamalCiphertext,
    hi: ElGamalCiphertext,
    bitLength: number,
): ElGamalCiphertext {
    return ciphertextAdd(lo, ciphertextScalarMultiply(hi, 1n << BigInt(bitLength)));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * `GroupedElGamalCiphertext3Handles.toBytes()` is `commitment(32) ||
 * handle[0](32) || handle[1](32) || handle[2](32)` — see
 * `solana-zk-sdk`'s `grouped_elgamal.rs`. Handle order is (source,
 * destination, auditor), matching the constructor argument order below.
 */
function extractCommitment(grouped: GroupedElGamalCiphertext3Handles): PedersenCommitment {
    return PedersenCommitment.fromBytes(grouped.toBytes().subarray(0, 32));
}

function extractHandleCiphertext(
    grouped: GroupedElGamalCiphertext3Handles,
    handleIndex: 0 | 1 | 2,
): ElGamalCiphertext {
    const bytes = grouped.toBytes();
    const commitment = bytes.subarray(0, 32);
    const handleStart = 32 + 32 * handleIndex;
    const handle = bytes.subarray(handleStart, handleStart + 32);
    const ciphertext = ElGamalCiphertext.fromBytes(concatBytes(commitment, handle));
    if (!ciphertext) throw new Error(`invalid ciphertext at handle index ${handleIndex}`);
    return ciphertext;
}

export interface TransferProofData {
    equalityProofData: CiphertextCommitmentEqualityProofData;
    ciphertextValidityProofData: BatchedGroupedCiphertext3HandlesValidityProofData;
    /** The recipient+auditor-encrypted transfer amount, for `TransferInstructionData`. */
    transferAmountAuditorCiphertextLo: ElGamalCiphertext;
    transferAmountAuditorCiphertextHi: ElGamalCiphertext;
    rangeProofData: BatchedRangeProofU128Data;
}

/**
 * Generates the three proofs a confidential `Transfer` needs. Throws
 * `"insufficient confidential balance"` rather than letting the range proof
 * constructor fail opaquely on a negative remaining balance.
 */
export function transferSplitProofData(
    currentAvailableBalance: ElGamalCiphertext,
    currentDecryptableAvailableBalance: bigint,
    transferAmount: bigint,
    sourceElgamalKeypair: ElGamalKeypair,
    destinationElgamalPubkey: ElGamalPubkey,
    auditorElgamalPubkey: ElGamalPubkey,
): TransferProofData {
    const { lo: transferAmountLo, hi: transferAmountHi } = splitU64(
        transferAmount,
        TRANSFER_AMOUNT_LO_BITS,
    );

    const sourcePubkey = sourceElgamalKeypair.pubkey();
    const openingLo = new PedersenOpening();
    const openingHi = new PedersenOpening();
    const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
        sourcePubkey,
        destinationElgamalPubkey,
        auditorElgamalPubkey,
        transferAmountLo,
        openingLo,
    );
    const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
        sourcePubkey,
        destinationElgamalPubkey,
        auditorElgamalPubkey,
        transferAmountHi,
        openingHi,
    );

    if (currentDecryptableAvailableBalance < transferAmount) {
        throw new Error('insufficient confidential balance');
    }
    const newDecryptedAvailableBalance = currentDecryptableAvailableBalance - transferAmount;

    const newAvailableBalanceOpening = new PedersenOpening();
    const newAvailableBalanceCommitment = PedersenCommitment.from(
        newDecryptedAvailableBalance,
        newAvailableBalanceOpening,
    );

    // Handle index 0 is the source's own decrypt handle — see the comment on
    // `extractCommitment` for the (source, destination, auditor) ordering.
    const transferAmountSourceCiphertextLo = extractHandleCiphertext(groupedLo, 0);
    const transferAmountSourceCiphertextHi = extractHandleCiphertext(groupedHi, 0);
    const newAvailableBalanceCiphertext = ciphertextSubtract(
        currentAvailableBalance,
        combineLoHiCiphertexts(
            transferAmountSourceCiphertextLo,
            transferAmountSourceCiphertextHi,
            TRANSFER_AMOUNT_LO_BITS,
        ),
    );

    const equalityProofData = new CiphertextCommitmentEqualityProofData(
        sourceElgamalKeypair,
        newAvailableBalanceCiphertext,
        newAvailableBalanceCommitment,
        newAvailableBalanceOpening,
        newDecryptedAvailableBalance,
    );

    const ciphertextValidityProofData = new BatchedGroupedCiphertext3HandlesValidityProofData(
        sourcePubkey,
        destinationElgamalPubkey,
        auditorElgamalPubkey,
        groupedLo,
        groupedHi,
        transferAmountLo,
        transferAmountHi,
        openingLo,
        openingHi,
    );

    // Handle index 2 is the auditor's — these ride in `TransferInstructionData`
    // so an auditor (if one is configured on the mint) can decrypt the amount.
    const transferAmountAuditorCiphertextLo = extractHandleCiphertext(groupedLo, 2);
    const transferAmountAuditorCiphertextHi = extractHandleCiphertext(groupedHi, 2);

    // The four range-proof bit lengths must sum to a power of two (128 here);
    // the padding commitment is a dummy commitment to 0 that exists only to
    // make the total come out even.
    const paddingOpening = new PedersenOpening();
    const paddingCommitment = PedersenCommitment.from(0n, paddingOpening);
    const rangeProofData = new BatchedRangeProofU128Data(
        [
            newAvailableBalanceCommitment,
            extractCommitment(groupedLo),
            extractCommitment(groupedHi),
            paddingCommitment,
        ],
        BigUint64Array.of(newDecryptedAvailableBalance, transferAmountLo, transferAmountHi, 0n),
        Uint8Array.of(
            REMAINING_BALANCE_BIT_LENGTH,
            TRANSFER_AMOUNT_LO_BITS,
            TRANSFER_AMOUNT_HI_BITS,
            RANGE_PROOF_PADDING_BIT_LENGTH,
        ),
        [newAvailableBalanceOpening, openingLo, openingHi, paddingOpening],
    );

    return {
        equalityProofData,
        ciphertextValidityProofData,
        transferAmountAuditorCiphertextLo,
        transferAmountAuditorCiphertextHi,
        rangeProofData,
    };
}
