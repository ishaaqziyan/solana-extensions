# Recipes for the Solana Token Extensions compliance token.
# `just --list` to see all; `just` (no args) runs `default`.

set dotenv-load := true

default: up

# Bring up everything needed to demo the full stack: indexer + frontend,
# concurrently, in one foreground command. Ctrl-C stops both.
#
# Astro's dev server daemonizes itself (survives even outside its parent's
# process group), so plain `kill 0` on Ctrl-C leaves it running and squats
# the port next time. `astro dev stop` is the only reliable way to end it.
up:
    #!/usr/bin/env bash
    set -euo pipefail
    trap '(cd frontend && npx astro dev stop) >/dev/null 2>&1; kill 0' EXIT
    just indexer &
    just frontend-dev &
    wait

# Build the Anchor program (must precede `test`; harness embeds the .so).
build:
    anchor build

# Run the litesvm test suite (13 tests: allowlist, hook, clawback, confidential).
test: build
    cargo test --manifest-path programs/transfer-hook/Cargo.toml

# Print current on-chain state for the deployment in deployments/devnet.json.
show:
    npm run show

# Create a fresh mint + allowlist + validation account on devnet.
# Requires the hook program already deployed (`anchor deploy --provider.cluster devnet`).
create-mint:
    npm run create-mint

# Prove allowlist enforcement on devnet (reject / accept / reject).
demo-transfer:
    npm run demo-transfer

# Prove permanent-delegate clawback on devnet (sanction, then seize).
demo-clawback:
    npm run demo-clawback

# Register the Helius webhook (needs INDEXER_PUBLIC_URL — e.g. `ngrok http 8787`).
setup-webhook:
    npm run setup-webhook

# Run the indexer (Axum, consumes Helius webhook deliveries).
indexer:
    npm run indexer

# Run the frontend dev server (Astro).
frontend-dev:
    cd frontend && npm run dev

# Install both npm workspaces (root scripts + frontend).
install:
    npm install
    cd frontend && npm install

# Type-check the demo scripts and the frontend.
typecheck:
    npm run typecheck
    cd frontend && npm run typecheck
