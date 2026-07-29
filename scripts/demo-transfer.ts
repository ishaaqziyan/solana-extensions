/**
 * Proves the allowlist is enforced at the protocol level, not in the client.
 *
 * Run: `npm run demo-transfer`
 *
 * Creates two holders, mints to Alice, then attempts the same transfer three
 * times: with Bob off the allowlist (rejected), with Bob on it (succeeds), and
 * with Alice removed (rejected). The rejections come from the transfer hook
 * running inside Token-2022's CPI — nothing here is checking anything.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { explorerUrl, getConnection, loadDeployment, loadIssuer } from './lib/config.js';
import { loadOrCreateHolder } from './lib/holders.js';
import { createAddAddressInstruction, createRemoveAddressInstruction } from './lib/hook-program.js';
import {
    balanceOf,
    buildHookTransfer,
    ensureTokenAccount,
    fromBaseUnits,
    hookErrorName,
    mintTo,
    toBaseUnits,
} from './lib/token.js';

const MINT_AMOUNT = 1_000;
const TRANSFER_AMOUNT = 25;

async function main() {
    const connection = getConnection();
    const deployment = loadDeployment();
    const issuer = loadIssuer();
    const mint = new PublicKey(deployment.mint);

    const alice = loadOrCreateHolder('alice');
    const bob = loadOrCreateHolder('bob');
    console.log(`Alice: ${alice.publicKey.toBase58()}`);
    console.log(`Bob:   ${bob.publicKey.toBase58()}\n`);

    // The issuer pays for both accounts; holders never need SOL, because they
    // only ever sign, never pay.
    const aliceToken = await ensureTokenAccount(connection, issuer, mint, alice.publicKey);
    const bobToken = await ensureTokenAccount(connection, issuer, mint, bob.publicKey);

    const amount = toBaseUnits(TRANSFER_AMOUNT);
    if ((await balanceOf(connection, aliceToken)) < amount) {
        // Alice must be allowlisted to receive: `execute` checks both sides, and
        // mint_to does not run the hook but the later transfers do.
        await sendAndConfirmTransaction(
            connection,
            new Transaction().add(
                createAddAddressInstruction(issuer.publicKey, mint, alice.publicKey),
            ),
            [issuer],
        ).catch((error: unknown) => {
            // Already present is fine — this script is meant to be re-runnable.
            if (hookErrorName(error) !== 'AddressAlreadyPresent') throw error;
        });

        await mintTo(connection, issuer, mint, aliceToken, toBaseUnits(MINT_AMOUNT));
        console.log(`Minted ${MINT_AMOUNT} to Alice\n`);
    }

    async function attemptTransfer(label: string): Promise<boolean> {
        const instruction = await buildHookTransfer(
            connection,
            aliceToken,
            mint,
            bobToken,
            alice.publicKey,
            amount,
        );
        try {
            const signature = await sendAndConfirmTransaction(
                connection,
                new Transaction().add(instruction),
                [issuer, alice],
            );
            console.log(`  ${label}: SUCCEEDED`);
            console.log(`    ${explorerUrl(signature)}`);
            return true;
        } catch (error: unknown) {
            const name = hookErrorName(error);
            if (!name) throw error;
            console.log(`  ${label}: REJECTED by the hook — ${name}`);
            return false;
        }
    }

    async function setAllowlisted(who: PublicKey, allowed: boolean) {
        const build = allowed ? createAddAddressInstruction : createRemoveAddressInstruction;
        await sendAndConfirmTransaction(
            connection,
            new Transaction().add(build(issuer.publicKey, mint, who)),
            [issuer],
        ).catch((error: unknown) => {
            const name = hookErrorName(error);
            // Idempotent: the desired end state already holds.
            if (name !== 'AddressAlreadyPresent' && name !== 'AddressNotFound') throw error;
        });
    }

    console.log(`Transferring ${TRANSFER_AMOUNT} from Alice to Bob under three conditions:\n`);

    await setAllowlisted(bob.publicKey, false);
    const blockedRecipient = await attemptTransfer('Bob not allowlisted     ');

    await setAllowlisted(bob.publicKey, true);
    const allowed = await attemptTransfer('Both allowlisted        ');

    await setAllowlisted(alice.publicKey, false);
    const blockedSender = await attemptTransfer('Alice removed as sender ');

    // Leave the allowlist as the demo found it, so the script is re-runnable
    // and demo-clawback starts from a sane state.
    await setAllowlisted(alice.publicKey, true);

    console.log(`\nFinal balances:`);
    console.log(`  Alice ${fromBaseUnits(await balanceOf(connection, aliceToken))}`);
    console.log(`  Bob   ${fromBaseUnits(await balanceOf(connection, bobToken))}`);

    if (blockedRecipient || !allowed || blockedSender) {
        console.error(
            `\nUnexpected outcome: the allowlist did not behave as the hook program specifies.`,
        );
        process.exit(1);
    }
    console.log(`\nAllowlist enforced on both sender and recipient, inside the transfer CPI.`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
