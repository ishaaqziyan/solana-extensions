/**
 * Issuer-only: permanent-delegate clawback (`work.md` §4.5, §7) — moves a
 * holder's tokens with only the issuer's signature, no holder involvement.
 * The single clearest proof this token enforces a real compliance
 * guarantee at the protocol level.
 */
import { useState } from 'preact/hooks';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { createTransferCheckedWithTransferHookInstruction } from '@solana/spl-token';

import type { Deployment } from '../lib/deployment';
import { explorerUrl, sendInstructions } from '../lib/solanaClient';

interface Props {
    deployment: Deployment;
}

export default function ClawbackPanel({ deployment }: Props) {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [source, setSource] = useState('');
    const [destination, setDestination] = useState('');
    const [amount, setAmount] = useState('');
    const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string }>({
        kind: 'idle',
    });

    async function onSubmit(event: Event) {
        event.preventDefault();
        if (!publicKey) return;
        setStatus({ kind: 'busy' });
        try {
            const rawAmount = BigInt(Math.round(Number(amount) * 10 ** deployment.decimals));
            // The issuer signs as permanent delegate, not as the source
            // account's owner — Token-2022 recognizes this from the mint's
            // `PermanentDelegate` extension, no separate instruction needed.
            const instruction = await createTransferCheckedWithTransferHookInstruction(
                connection,
                new PublicKey(source.trim()),
                new PublicKey(deployment.mint),
                new PublicKey(destination.trim()),
                publicKey,
                rawAmount,
                deployment.decimals,
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
        <section class="rounded-lg border border-red-200 p-5 dark:border-red-950">
            <h2 class="text-lg font-medium text-red-700 dark:text-red-400">Clawback</h2>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Moves tokens out of any account with only your signature. Standard remedy for
                sanctions or a court order.
            </p>
            <form class="mt-3 flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
                <label class="flex-1 min-w-[14rem] text-sm">
                    <span class="block text-slate-600 dark:text-slate-400">From token account</span>
                    <input
                        class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                        value={source}
                        onInput={(e) => setSource((e.target as HTMLInputElement).value)}
                        required
                    />
                </label>
                <label class="flex-1 min-w-[14rem] text-sm">
                    <span class="block text-slate-600 dark:text-slate-400">To token account</span>
                    <input
                        class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                        value={destination}
                        onInput={(e) => setDestination((e.target as HTMLInputElement).value)}
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
                    class="rounded bg-red-700 px-4 py-1.5 text-sm text-white disabled:opacity-50"
                    type="submit"
                    disabled={status.kind === 'busy'}
                >
                    {status.kind === 'busy' ? 'Seizing…' : 'Claw back'}
                </button>
            </form>
            {status.kind === 'ok' && (
                <p class="mt-2 text-sm text-emerald-600 dark:text-emerald-400">
                    Seized —{' '}
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
