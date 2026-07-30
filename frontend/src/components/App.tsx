/**
 * Single hydration root for the whole page (`work.md` §7: "single page,
 * role-aware rendering"). One `WalletProvider` shared by every panel below,
 * rather than each panel hydrating its own — otherwise reconnecting would be
 * per-panel, which is bad UX and not what a real wallet integration does.
 */
import '../lib/polyfills';

import { useCallback, useMemo } from 'preact/hooks';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import type { WalletError } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';

import type { Deployment } from '../lib/deployment';
import { getConnection } from '../lib/solanaClient';
import WalletConnect from './WalletConnect';
import MintForm from './MintForm';
import AllowlistPanel from './AllowlistPanel';
import TransferForm from './TransferForm';
import ConfidentialBalance from './ConfidentialBalance';
import ClawbackPanel from './ClawbackPanel';

interface Props {
    deployment: Deployment;
}

function Dashboard({ deployment }: Props) {
    const { publicKey } = useWallet();
    const isIssuer = publicKey?.toBase58() === deployment.issuer;

    if (!publicKey) {
        return (
            <p class="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                Connect a wallet to continue.
            </p>
        );
    }

    return (
        <div class="space-y-8">
            {isIssuer && (
                <p class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                    Connected as the issuer — mint, allowlist, and clawback controls are visible.
                </p>
            )}
            {isIssuer && <MintForm deployment={deployment} />}
            {isIssuer && <AllowlistPanel deployment={deployment} />}
            <TransferForm deployment={deployment} />
            <ConfidentialBalance deployment={deployment} />
            {isIssuer && <ClawbackPanel deployment={deployment} />}
        </div>
    );
}

export default function App({ deployment }: Props) {
    const endpoint = useMemo(() => getConnection(deployment).rpcEndpoint, [deployment]);

    // The library's own default onError just console.errors everything,
    // including a plain "no thanks" click in the wallet's own popup — that's
    // expected user behavior, not a bug, so it's downgraded to console.debug.
    // Anything else (a real connection/transport failure) still surfaces as
    // an error.
    const onWalletError = useCallback((error: WalletError) => {
        if (/rejected/i.test(error.message)) {
            console.debug('Wallet connection declined by user:', error.message);
            return;
        }
        console.error(error);
    }, []);

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={[]} autoConnect onError={onWalletError}>
                <WalletModalProvider>
                    <div class="mx-auto max-w-3xl space-y-6 p-6">
                        <header class="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <h1 class="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                                    Compliance Token
                                </h1>
                                <p class="text-sm text-slate-500 dark:text-slate-400">
                                    {deployment.cluster} · {deployment.mint}
                                </p>
                            </div>
                            <WalletConnect />
                        </header>
                        <Dashboard deployment={deployment} />
                    </div>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}
