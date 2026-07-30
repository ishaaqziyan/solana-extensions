/** Issuer-only: view and edit the allowlist PDA (`work.md` §4.3, §7). */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';

import type { Deployment } from '../lib/deployment';
import { sendInstructions } from '../lib/solanaClient';
import {
    createAddAddressInstruction,
    createRemoveAddressInstruction,
    decodeAllowlist,
    findAllowlist,
    type AllowlistState,
} from '../lib/hookProgram';

interface Props {
    deployment: Deployment;
}

export default function AllowlistPanel({ deployment }: Props) {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [allowlist, setAllowlist] = useState<AllowlistState | null>(null);
    const [newAddress, setNewAddress] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const hookProgramId = new PublicKey(deployment.hookProgramId);
    const mint = new PublicKey(deployment.mint);

    const refresh = useCallback(async () => {
        const address = findAllowlist(hookProgramId, mint);
        const info = await connection.getAccountInfo(address);
        if (!info) {
            setError(`Allowlist ${address.toBase58()} not found`);
            return;
        }
        setAllowlist(decodeAllowlist(info.data));
    }, [connection]);

    useEffect(() => {
        refresh().catch((err) => setError((err as Error).message));
    }, [refresh]);

    async function addAddress(event: Event) {
        event.preventDefault();
        if (!publicKey) return;
        setBusy('add');
        setError(null);
        try {
            const address = new PublicKey(newAddress.trim());
            const instruction = createAddAddressInstruction(hookProgramId, publicKey, mint, address);
            await sendInstructions(connection, sendTransaction, publicKey, [instruction]);
            setNewAddress('');
            await refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    async function removeAddress(address: PublicKey) {
        if (!publicKey) return;
        setBusy(address.toBase58());
        setError(null);
        try {
            const instruction = createRemoveAddressInstruction(hookProgramId, publicKey, mint, address);
            await sendInstructions(connection, sendTransaction, publicKey, [instruction]);
            await refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section class="rounded-lg border border-slate-200 p-5 dark:border-slate-800">
            <h2 class="text-lg font-medium text-slate-900 dark:text-slate-100">Allowlist</h2>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Enforced on-chain by the transfer hook — every transfer's sender and recipient must
                both be here.
            </p>

            <ul class="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
                {allowlist?.addresses.map((address) => (
                    <li key={address.toBase58()} class="flex items-center justify-between py-2 text-sm">
                        <span class="font-mono text-slate-700 dark:text-slate-300">
                            {address.toBase58()}
                            {address.equals(new PublicKey(deployment.issuer)) && (
                                <span class="ml-2 text-xs text-slate-400">(issuer)</span>
                            )}
                        </span>
                        <button
                            class="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                            onClick={() => removeAddress(address)}
                            disabled={busy !== null}
                        >
                            {busy === address.toBase58() ? 'Removing…' : 'Remove'}
                        </button>
                    </li>
                ))}
                {allowlist && allowlist.addresses.length === 0 && (
                    <li class="py-2 text-sm text-slate-400">No addresses yet.</li>
                )}
            </ul>

            <form class="mt-4 flex gap-3" onSubmit={addAddress}>
                <input
                    class="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                    value={newAddress}
                    onInput={(e) => setNewAddress((e.target as HTMLInputElement).value)}
                    placeholder="Wallet address to allow"
                    required
                />
                <button
                    class="rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                    type="submit"
                    disabled={busy !== null}
                >
                    {busy === 'add' ? 'Adding…' : 'Add'}
                </button>
            </form>
            {error && <p class="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </section>
    );
}
