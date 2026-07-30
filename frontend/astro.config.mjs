import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';

// `compat: true` aliases react/react-dom to preact/compat so
// @solana/wallet-adapter-react (a React-only library) runs under Preact —
// work.md §7 calls for Preact islands, but Solana Wallet Adapter's React
// hooks package is the only maintained option for wallet connect.
export default defineConfig({
    integrations: [preact({ compat: true })],
    vite: {
        plugins: [tailwindcss()],
    },
});
