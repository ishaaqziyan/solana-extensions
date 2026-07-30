# CI toolchain image: Solana CLI + Anchor CLI pinned to match rust-toolchain.toml.
# Built/pushed by .github/workflows/ci-image.yml, consumed by .github/workflows/test.yml.
# Rebuild (bump the tag in both workflows) when SOLANA_VERSION/ANCHOR_VERSION/rustc change.
FROM rust:1.89-bookworm

ARG SOLANA_VERSION=3.1.10
ARG ANCHOR_VERSION=1.1.2

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config build-essential libudev-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

# avm's own deps need a newer rustc than the project's pinned 1.89.0 (the
# base image's default toolchain) — force stable just for this build.
RUN rustup toolchain install stable --profile minimal \
    && RUSTUP_TOOLCHAIN=stable cargo install --git https://github.com/coral-xyz/anchor avm --locked --force \
    && RUSTUP_TOOLCHAIN=stable avm install "${ANCHOR_VERSION}" \
    && avm use "${ANCHOR_VERSION}"

WORKDIR /workspace
