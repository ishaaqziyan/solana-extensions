/**
 * Registers a Helius enhanced webhook for the mint and the transfer-hook
 * program, pointed at the indexer's `/webhook` endpoint (`work.md` §6).
 *
 * Helius must be able to reach `INDEXER_PUBLIC_URL` over HTTPS — for local
 * development that means a tunnel (e.g. `ngrok http 8787`), since
 * `localhost` isn't reachable from Helius's side. Deploy the indexer
 * somewhere public for anything beyond a local demo.
 *
 * Run: `npm run setup-webhook`
 *
 * API reference: https://www.helius.dev/docs/api-reference/webhooks/create-webhook
 */
import { CLUSTER, env, loadDeployment } from './lib/config.js';

const HELIUS_API_BASE = 'https://mainnet.helius-rpc.com';

async function main() {
    const apiKey = env('HELIUS_API_KEY');
    if (!apiKey) {
        throw new Error('HELIUS_API_KEY is required — see .env.example');
    }
    const publicUrl = env('INDEXER_PUBLIC_URL');
    if (!publicUrl) {
        throw new Error(
            'INDEXER_PUBLIC_URL is required — the HTTPS URL Helius should POST to ' +
                '(e.g. an ngrok tunnel to the indexer\'s /webhook endpoint).',
        );
    }
    const authToken = env('HELIUS_WEBHOOK_AUTH_TOKEN');
    if (!authToken) {
        throw new Error(
            'HELIUS_WEBHOOK_AUTH_TOKEN is required — the indexer rejects deliveries ' +
                'without it, and an unauthenticated public webhook endpoint is a bad idea.',
        );
    }

    const deployment = loadDeployment();
    // Helius separates devnet from mainnet by webhookType, not by host.
    const webhookType = CLUSTER === 'mainnet-beta' ? 'enhanced' : 'enhancedDevnet';

    const body = {
        webhookURL: publicUrl,
        webhookType,
        transactionTypes: ['ANY'],
        accountAddresses: [deployment.mint, deployment.hookProgramId],
        authHeader: authToken,
        txnStatus: 'all',
    };

    const response = await fetch(`${HELIUS_API_BASE}/v0/webhooks?api-key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(
            `Helius webhook creation failed: ${response.status} ${await response.text()}`,
        );
    }

    const created = (await response.json()) as { webhookID: string };
    console.log(`Webhook created: ${created.webhookID}`);
    console.log(`  cluster:   ${CLUSTER} (${webhookType})`);
    console.log(`  watching:  ${deployment.mint} (mint)`);
    console.log(`             ${deployment.hookProgramId} (transfer hook)`);
    console.log(`  posts to:  ${publicUrl}`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
