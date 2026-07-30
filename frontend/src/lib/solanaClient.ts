/** Browser-safe: no `node:fs`, importable from islands. */
import { Connection, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { Deployment } from './deployment';

export function getConnection(deployment: Deployment): Connection {
    const endpoint =
        deployment.cluster === 'mainnet-beta'
            ? 'https://api.mainnet-beta.solana.com'
            : `https://api.${deployment.cluster}.solana.com`;
    return new Connection(endpoint, 'confirmed');
}

type SendTransaction = (
    transaction: Transaction,
    connection: Connection,
) => Promise<string>;

/** Builds, sends, and confirms a transaction from wallet-adapter's `sendTransaction`. */
export async function sendInstructions(
    connection: Connection,
    sendTransaction: SendTransaction,
    payer: import('@solana/web3.js').PublicKey,
    instructions: TransactionInstruction[],
): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const transaction = new Transaction({
        feePayer: payer,
        blockhash,
        lastValidBlockHeight,
    }).add(...instructions);

    const signature = await sendTransaction(transaction, connection);
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    return signature;
}

export function explorerUrl(
    deployment: Deployment,
    signatureOrAddress: string,
    kind: 'tx' | 'address' = 'tx',
): string {
    return `https://explorer.solana.com/${kind}/${signatureOrAddress}?cluster=${deployment.cluster}`;
}
