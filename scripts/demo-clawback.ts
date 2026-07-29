/**
 * Permanent delegate clawback: the issuer seizes a sanctioned holder's tokens
 * without the holder's signature (`work.md` §4.5).
 *
 * Run: `npm run demo-clawback`
 *
 * The interesting property is the ordering. A compliance response sanctions a
 * holder first — removing them from the allowlist — and seizes second. So the
 * demo runs the realistic sequence:
 *
 *   1. Sanction the holder (remove from allowlist)
 *   2. Holder tries to move their own tokens  — rejected by the hook
 *   3. Issuer seizes them as permanent delegate — succeeds
 *
 * Step 3 only works because `execute` exempts the permanent-delegate path.
 * Without that exemption the holder's own removal would make their tokens
 * permanently unseizable, which is backwards. Step 2 is what proves the
 * exemption is narrow: it applies to the delegate, not to the accounts.
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

const CLAWBACK_AMOUNT = 5;
const TOP_UP_AMOUNT = 50;

async function main() {
    const connection = getConnection();
    const deployment = loadDeployment();
    const issuer = loadIssuer();
    const mint = new PublicKey(deployment.mint);

    const bob = loadOrCreateHolder('bob');
    const alice = loadOrCreateHolder('alice');
    console.log(`Issuer (permanent delegate): ${issuer.publicKey.toBase58()}`);
    console.log(`Holder (to be sanctioned):   ${bob.publicKey.toBase58()}\n`);

    const bobToken = await ensureTokenAccount(connection, issuer, mint, bob.publicKey);
    const aliceToken = await ensureTokenAccount(connection, issuer, mint, alice.publicKey);
    const issuerToken = await ensureTokenAccount(connection, issuer, mint, issuer.publicKey);

    async function setAllowlisted(who: PublicKey, allowed: boolean) {
        const build = allowed ? createAddAddressInstruction : createRemoveAddressInstruction;
        await sendAndConfirmTransaction(
            connection,
            new Transaction().add(build(issuer.publicKey, mint, who)),
            [issuer],
        ).catch((error: unknown) => {
            const name = hookErrorName(error);
            if (name !== 'AddressAlreadyPresent' && name !== 'AddressNotFound') throw error;
        });
    }

    const amount = toBaseUnits(CLAWBACK_AMOUNT);
    if ((await balanceOf(connection, bobToken)) < amount) {
        await setAllowlisted(bob.publicKey, true);
        await mintTo(connection, issuer, mint, bobToken, toBaseUnits(TOP_UP_AMOUNT));
        console.log(`Topped Bob up with ${TOP_UP_AMOUNT} so there is something to seize\n`);
    }

    console.log(`Step 1 — sanction Bob by removing him from the allowlist`);
    await setAllowlisted(bob.publicKey, false);
    await setAllowlisted(alice.publicKey, true);
    console.log(`  done\n`);

    console.log(`Step 2 — Bob tries to move his own tokens to Alice`);
    const bobTransfer = await buildHookTransfer(
        connection,
        bobToken,
        mint,
        aliceToken,
        bob.publicKey,
        amount,
    );
    let bobBlocked = false;
    try {
        await sendAndConfirmTransaction(connection, new Transaction().add(bobTransfer), [
            issuer,
            bob,
        ]);
        console.log(`  SUCCEEDED — the sanction is not being enforced`);
    } catch (error: unknown) {
        const name = hookErrorName(error);
        if (!name) throw error;
        console.log(`  REJECTED by the hook — ${name}`);
        bobBlocked = true;
    }

    console.log(`\nStep 3 — issuer seizes ${CLAWBACK_AMOUNT} as permanent delegate`);
    const before = await balanceOf(connection, bobToken);
    const clawback = await buildHookTransfer(
        connection,
        bobToken,
        mint,
        issuerToken,
        issuer.publicKey,
        amount,
    );

    // Note the signer list: the issuer alone. Bob's keypair is loaded in this
    // script only to prove step 2 — it plays no part in the seizure.
    let seized = false;
    try {
        const signature = await sendAndConfirmTransaction(
            connection,
            new Transaction().add(clawback),
            [issuer],
        );
        console.log(`  SUCCEEDED — no signature from Bob`);
        console.log(`  ${explorerUrl(signature)}`);
        seized = true;
    } catch (error: unknown) {
        const name = hookErrorName(error);
        if (!name) throw error;
        console.log(`  REJECTED by the hook — ${name}`);
    }

    const after = await balanceOf(connection, bobToken);
    console.log(`\nBob's balance: ${fromBaseUnits(before)} -> ${fromBaseUnits(after)}`);
    console.log(`Seized:        ${fromBaseUnits(before - after)}`);

    // Restore, so the script is re-runnable.
    await setAllowlisted(bob.publicKey, true);

    if (!bobBlocked || !seized) {
        console.error(`\nUnexpected outcome — see the two failures above.`);
        process.exit(1);
    }

    console.log(`
The sanctioned holder cannot move their own tokens, but the permanent delegate
can still seize them. That ordering — freeze, then seize — is only possible
because \`execute\` exempts the permanent-delegate path from the allowlist.

Without the exemption, removing a holder from the allowlist would also make
their tokens permanently unseizable. See docs/extensions-deep-dive.md.`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
