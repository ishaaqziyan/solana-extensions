/**
 * Manages the allowlist PDA for the deployed mint.
 *
 * Run:
 *   npm run setup-allowlist -- list
 *   npm run setup-allowlist -- add <pubkey> [<pubkey> ...]
 *   npm run setup-allowlist -- remove <pubkey> [<pubkey> ...]
 *
 * Only the allowlist authority (the issuer) can add or remove; the program
 * rejects anyone else with `UnauthorizedAuthority`.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { explorerUrl, getConnection, loadDeployment, loadIssuer } from './lib/config.js';
import {
    createAddAddressInstruction,
    createRemoveAddressInstruction,
    decodeAllowlist,
} from './lib/hook-program.js';
import { hookErrorName } from './lib/token.js';

const USAGE = `Usage:
  npm run setup-allowlist -- list
  npm run setup-allowlist -- add <pubkey> [<pubkey> ...]
  npm run setup-allowlist -- remove <pubkey> [<pubkey> ...]`;

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (!command || !['list', 'add', 'remove'].includes(command)) {
        console.error(USAGE);
        process.exit(1);
    }

    const connection = getConnection();
    const deployment = loadDeployment();
    const mint = new PublicKey(deployment.mint);
    const allowlistAddress = new PublicKey(deployment.allowlist);

    async function printAllowlist() {
        const account = await connection.getAccountInfo(allowlistAddress);
        if (!account) throw new Error(`Allowlist ${deployment.allowlist} not found`);
        const allowlist = decodeAllowlist(account.data);
        console.log(`Allowlist ${deployment.allowlist} — ${allowlist.addresses.length} address(es)`);
        for (const address of allowlist.addresses) {
            const label = address.toBase58() === deployment.issuer ? ' (issuer)' : '';
            console.log(`  - ${address.toBase58()}${label}`);
        }
    }

    if (command === 'list') {
        await printAllowlist();
        return;
    }

    if (rest.length === 0) {
        console.error(USAGE);
        process.exit(1);
    }

    let addresses: PublicKey[];
    try {
        addresses = rest.map((value) => new PublicKey(value));
    } catch {
        console.error(`Not a valid base58 pubkey among: ${rest.join(', ')}`);
        process.exit(1);
    }

    const issuer = loadIssuer();
    const build = command === 'add' ? createAddAddressInstruction : createRemoveAddressInstruction;

    // One instruction per address in a single transaction: the whole batch
    // either lands or it does not, so a rejected duplicate cannot leave the
    // allowlist half-updated.
    const transaction = new Transaction().add(
        ...addresses.map((address) => build(issuer.publicKey, mint, address)),
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [issuer]);
        console.log(`${command === 'add' ? 'Added' : 'Removed'} ${addresses.length} address(es)`);
        console.log(`  ${explorerUrl(signature)}\n`);
    } catch (error: unknown) {
        const name = hookErrorName(error);
        if (name) {
            console.error(`Rejected by the hook program: ${name}`);
            process.exit(1);
        }
        throw error;
    }

    await printAllowlist();
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
