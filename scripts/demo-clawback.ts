/**
 * Permanent delegate clawback: the issuer moves a holder's tokens without the
 * holder's signature (`work.md` §4.5).
 *
 * Run: `npm run demo-clawback`
 *
 * Runs three cases, because the interaction between the permanent delegate and
 * the transfer hook is the least obvious part of the design:
 *
 *   1. Both parties allowlisted        — the clawback everyone expects
 *   2. Issuer removed from allowlist   — fails, issuer is the destination owner
 *   3. Holder removed from allowlist   — fails, holder is still the source owner
 *
 * Case 3 is the one that matters: it is the realistic sanctions sequence
 * (freeze the holder, then seize), and this hook design makes it impossible.
 * See the deep-dive for why and what to do about it.
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

    // Bob is the sanctioned holder. He holds tokens from demo-transfer.
    const bob = loadOrCreateHolder('bob');
    console.log(`Issuer (permanent delegate): ${issuer.publicKey.toBase58()}`);
    console.log(`Holder (target):             ${bob.publicKey.toBase58()}\n`);

    const bobToken = await ensureTokenAccount(connection, issuer, mint, bob.publicKey);
    const issuerToken = await ensureTokenAccount(connection, issuer, mint, issuer.publicKey);

    const amount = toBaseUnits(CLAWBACK_AMOUNT);
    if ((await balanceOf(connection, bobToken)) < amount) {
        await setAllowlisted(bob.publicKey, true);
        await mintTo(connection, issuer, mint, bobToken, toBaseUnits(TOP_UP_AMOUNT));
        console.log(`Topped Bob up with ${TOP_UP_AMOUNT} so there is something to seize\n`);
    }

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

    /**
     * The clawback itself. Note who signs: `issuer` only.
     *
     * Bob's keypair is never touched — the permanent delegate is accepted by
     * Token-2022 as the transfer authority over any account of this mint. That
     * is the whole mechanism.
     */
    async function attemptClawback(label: string): Promise<string | null> {
        const instruction = await buildHookTransfer(
            connection,
            bobToken,
            mint,
            issuerToken,
            issuer.publicKey,
            amount,
        );
        try {
            const signature = await sendAndConfirmTransaction(
                connection,
                new Transaction().add(instruction),
                [issuer],
            );
            console.log(`  ${label}: SUCCEEDED`);
            console.log(`    ${explorerUrl(signature)}`);
            return signature;
        } catch (error: unknown) {
            const name = hookErrorName(error);
            if (!name) throw error;
            console.log(`  ${label}: REJECTED by the hook — ${name}`);
            return null;
        }
    }

    const before = await balanceOf(connection, bobToken);
    console.log(`Bob's balance before: ${fromBaseUnits(before)}`);
    console.log(`Clawing back ${CLAWBACK_AMOUNT}, signed by the issuer alone:\n`);

    await setAllowlisted(bob.publicKey, true);
    await setAllowlisted(issuer.publicKey, true);
    const baseline = await attemptClawback('Both allowlisted        ');

    await setAllowlisted(issuer.publicKey, false);
    const withoutIssuer = await attemptClawback('Issuer not allowlisted  ');
    await setAllowlisted(issuer.publicKey, true);

    await setAllowlisted(bob.publicKey, false);
    const withoutHolder = await attemptClawback('Holder not allowlisted  ');
    await setAllowlisted(bob.publicKey, true);

    const after = await balanceOf(connection, bobToken);
    console.log(`\nBob's balance after:  ${fromBaseUnits(after)}`);
    console.log(`Seized:               ${fromBaseUnits(before - after)} (no signature from Bob)`);

    if (!baseline) {
        console.error(`\nBaseline clawback failed — the permanent delegate path is broken.`);
        process.exit(1);
    }

    if (withoutIssuer || withoutHolder) {
        console.error(`\nA clawback succeeded that the hook should have rejected.`);
        process.exit(1);
    }

    console.log(`
Both failure cases are real constraints of this design, not bugs in the demo:

  - The issuer must be on its own allowlist, because it is the destination
    owner of the seizing transfer.
  - The holder must STILL be on the allowlist, because they are the source
    owner. Removing a holder to sanction them makes their tokens unseizable.

The second is the wrong way round for a compliance token. See
docs/extensions-deep-dive.md for the fix: exempt the permanent-delegate path
inside \`execute\` by comparing the transfer authority against the mint's
PermanentDelegate extension.`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
