import { Buffer } from 'buffer';

// @solana/spl-token assumes Node's Buffer global; the browser has none, and
// Vite doesn't polyfill it automatically. Imported first (its own module, not
// inlined) so this runs before any Solana import's own module body evaluates.
if (!('Buffer' in globalThis)) {
    (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
