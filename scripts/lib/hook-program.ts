import { createHash } from 'node:crypto';

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import { HOOK_PROGRAM_ID } from './config.js';

/** Mirrors `constants.rs`. */
export const ALLOWLIST_SEED = Buffer.from('allowlist');
export const EXTRA_ACCOUNT_METAS_SEED = Buffer.from('extra-account-metas');

/**
 * Anchor's default instruction discriminator: first 8 bytes of
 * `sha256("global:<snake_case_name>")`.
 *
 * `execute` is deliberately absent here — it carries the transfer hook
 * interface discriminator instead, and is never invoked from the client. Only
 * Token-2022 calls it, by CPI.
 */
function discriminator(name: string): Buffer {
    return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export function findAllowlist(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([ALLOWLIST_SEED, mint.toBuffer()], HOOK_PROGRAM_ID)[0];
}

/**
 * The validation account Token-2022 reads to learn which extra accounts to pass
 * into the hook CPI. The interface derives this address itself, so the seed
 * must match `EXTRA_ACCOUNT_METAS_SEED` exactly.
 */
export function findExtraAccountMetaList(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()],
        HOOK_PROGRAM_ID,
    )[0];
}

export function createInitializeAllowlistInstruction(
    payer: PublicKey,
    authority: PublicKey,
    mint: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: HOOK_PROGRAM_ID,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: findAllowlist(mint), isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: discriminator('initialize_allowlist'),
    });
}

export function createInitializeExtraAccountMetaListInstruction(
    payer: PublicKey,
    authority: PublicKey,
    mint: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: HOOK_PROGRAM_ID,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: findExtraAccountMetaList(mint), isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: discriminator('initialize_extra_account_meta_list'),
    });
}

function addressInstruction(
    name: 'add_address' | 'remove_address',
    authority: PublicKey,
    mint: PublicKey,
    address: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: HOOK_PROGRAM_ID,
        keys: [
            { pubkey: authority, isSigner: true, isWritable: false },
            { pubkey: findAllowlist(mint), isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([discriminator(name), address.toBuffer()]),
    });
}

export function createAddAddressInstruction(
    authority: PublicKey,
    mint: PublicKey,
    address: PublicKey,
): TransactionInstruction {
    return addressInstruction('add_address', authority, mint, address);
}

export function createRemoveAddressInstruction(
    authority: PublicKey,
    mint: PublicKey,
    address: PublicKey,
): TransactionInstruction {
    return addressInstruction('remove_address', authority, mint, address);
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
