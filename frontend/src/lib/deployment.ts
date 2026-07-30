/**
 * Server-only: reads `deployments/<cluster>.json`, written by
 * `npm run create-mint` (`scripts/lib/config.ts`'s `saveDeployment`).
 *
 * Import this only from `.astro` frontmatter, never from a component that
 * gets bundled for the browser — `node:fs` doesn't exist there. Pages read
 * the deployment at build/request time and pass it down to islands as a
 * serializable prop.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/**
 * Deliberately not `import.meta.url`-relative: Vite rewrites this file's
 * location when it bundles for prerendering, so a path computed from
 * `import.meta.url` at build time resolves against the *output* chunk's
 * location, not the source file's. `process.cwd()` is stable — `astro
 * dev`/`astro build` always run from `frontend/`, matching every other
 * script in this repo (`npm run <x>` from the repo root's `package.json`,
 * or here, `frontend/package.json`).
 */
const REPO_ROOT = resolve(process.cwd(), '..');

export function loadDeployment(cluster: string = process.env.CLUSTER || 'devnet'): Deployment {
    const path = resolve(REPO_ROOT, 'deployments', `${cluster}.json`);
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
    } catch {
        throw new Error(`No deployment found at ${path}. Run \`npm run create-mint\` first.`);
    }
}
