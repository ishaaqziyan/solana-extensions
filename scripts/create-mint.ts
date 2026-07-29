/**
 * Creates the Token-2022 compliance mint with all three extensions
 * (`work.md` §4.1), then brings the transfer hook to a working state.
 *
 * Run: `npm run create-mint`
 *
 * Requires the hook program to already be deployed to the target cluster —
 * `initialize_extra_account_meta_list` is one of its instructions, and the mint
 * points at its program id.
 */
import {
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    ExtensionType,
    TOKEN_2022_PROGRAM_ID,
    createInitializeMint2Instruction,
    createInitializePermanentDelegateInstruction,
    createInitializeTransferHookInstruction,
    getMintLen,
} from '@solana/spl-token';

import {
    DECIMALS,
    HOOK_PROGRAM_ID,
    explorerUrl,
    getConnection,
    loadIssuer,
    saveDeployment,
} from './lib/config.js';
import { createInitializeConfidentialTransferMintInstruction } from './lib/confidential-transfer.js';
import {
    createAddAddressInstruction,
    createInitializeAllowlistInstruction,
    createInitializeExtraAccountMetaListInstruction,
    findAllowlist,
    findExtraAccountMetaList,
} from './lib/hook-program.js';

/**
 * Optional: 32-byte ElGamal public key, base64. Holds audit capability over
 * confidential amounts.
 *
 * Left unset by default because generating an ElGamal keypair needs the Rust
 * zk-sdk, which is where the confidential flow lives anyway. The mint keeps its
 * confidential-transfer authority, so this can be set later via `UpdateMint`
 * without recreating the mint.
 */
function auditorElGamalPubkey(): Uint8Array | null {
    const encoded = process.env.AUDITOR_ELGAMAL_PUBKEY;
    if (!encoded) return null;

    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 32) {
        throw new Error(`AUDITOR_ELGAMAL_PUBKEY must decode to 32 bytes, got ${bytes.length}`);
    }
    return Uint8Array.from(bytes);
}

async function main() {
    const connection = getConnection();
    const issuer = loadIssuer();
    const auditor = auditorElGamalPubkey();

    console.log(`Issuer:       ${issuer.publicKey.toBase58()}`);
    const balance = await connection.getBalance(issuer.publicKey);
    console.log(`Balance:      ${(balance / 1e9).toFixed(4)} SOL`);

    const program = await connection.getAccountInfo(HOOK_PROGRAM_ID);
    if (!program?.executable) {
        throw new Error(
            `Hook program ${HOOK_PROGRAM_ID.toBase58()} is not deployed to this cluster. ` +
                `Deploy it first: anchor deploy --provider.cluster devnet`,
        );
    }
    console.log(`Hook program: ${HOOK_PROGRAM_ID.toBase58()} (deployed)`);

    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    // Every extension must be sized for up front — the mint account cannot grow
    // later, and each initializer must run before InitializeMint2.
    const extensions = [
        ExtensionType.TransferHook,
        ExtensionType.ConfidentialTransferMint,
        ExtensionType.PermanentDelegate,
    ];
    const mintLen = getMintLen(extensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const createMintTx = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: issuer.publicKey,
            newAccountPubkey: mint,
            space: mintLen,
            lamports,
            programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(
            mint,
            issuer.publicKey,
            HOOK_PROGRAM_ID,
            TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeConfidentialTransferMintInstruction({
            mint,
            authority: issuer.publicKey,
            autoApproveNewAccounts: true,
            auditorElGamalPubkey: auditor,
        }),
        createInitializePermanentDelegateInstruction(
            mint,
            issuer.publicKey,
            TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMint2Instruction(
            mint,
            DECIMALS,
            issuer.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID,
        ),
    );

    const createMintSignature = await sendAndConfirmTransaction(connection, createMintTx, [
        issuer,
        mintKeypair,
    ]);
    console.log(`\nMint created: ${mint.toBase58()}`);
    console.log(`  ${explorerUrl(createMintSignature)}`);

    // The TransferHook extension is inert until the validation account exists —
    // without it Token-2022 cannot resolve the accounts for the hook CPI and
    // every transfer fails.
    //
    // The issuer is added to its own allowlist here rather than in
    // setup-allowlist.ts, because `execute` also runs on the permanent-delegate
    // path: an unallowlisted issuer cannot claw back.
    const setupTx = new Transaction().add(
        createInitializeAllowlistInstruction(issuer.publicKey, issuer.publicKey, mint),
        createInitializeExtraAccountMetaListInstruction(issuer.publicKey, issuer.publicKey, mint),
        createAddAddressInstruction(issuer.publicKey, mint, issuer.publicKey),
    );

    const setupSignature = await sendAndConfirmTransaction(connection, setupTx, [issuer]);
    const allowlist = findAllowlist(mint);
    const extraAccountMetaList = findExtraAccountMetaList(mint);
    console.log(`\nHook wired up:`);
    console.log(`  allowlist            ${allowlist.toBase58()}`);
    console.log(`  extraAccountMetaList ${extraAccountMetaList.toBase58()}`);
    console.log(`  ${explorerUrl(setupSignature)}`);

    const path = saveDeployment({
        cluster: process.env.CLUSTER ?? 'devnet',
        hookProgramId: HOOK_PROGRAM_ID.toBase58(),
        mint: mint.toBase58(),
        allowlist: allowlist.toBase58(),
        extraAccountMetaList: extraAccountMetaList.toBase58(),
        issuer: issuer.publicKey.toBase58(),
        decimals: DECIMALS,
        createdAt: new Date().toISOString(),
    });

    console.log(`\nDeployment written to ${path}`);
    console.log(`Verify: spl-token display ${mint.toBase58()} --url devnet`);
    if (!auditor) {
        console.log(
            `\nNote: no auditor ElGamal key set. Confidential amounts will not be ` +
                `auditable until one is configured via UpdateMint.`,
        );
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
