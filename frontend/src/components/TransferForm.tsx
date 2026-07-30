/**
 * Transfer form (`work.md` §7): a plain allowlisted transfer, plus the
 * confidential transfer sub-flow that generates its zero-knowledge proofs
 * client-side. See `ConfidentialBalance.tsx` for why the confidential path
 * won't confirm on this cluster right now.
 */
import { useState } from 'preact/hooks';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { createTransferCheckedWithTransferHookInstruction } from '@solana/spl-token';

import type { Deployment } from '../lib/deployment';
import { explorerUrl, sendInstructions } from '../lib/solanaClient';
import { decodeConfidentialTransferAccount, decodeConfidentialTransferMintAuditor, deriveHolderKeys } from '../lib/confidentialState';
import { transferSplitProofData } from '../lib/confidentialProofs';
import { appendHookAccounts, createTransferInstructions } from '../lib/zkProofHelpers';
import { ElGamalPubkey } from '@solana/zk-sdk/bundler';

interface Props {
    deployment: Deployment;
}

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

export default function TransferForm({ deployment }: Props) {
    const { connection } = useConnection();
    const { publicKey, sendTransaction, signMessage } = useWallet();

    const [mode, setMode] = useState<'public' | 'confidential'>('public');
    const [source, setSource] = useState('');
    const [destination, setDestination] = useState('');
    const [amount, setAmount] = useState('');
    const [status, setStatus] = useState<Status>({ kind: 'idle' });

    async function sendPublic(event: Event) {
        event.preventDefault();
        if (!publicKey) {
            setStatus({ kind: 'error', message: 'Connect a wallet first.' });
            return;
        }
        setStatus({ kind: 'busy' });
        try {
            const rawAmount = BigInt(Math.round(Number(amount) * 10 ** deployment.decimals));
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

    async function sendConfidential(event: Event) {
        event.preventDefault();
        if (!publicKey || !signMessage) {
            setStatus({ kind: 'error', message: 'This wallet does not support message signing.' });
            return;
        }
        setStatus({ kind: 'busy' });
        try {
            const sourceAccount = new PublicKey(source.trim());
            const destinationAccount = new PublicKey(destination.trim());
            const mint = new PublicKey(deployment.mint);
            const transferAmount = BigInt(Math.round(Number(amount) * 10 ** deployment.decimals));

            const keys = await deriveHolderKeys(signMessage, sourceAccount);

            const [sourceInfo, destinationInfo, mintInfo] = await Promise.all([
                connection.getAccountInfo(sourceAccount),
                connection.getAccountInfo(destinationAccount),
                connection.getAccountInfo(mint),
            ]);
            if (!sourceInfo) throw new Error(`Source token account ${source} not found`);
            if (!destinationInfo) throw new Error(`Destination token account ${destination} not found`);
            if (!mintInfo) throw new Error(`Mint ${deployment.mint} not found`);

            const sourceState = decodeConfidentialTransferAccount(sourceAccount, sourceInfo);
            if (!sourceState) throw new Error('Source account is not configured for confidential transfers');
            const destinationState = decodeConfidentialTransferAccount(destinationAccount, destinationInfo);
            if (!destinationState) {
                throw new Error('Destination account is not configured for confidential transfers');
            }
            const auditorPubkey = decodeConfidentialTransferMintAuditor(mint, mintInfo);

            const currentDecryptedAvailableBalance = keys.aes.decrypt(
                sourceState.decryptableAvailableBalance,
            );
            const destinationElgamalPubkey = ElGamalPubkey.fromBytes(destinationState.elgamalPubkey);

            const proofs = transferSplitProofData(
                sourceState.availableBalance,
                currentDecryptedAvailableBalance,
                transferAmount,
                keys.elgamal,
                destinationElgamalPubkey,
                auditorPubkey,
            );

            const remaining = currentDecryptedAvailableBalance - transferAmount;
            const instructions = createTransferInstructions(
                sourceAccount,
                mint,
                destinationAccount,
                publicKey,
                keys.aes.encrypt(remaining),
                {
                    equalityProofData: proofs.equalityProofData,
                    ciphertextValidityProofData: proofs.ciphertextValidityProofData,
                    transferAmountAuditorCiphertextLo: proofs.transferAmountAuditorCiphertextLo,
                    transferAmountAuditorCiphertextHi: proofs.transferAmountAuditorCiphertextHi,
                    rangeProofData: proofs.rangeProofData,
                },
            );
            appendHookAccounts(
                instructions[0],
                new PublicKey(deployment.allowlist),
                new PublicKey(deployment.hookProgramId),
                new PublicKey(deployment.extraAccountMetaList),
            );

            const signature = await sendInstructions(connection, sendTransaction, publicKey, instructions);
            setStatus({ kind: 'ok', message: signature });
            setAmount('');
        } catch (error) {
            setStatus({ kind: 'error', message: (error as Error).message });
        }
    }

    return (
        <section class="rounded-lg border border-slate-200 p-5 dark:border-slate-800">
            <div class="flex items-center justify-between">
                <h2 class="text-lg font-medium text-slate-900 dark:text-slate-100">Transfer</h2>
                <div class="flex gap-1 rounded-full bg-slate-100 p-1 text-xs dark:bg-slate-800">
                    <button
                        class={`rounded-full px-3 py-1 ${mode === 'public' ? 'bg-white shadow dark:bg-slate-700' : ''}`}
                        onClick={() => setMode('public')}
                        type="button"
                    >
                        Public
                    </button>
                    <button
                        class={`rounded-full px-3 py-1 ${mode === 'confidential' ? 'bg-white shadow dark:bg-slate-700' : ''}`}
                        onClick={() => setMode('confidential')}
                        type="button"
                    >
                        Confidential
                    </button>
                </div>
            </div>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Both sender and recipient must be on the allowlist — the transfer hook checks this
                on every transfer, confidential ones included.
            </p>

            <form class="mt-3 flex flex-wrap items-end gap-3" onSubmit={mode === 'public' ? sendPublic : sendConfidential}>
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
                    class="rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                    type="submit"
                    disabled={status.kind === 'busy'}
                >
                    {status.kind === 'busy'
                        ? 'Sending…'
                        : mode === 'confidential'
                          ? 'Send confidentially'
                          : 'Send'}
                </button>
            </form>
            {mode === 'confidential' && (
                <p class="mt-2 text-xs text-slate-400">
                    Generates equality, ciphertext-validity, and range proofs client-side — see the
                    banner in the balance panel below for why this won't confirm on {deployment.cluster}{' '}
                    right now.
                </p>
            )}
            {status.kind === 'ok' && (
                <p class="mt-2 text-sm text-emerald-600 dark:text-emerald-400">
                    Sent —{' '}
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
