# Solana Token Extensions Compliance Token

A regulated-asset reference token built on SPL Token-2022, stacking three
extensions on a single mint: a **transfer hook** enforcing an on-chain
allowlist, **confidential transfers** hiding amounts from the public ledger,
and a **permanent delegate** giving the issuer clawback authority. See
[`work.md`](work.md) for the full architecture writeup and scope notes.

## Live devnet deployment

| What | Address |
|---|---|
| Hook program | `DLfQ9dhxsXkur98Vze8L1sPHc14pVhkpdNSQqP3Qa3Bo` |
| Mint | `3eV7Ejpm3R5WVftW2G4dPatnfHXdGyW8ZrrTzURHnicT` |
| Allowlist PDA | `ChNLQyCB6C23jfcRN1xhWj9dgtg4k138gRs4WN5HPJRX` |
| Extra-account-meta-list PDA | `BgNWreTXr4YvvBBLnz7PS4XRH9y2T25186KYZCkKAChn` |
| Issuer | `2oE9AWmKKzJ2xMdJe4ay3wxebRxvYH27aymb3ZBMLFj2` |

Machine-readable copy: `deployments/devnet.json`. `npm run show` prints live
on-chain state for these addresses.

## Repo layout

```
programs/transfer-hook/   Anchor program: allowlist state + TransferHookInterface
scripts/                  TypeScript demo scripts (mint, allowlist, transfer, clawback)
indexer/                  Rust/Axum service consuming Helius webhooks
frontend/                 Astro + Preact role-aware demo UI
docs/                     Walkthrough + extensions deep-dive
```

## Why no local validator

The CPU of the machine that was used to develop the tooling has no AVX (`/proc/cpuinfo` stops at `sse4_2`), and
`solana-test-validator` requires it: it core-dumps on start. 
All local testing runs against **litesvm** instead (`programs/transfer-hook/tests/`,
Rust, `cargo test`). 
Everything that needs a real cluster runs on **devnet**.
See `docs/extensions-deep-dive.md` for the other two constraints that shape
this split (the ZK ElGamal proof program being disabled on public clusters,
and `@solana/spl-token` having no confidential-transfer support).

## Prerequisites

| Tool | Version used |
|---|---|
| anchor-cli | 1.1.2 |
| solana-cli | 3.1.10 (Agave) |
| cargo / rustc | 1.97.1 |
| node | v25.0.0 |
| just | any recent ([casey/just](https://github.com/casey/just)) |

A funded devnet wallet at `~/.config/solana/id.json` (or set
`ISSUER_KEYPAIR`) is needed to run the scripts against devnet.

## Setup

```bash
just install           # npm install, both root and frontend/
cp .env.example .env   # fill in as needed, see comments in the file
```

`.env` is optional for read-only commands (`npm run show`) but required for
anything that sends transactions or runs the indexer.

## Quick start

```bash
just up
```

Runs the indexer and the frontend dev server together in the foreground
(Ctrl-C stops both). This assumes the devnet deployment above already
exists — it doesn't build or deploy the program, it just brings up the
demo-facing pieces. `just --list` shows every other recipe (`build`,
`test`, `create-mint`, `demo-transfer`, `demo-clawback`, `setup-webhook`,
`show`, `typecheck`).

## Program

```bash
anchor build
cargo test --manifest-path programs/transfer-hook/Cargo.toml   # 13 litesvm tests
```

`anchor build` must run first — the test harness `include_bytes!`s
`target/deploy/transfer_hook.so`. `anchor test` already orders this correctly.

## Demo scripts (devnet)

Run in order for a fresh deployment; against the existing one above, only
`show` and the two demo scripts are needed.

```bash
npm run create-mint       # Token-2022 mint with all 3 extensions, self-allowlists issuer
npm run setup-allowlist   # add/remove allowlist addresses
npm run demo-transfer     # allowlist enforcement: rejected / accepted / rejected
npm run demo-clawback     # permanent-delegate seizure, no signature from the holder
npm run show              # print current on-chain state for deployments/devnet.json
```

`demo-transfer` and `demo-clawback` create and fund two holder keypairs the
first time they run (`.keys/devnet-holders.json`, gitignored) so the clawback
demo has a real balance to seize.

## Indexer

```bash
npm run setup-webhook   # registers a Helius webhook (needs INDEXER_PUBLIC_URL, e.g. via ngrok)
npm run indexer         # cargo run — Axum server, writes events to indexer/events.jsonl
```

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Single role-aware page (`src/pages/index.astro`); admin-only islands
(mint, allowlist, clawback) render when the connected wallet matches the
issuer address in `deployments/devnet.json`.

## Docs

- [`work.md`](work.md) — architecture and MVP scope
- `docs/walkthrough.md` — step-by-step demo narrative
- `docs/extensions-deep-dive.md` — design tradeoffs, the clawback allowlist
  flaw and fix, and the constraints behind the devnet/litesvm split
