/**
 * Prints the on-chain state of the current deployment: mint, allowlist
 * membership, and validation account.
 *
 * `spl-token display <mint>` covers the mint extensions; this covers the hook
 * accounts, which no standard tool knows how to decode.
 *
 * Run: `npm run show`
 */
import { PublicKey } from '@solana/web3.js';

import { explorerUrl, getConnection, loadDeployment } from './lib/config.js';
import { decodeAllowlist } from './lib/hook-program.js';

async function main() {
    const connection = getConnection();
    const deployment = loadDeployment();

    console.log(`Cluster:      ${deployment.cluster}`);
    console.log(`Mint:         ${deployment.mint}`);
    console.log(`  ${explorerUrl(deployment.mint, 'address')}`);
    console.log(`Hook program: ${deployment.hookProgramId}`);

    const allowlistAccount = await connection.getAccountInfo(new PublicKey(deployment.allowlist));
    if (!allowlistAccount) {
        throw new Error(`Allowlist ${deployment.allowlist} not found on ${deployment.cluster}`);
    }
    const allowlist = decodeAllowlist(allowlistAccount.data);

    console.log(`\nAllowlist:    ${deployment.allowlist}`);
    console.log(`  authority   ${allowlist.authority.toBase58()}`);
    console.log(`  mint        ${allowlist.mint.toBase58()}`);
    console.log(`  bump        ${allowlist.bump}`);
    console.log(`  addresses   ${allowlist.addresses.length}`);
    for (const address of allowlist.addresses) {
        const label = address.equals(new PublicKey(deployment.issuer)) ? ' (issuer)' : '';
        console.log(`    - ${address.toBase58()}${label}`);
    }

    const validation = await connection.getAccountInfo(
        new PublicKey(deployment.extraAccountMetaList),
    );
    if (!validation) {
        throw new Error(`Validation account ${deployment.extraAccountMetaList} not found`);
    }
    console.log(`\nValidation:   ${deployment.extraAccountMetaList}`);
    console.log(`  owner       ${validation.owner.toBase58()}`);
    console.log(`  size        ${validation.data.length} bytes`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
