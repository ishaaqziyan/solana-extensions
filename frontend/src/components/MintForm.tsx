/** Issuer-only: mints new tokens to a holder's token account (`work.md` §7). */
import { useState } from 'preact/hooks';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { createMintToInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import type { Deployment } from '../lib/deployment';
import { explorerUrl, sendInstructions } from '../lib/solanaClient';

interface Props {
    deployment: Deployment;
}

export default function MintForm({ deployment }: Props) {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [tokenAccount, setTokenAccount] = useState('');
    const [amount, setAmount] = useState('');
    const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string }>({
        kind: 'idle',
    });

    async function onSubmit(event: Event) {
        event.preventDefault();
        if (!publicKey) return;
        setStatus({ kind: 'busy' });
        try {
            const destination = new PublicKey(tokenAccount.trim());
            const rawAmount = BigInt(Math.round(Number(amount) * 10 ** deployment.decimals));
            const instruction = createMintToInstruction(
                new PublicKey(deployment.mint),
                destination,
                publicKey,
                rawAmount,
                [],
                TOKEN_2022_PROGRAM_ID,
            );
            const signature = await sendInstructions(connection, sendTransaction, publicKey, [
                instruction,
            ]);
            setStatus({ kind: 'ok', message: signature });
            setAmount('');
        } catch (error) {
            setStatus({ kind: 'error', message: (error as Error).message });
        }
    }

    return (
        <section class="rounded-lg border border-slate-200 p-5 dark:border-slate-800">
            <h2 class="text-lg font-medium text-slate-900 dark:text-slate-100">Issue tokens</h2>
            <form class="mt-3 flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
                <label class="flex-1 min-w-[16rem] text-sm">
                    <span class="block text-slate-600 dark:text-slate-400">Destination token account</span>
                    <input
                        class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                        value={tokenAccount}
                        onInput={(e) => setTokenAccount((e.target as HTMLInputElement).value)}
                        placeholder="Token account address"
                        required
                    />
                </label>
                <label class="w-32 text-sm">
                    <span class="block text-slate-600 dark:text-slate-400">Amount</span>
                    <input
                        class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                        type="number"
                        min="0"
                        step="any"
                        value={amount}
                        onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
                        required
                    />
                </label>
                <button
                    class="rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                    type="submit"
                    disabled={status.kind === 'busy'}
                >
                    {status.kind === 'busy' ? 'Minting…' : 'Mint'}
                </button>
            </form>
            {status.kind === 'ok' && (
                <p class="mt-2 text-sm text-emerald-600 dark:text-emerald-400">
                    Minted —{' '}
                    <a class="underline" href={explorerUrl(deployment, status.message!)} target="_blank">
                        view transaction
                    </a>
                </p>
            )}
            {status.kind === 'error' && (
                <p class="mt-2 text-sm text-red-600 dark:text-red-400">{status.message}</p>
            )}
        </section>
    );
}
