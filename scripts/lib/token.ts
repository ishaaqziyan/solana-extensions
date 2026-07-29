import {
    Connection,
    Keypair,
    PublicKey,
    SendTransactionError,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    TOKEN_2022_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createMintToInstruction,
    createTransferCheckedWithTransferHookInstruction,
    getAccount,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { DECIMALS } from './config.js';

/** Human-readable amount to base units. */
export function toBaseUnits(amount: number): bigint {
    return BigInt(Math.round(amount * 10 ** DECIMALS));
}

export function fromBaseUnits(amount: bigint): string {
    return (Number(amount) / 10 ** DECIMALS).toFixed(DECIMALS);
}

export function ataFor(mint: PublicKey, owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
}

/**
 * Creates the holder's associated token account if missing.
 *
 * The ATA program sizes the account for whatever extensions the mint requires —
 * here `TransferHookAccount`, which carries the `transferring` flag the hook's
 * `execute` guards on. Doing this by hand means calling `getAccountLen` with
 * that extension explicitly, which is easy to forget and fails at
 * `InitializeAccount3` rather than at transfer time.
 */
export async function ensureTokenAccount(
    connection: Connection,
    payer: Keypair,
    mint: PublicKey,
    owner: PublicKey,
): Promise<PublicKey> {
    const ata = ataFor(mint, owner);
    const transaction = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            ata,
            owner,
            mint,
            TOKEN_2022_PROGRAM_ID,
        ),
    );
    await sendAndConfirmTransaction(connection, transaction, [payer]);
    return ata;
}

export async function mintTo(
    connection: Connection,
    issuer: Keypair,
    mint: PublicKey,
    destination: PublicKey,
    amount: bigint,
): Promise<string> {
    const transaction = new Transaction().add(
        createMintToInstruction(
            mint,
            destination,
            issuer.publicKey,
            amount,
            [],
            TOKEN_2022_PROGRAM_ID,
        ),
    );
    return sendAndConfirmTransaction(connection, transaction, [issuer]);
}

export async function balanceOf(connection: Connection, tokenAccount: PublicKey): Promise<bigint> {
    const account = await getAccount(connection, tokenAccount, 'confirmed', TOKEN_2022_PROGRAM_ID);
    return account.amount;
}

/**
 * `transfer_checked` with the hook's extra accounts resolved and appended.
 *
 * `createTransferCheckedWithTransferHookInstruction` reads the mint's
 * TransferHook extension, fetches the validation account, and resolves the
 * declared extra accounts — here the allowlist PDA — appending them in the
 * order the interface requires. Worth using rather than appending by hand: it
 * is the same resolution path a real wallet would take, so it proves the
 * validation account is correctly formed and not just that we know the answer.
 */
export async function buildHookTransfer(
    connection: Connection,
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: bigint,
) {
    return createTransferCheckedWithTransferHookInstruction(
        connection,
        source,
        mint,
        destination,
        owner,
        amount,
        DECIMALS,
        [],
        'confirmed',
        TOKEN_2022_PROGRAM_ID,
    );
}

/** Anchor custom errors start at 6000; mirrors `HookError` in `error.rs`. */
export const HOOK_ERRORS: Record<number, string> = {
    6000: 'SenderNotAllowlisted',
    6001: 'RecipientNotAllowlisted',
    6002: 'AddressAlreadyPresent',
    6003: 'AddressNotFound',
    6004: 'AllowlistFull',
    6005: 'UnauthorizedAuthority',
    6006: 'NotTransferring',
    6007: 'ValidationAccountMismatch',
};

/**
 * Pulls the hook's error name out of a failed transaction.
 *
 * Returns null when the failure came from somewhere other than the hook, so
 * callers do not mistake an RPC or fee problem for a rejected transfer.
 */
export function hookErrorName(error: unknown): string | null {
    const logs =
        error instanceof SendTransactionError ? (error.logs ?? []).join('\n') : String(error);

    // Anchor logs the name directly when the program's error is surfaced.
    const named = /Error Code: (\w+)/.exec(logs);
    if (named?.[1]) return named[1];

    // Otherwise fall back to the raw code the runtime reports.
    const raw = /custom program error: 0x([0-9a-fA-F]+)/.exec(logs);
    if (raw?.[1]) {
        const code = parseInt(raw[1], 16);
        return HOOK_ERRORS[code] ?? `custom error ${code}`;
    }

    return null;
}
