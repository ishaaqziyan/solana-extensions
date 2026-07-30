/**
 * Confidential balance viewer + account lifecycle (`work.md` §4.4, §7):
 * derive keys, `ConfigureAccount`, `Deposit`, `ApplyPendingBalance`, decrypt
 * and show the result. Client-side only the holder's own key can decrypt —
 * that's the confidentiality guarantee being demonstrated.
 */
import { useState } from 'preact/hooks';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';

import type { Deployment } from '../lib/deployment';
import { explorerUrl, sendInstructions } from '../lib/solanaClient';
import { decodeConfidentialTransferAccount, deriveHolderKeys, type HolderKeys } from '../lib/confidentialState';
import {
    createApplyPendingBalanceInstruction,
    createConfigureAccountInstructions,
    createDepositInstruction,
} from '../lib/zkProofHelpers';

interface Props {
    deployment: Deployment;
}

const CLUSTER_HAS_ZK_PROOF_PROGRAM = false; // see programs/transfer-hook/tests/confidential.rs

export default function ConfidentialBalance({ deployment }: Props) {
    const { connection } = useConnection();
    const { publicKey, signMessage, sendTransaction } = useWallet();
    const [tokenAccount, setTokenAccount] = useState('');
    const [keys, setKeys] = useState<HolderKeys | null>(null);
    const [approved, setApproved] = useState<boolean | null>(null);
    const [available, setAvailable] = useState<bigint | null>(null);
    const [pending, setPending] = useState<bigint | null>(null);
    const [pendingCounter, setPendingCounter] = useState<bigint>(0n);
    const [depositAmount, setDepositAmount] = useState('');
    const [lastSignature, setLastSignature] = useState<string | null>(null);
    const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'error'; message?: string }>({
        kind: 'idle',
    });

    async function unlock(event: Event) {
        event.preventDefault();
        if (!publicKey || !signMessage) {
            setStatus({ kind: 'error', message: 'This wallet does not support message signing.' });
            return;
        }
        setStatus({ kind: 'busy' });
        try {
            const account = new PublicKey(tokenAccount.trim());
            const derived = await deriveHolderKeys(signMessage, account);
            setKeys(derived);
            await refresh(account, derived);
            setStatus({ kind: 'idle' });
        } catch (error) {
            setStatus({ kind: 'error', message: (error as Error).message });
        }
    }

    async function refresh(account: PublicKey, holderKeys: HolderKeys) {
        const info = await connection.getAccountInfo(account);
        if (!info) throw new Error(`Token account ${account.toBase58()} not found`);
        const state = decodeConfidentialTransferAccount(account, info);
        if (!state) {
            setApproved(false);
            setAvailable(null);
            setPending(null);
            return;
        }
        setApproved(state.approved);
        setPendingCounter(state.pendingBalanceCreditCounter);
        setAvailable(holderKeys.aes.decrypt(state.decryptableAvailableBalance));
        const lo = holderKeys.elgamal.secret().decrypt(state.pendingBalanceLo);
        const hi = holderKeys.elgamal.secret().decrypt(state.pendingBalanceHi);
        setPending(lo + hi * 65536n);
    }

    async function configureAccount() {
        if (!publicKey || !keys) return;
        setStatus({ kind: 'busy' });
        try {
            const account = new PublicKey(tokenAccount.trim());
            const instructions = createConfigureAccountInstructions(
                account,
                new PublicKey(deployment.mint),
                publicKey,
                keys.elgamal,
                65535n,
            );
            const signature = await sendInstructions(connection, sendTransaction, publicKey, instructions);
            setLastSignature(signature);
            await refresh(account, keys);
            setStatus({ kind: 'idle' });
        } catch (error) {
            setStatus({ kind: 'error', message: (error as Error).message });
        }
    }

    async function deposit(event: Event) {
        event.preventDefault();
        if (!publicKey || !keys) return;
        setStatus({ kind: 'busy' });
        try {
            const account = new PublicKey(tokenAccount.trim());
            const rawAmount = BigInt(Math.round(Number(depositAmount) * 10 ** deployment.decimals));
            const instruction = createDepositInstruction(
                account,
                new PublicKey(deployment.mint),
                publicKey,
                rawAmount,
                deployment.decimals,
            );
            const signature = await sendInstructions(connection, sendTransaction, publicKey, [instruction]);
            setLastSignature(signature);
            setDepositAmount('');
            await refresh(account, keys);
            setStatus({ kind: 'idle' });
        } catch (error) {
            setStatus({ kind: 'error', message: (error as Error).message });
        }
    }

    async function applyPending() {
        if (!publicKey || !keys || available === null || pending === null) return;
        setStatus({ kind: 'busy' });
        try {
            const account = new PublicKey(tokenAccount.trim());
            const newAvailable = available + pending;
            const instruction = createApplyPendingBalanceInstruction(
                account,
                publicKey,
                pendingCounter,
                keys.aes.encrypt(newAvailable),
            );
            const signature = await sendInstructions(connection, sendTransaction, publicKey, [instruction]);
            setLastSignature(signature);
            await refresh(account, keys);
            setStatus({ kind: 'idle' });
        } catch (error) {
            setStatus({ kind: 'error', message: (error as Error).message });
        }
    }

    return (
        <section class="rounded-lg border border-slate-200 p-5 dark:border-slate-800">
            <h2 class="text-lg font-medium text-slate-900 dark:text-slate-100">Confidential balance</h2>

            {!CLUSTER_HAS_ZK_PROOF_PROGRAM && (
                <p class="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                    The ZK ElGamal proof program is feature-disabled on {deployment.cluster} right
                    now (both the enable and reenable gates are set network-wide — not something
                    this app can work around). Every instruction below is real and will build and
                    send, but the proof-consuming ones (<code>ConfigureAccount</code>,{' '}
                    <code>Transfer</code>) will be rejected on-chain until that gate flips. The full
                    flow is verified working under litesvm:{' '}
                    <code>programs/transfer-hook/tests/confidential.rs</code>.
                </p>
            )}

            <form class="mt-3 flex flex-wrap items-end gap-3" onSubmit={unlock}>
                <label class="flex-1 min-w-[16rem] text-sm">
                    <span class="block text-slate-600 dark:text-slate-400">Your token account</span>
                    <input
                        class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                        value={tokenAccount}
                        onInput={(e) => setTokenAccount((e.target as HTMLInputElement).value)}
                        required
                    />
                </label>
                <button
                    class="rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                    type="submit"
                    disabled={status.kind === 'busy'}
                >
                    {status.kind === 'busy' ? 'Unlocking…' : 'Unlock (2 signatures)'}
                </button>
            </form>

            {keys && (
                <div class="mt-4 space-y-3 text-sm">
                    <p>
                        Configured:{' '}
                        <span class={approved ? 'text-emerald-600' : 'text-slate-500'}>
                            {approved === null ? '—' : approved ? 'yes' : 'no'}
                        </span>
                        {!approved && (
                            <button
                                class="ml-3 rounded bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                                onClick={configureAccount}
                                disabled={status.kind === 'busy'}
                            >
                                Configure account
                            </button>
                        )}
                    </p>
                    {approved && (
                        <>
                            <p>
                                Available: <span class="font-mono">{formatAmount(available, deployment)}</span>
                            </p>
                            <p class="flex items-center gap-3">
                                Pending: <span class="font-mono">{formatAmount(pending, deployment)}</span>
                                {pending !== null && pending > 0n && (
                                    <button
                                        class="rounded bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                                        onClick={applyPending}
                                        disabled={status.kind === 'busy'}
                                    >
                                        Apply pending
                                    </button>
                                )}
                            </p>
                            <form class="flex items-end gap-3" onSubmit={deposit}>
                                <label class="w-32 text-sm">
                                    <span class="block text-slate-600 dark:text-slate-400">Deposit</span>
                                    <input
                                        class="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                                        type="number"
                                        min="0"
                                        step="any"
                                        value={depositAmount}
                                        onInput={(e) => setDepositAmount((e.target as HTMLInputElement).value)}
                                        required
                                    />
                                </label>
                                <button
                                    class="rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                                    type="submit"
                                    disabled={status.kind === 'busy'}
                                >
                                    Move public → pending
                                </button>
                            </form>
                        </>
                    )}
                </div>
            )}
            {lastSignature && status.kind !== 'error' && (
                <p class="mt-2 text-sm text-emerald-600 dark:text-emerald-400">
                    Sent —{' '}
                    <a class="underline" href={explorerUrl(deployment, lastSignature)} target="_blank">
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

function formatAmount(raw: bigint | null, deployment: Deployment): string {
    if (raw === null) return '—';
    return (Number(raw) / 10 ** deployment.decimals).toString();
}
