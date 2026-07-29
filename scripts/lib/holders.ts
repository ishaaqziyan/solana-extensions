import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Keypair } from '@solana/web3.js';

import { CLUSTER, REPO_ROOT } from './config.js';

/**
 * Demo holder wallets, persisted so `demo-transfer` and `demo-clawback` operate
 * on the same accounts across runs — the clawback demo is only meaningful
 * against a holder who already has a balance.
 *
 * These are throwaway devnet keys, but they are still private keys, so `.keys/`
 * is gitignored. Nothing here should ever hold value.
 */
function holdersPath(): string {
    return resolve(REPO_ROOT, '.keys', `${CLUSTER}-holders.json`);
}

type StoredHolders = Record<string, number[]>;

function readStore(): StoredHolders {
    const path = holdersPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as StoredHolders;
}

function writeStore(store: StoredHolders): void {
    const path = holdersPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** Returns the existing keypair for `name`, generating and persisting one if absent. */
export function loadOrCreateHolder(name: string): Keypair {
    const store = readStore();
    const existing = store[name];
    if (existing) {
        return Keypair.fromSecretKey(Uint8Array.from(existing));
    }

    const keypair = Keypair.generate();
    store[name] = Array.from(keypair.secretKey);
    writeStore(store);
    return keypair;
}

export function listHolders(): string[] {
    return Object.keys(readStore());
}
