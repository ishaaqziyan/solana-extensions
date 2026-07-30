import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';

// `compat: true` aliases react/react-dom to preact/compat so
// @solana/wallet-adapter-react (a React-only library) runs under Preact —
// work.md §7 calls for Preact islands, but Solana Wallet Adapter's React
// hooks package is the only maintained option for wallet connect.
export default defineConfig({
    integrations: [preact({ compat: true })],
    devToolbar: { enabled: false },
    vite: {
        plugins: [tailwindcss()],
        // @solana/zk-sdk is wasm-bindgen output using native ESM wasm
        // integration. esbuild's dep pre-bundling (optimizeDeps) doesn't
        // understand that import form and mangles it — the wasm module's
        // exports come back undefined, breaking wasm-bindgen's own init.
        // Excluding it lets Vite's dev server import the wasm natively instead.
        optimizeDeps: {
            exclude: ['@solana/zk-sdk'],
        },
    },
});
