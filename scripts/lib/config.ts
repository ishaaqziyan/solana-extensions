import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');

/**
 * Devnet by default.
 *
 * A local validator is not an option on this machine (no AVX), and the ZK
 * ElGamal proof program is feature-disabled on every public cluster, so the
 * confidential-transfer flow lives in the Rust litesvm tests rather than here.
 * See `yesterday.md` for the gate status and the full reasoning.
 */
/**
 * Reads an env var, treating blank as unset.
 *
 * `.env.example` ships every optional key present but empty, so a copied `.env`
 * yields `""` rather than `undefined` — and `??` would pass that through. An
 * empty `RPC_URL` reaching `new Connection()` fails with a confusing
 * "Endpoint URL must start with http:" rather than falling back to the default.
 */
export function env(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

export const RPC_URL = env('RPC_URL') ?? 'https://api.devnet.solana.com';
export const CLUSTER = env('CLUSTER') ?? 'devnet';

export const DECIMALS = 6;

/** Matches `declare_id!` in `programs/transfer-hook/src/lib.rs`. */
export const HOOK_PROGRAM_ID = new PublicKey('DLfQ9dhxsXkur98Vze8L1sPHc14pVhkpdNSQqP3Qa3Bo');

export function getConnection(): Connection {
    return new Connection(RPC_URL, 'confirmed');
}

/**
 * Issuer keypair: mint authority, permanent delegate, and allowlist authority.
 * `work.md` §3 collapses all three admin roles into one key for the MVP.
 */
export function loadIssuer(): Keypair {
    const path = env('ISSUER_KEYPAIR') ?? resolve(homedir(), '.config/solana/id.json');
    const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export interface Deployment {
    cluster: string;
    hookProgramId: string;
    mint: string;
    allowlist: string;
    extraAccountMetaList: string;
    issuer: string;
    decimals: number;
    createdAt: string;
}

function deploymentPath(): string {
    return resolve(REPO_ROOT, 'deployments', `${CLUSTER}.json`);
}

export function saveDeployment(deployment: Deployment): string {
    const path = deploymentPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`);
    return path;
}

/** Throws rather than returning null: every downstream script needs a real mint. */
export function loadDeployment(): Deployment {
    const path = deploymentPath();
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
    } catch {
        throw new Error(`No deployment found at ${path}. Run \`npm run create-mint\` first.`);
    }
}

export function explorerUrl(signatureOrAddress: string, kind: 'tx' | 'address' = 'tx'): string {
    return `https://explorer.solana.com/${kind}/${signatureOrAddress}?cluster=${CLUSTER}`;
}
