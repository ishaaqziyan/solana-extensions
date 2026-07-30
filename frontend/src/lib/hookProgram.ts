/**
 * Client-side instruction builders for the transfer-hook program's allowlist
 * instructions, ported from `scripts/lib/hook-program.ts`.
 *
 * Not reused directly: that file hashes Anchor's instruction discriminator
 * (`sha256("global:<name>")[0:8]`) at runtime via `node:crypto`, which
 * doesn't exist in a browser bundle. The discriminators are fixed for a
 * given instruction name, so they're precomputed here instead — verified to
 * match `scripts/lib/hook-program.ts`'s output byte-for-byte before pasting.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const ALLOWLIST_SEED = Buffer.from('allowlist');
export const EXTRA_ACCOUNT_METAS_SEED = Buffer.from('extra-account-metas');

const DISCRIMINATORS = {
    initialize_allowlist: Buffer.from('4d66269a36363a64', 'hex'),
    initialize_extra_account_meta_list: Buffer.from('5cc5aec5297c1303', 'hex'),
    add_address: Buffer.from('45bb40d8f472159e', 'hex'),
    remove_address: Buffer.from('b64e47dcfefe395c', 'hex'),
} as const;

export function findAllowlist(hookProgramId: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([ALLOWLIST_SEED, mint.toBuffer()], hookProgramId)[0];
}

export function findExtraAccountMetaList(hookProgramId: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()],
        hookProgramId,
    )[0];
}

export function createInitializeAllowlistInstruction(
    hookProgramId: PublicKey,
    payer: PublicKey,
    authority: PublicKey,
    mint: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: hookProgramId,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: findAllowlist(hookProgramId, mint), isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: DISCRIMINATORS.initialize_allowlist,
    });
}

export function createInitializeExtraAccountMetaListInstruction(
    hookProgramId: PublicKey,
    payer: PublicKey,
    authority: PublicKey,
    mint: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: hookProgramId,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            {
                pubkey: findExtraAccountMetaList(hookProgramId, mint),
                isSigner: false,
                isWritable: true,
            },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: DISCRIMINATORS.initialize_extra_account_meta_list,
    });
}

function addressInstruction(
    hookProgramId: PublicKey,
    name: 'add_address' | 'remove_address',
    authority: PublicKey,
    mint: PublicKey,
    address: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: hookProgramId,
        keys: [
            { pubkey: authority, isSigner: true, isWritable: false },
            { pubkey: findAllowlist(hookProgramId, mint), isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([DISCRIMINATORS[name], address.toBuffer()]),
    });
}

export function createAddAddressInstruction(
    hookProgramId: PublicKey,
    authority: PublicKey,
    mint: PublicKey,
    address: PublicKey,
): TransactionInstruction {
    return addressInstruction(hookProgramId, 'add_address', authority, mint, address);
}

export function createRemoveAddressInstruction(
    hookProgramId: PublicKey,
    authority: PublicKey,
    mint: PublicKey,
    address: PublicKey,
): TransactionInstruction {
    return addressInstruction(hookProgramId, 'remove_address', authority, mint, address);
}

export interface AllowlistState {
    authority: PublicKey;
    mint: PublicKey;
    bump: number;
    addresses: PublicKey[];
}

/** Decodes the `Allowlist` account: 8-byte discriminator, then the borsh body. */
export function decodeAllowlist(data: Buffer): AllowlistState {
    const authority = new PublicKey(data.subarray(8, 40));
    const mint = new PublicKey(data.subarray(40, 72));
    const bump = data.readUInt8(72);
    const length = data.readUInt32LE(73);

    const addresses: PublicKey[] = [];
    for (let i = 0; i < length; i++) {
        const start = 77 + i * 32;
        addresses.push(new PublicKey(data.subarray(start, start + 32)));
    }

    return { authority, mint, bump, addresses };
}
