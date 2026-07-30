# Build context must be the repo root: docker build -f indexer/Dockerfile .
FROM rust:1.89-slim-bookworm AS builder

WORKDIR /app/indexer
COPY indexer/Cargo.toml indexer/Cargo.lock ./
COPY indexer/src ./src
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# main.rs derives repo_root from `env!("CARGO_MANIFEST_DIR")`, baked in at
# compile time as /app/indexer (see builder WORKDIR above) — so it resolves
# to /app regardless of this stage's WORKDIR or the container's runtime cwd.
# Mount `deployments/` (required) and optionally `.env` at /app to match.
WORKDIR /app
RUN mkdir -p /app/indexer
COPY --from=builder /app/indexer/target/release/indexer /usr/local/bin/indexer

EXPOSE 8787
ENTRYPOINT ["indexer"]
