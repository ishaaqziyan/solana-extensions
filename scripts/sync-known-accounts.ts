/**
 * Writes named holder accounts (issuer + any demo holders already created by
 * `demo-transfer`/`demo-clawback`) into `deployments/<cluster>.json` as
 * `knownAccounts`, so the frontend can offer a picker instead of making a
 * user paste raw token account addresses.
 *
 * Run: `npm run sync-known-accounts` (after `create-mint`, and again any time
 * new holders show up in `.keys/<cluster>-holders.json`).
 *
 * Pure local derivation, no RPC calls, no transactions — `ataFor` computes
 * the associated-token-account address deterministically from mint + owner,
 * same as `ensureTokenAccount` does before creating one. Only the *public*
 * owner pubkey and ATA address are written; secret keys stay in `.keys/`,
 * gitignored, never touched here.
 */
import { PublicKey } from '@solana/web3.js';

import { loadIssuer, loadDeployment, saveKnownAccounts, type KnownAccount } from './lib/config.js';
import { listHolders, loadOrCreateHolder } from './lib/holders.js';
import { ataFor } from './lib/token.js';

function main() {
    const deployment = loadDeployment();
    const mint = new PublicKey(deployment.mint);

    const accounts: Record<string, KnownAccount> = {
        issuer: {
            owner: deployment.issuer,
            tokenAccount: ataFor(mint, new PublicKey(deployment.issuer)).toBase58(),
        },
    };

    for (const name of listHolders()) {
        const keypair = loadOrCreateHolder(name);
        accounts[name] = {
            owner: keypair.publicKey.toBase58(),
            tokenAccount: ataFor(mint, keypair.publicKey).toBase58(),
        };
    }

    saveKnownAccounts(accounts);
    console.log(`Wrote ${Object.keys(accounts).length} known account(s):`);
    for (const [name, account] of Object.entries(accounts)) {
        console.log(`  ${name.padEnd(8)} owner ${account.owner}  token account ${account.tokenAccount}`);
    }
}

main();
