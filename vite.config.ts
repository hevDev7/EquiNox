import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Serve .wasm with the correct MIME so @cofhe/sdk's tfhe can use the fast
// WebAssembly.instantiateStreaming path instead of the slower fallback.
function wasmMime(): Plugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mw = (req: any, res: any, next: any) => {
    if (req.url && req.url.includes('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    next();
  };
  return {
    name: 'equinox-wasm-mime',
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}

export default defineConfig({
  plugins: [react(), wasmMime()],
  // @cofhe/sdk's web worker uses code-splitting → workers must be ES modules
  // (Vite's default 'iife' worker format can't code-split).
  worker: { format: 'es' },
  optimizeDeps: {
    // tfhe (and @cofhe/sdk) load wasm via `new URL('tfhe_bg.wasm', import.meta.url)`,
    // which only resolves when served RAW — pre-bundling points import.meta.url at
    // .vite/deps where the .wasm doesn't exist (→ HTML 404 → "expected magic word").
    exclude: ['@cofhe/sdk', 'tfhe'],
    // …but their CJS deps must still be pre-bundled for ESM default-export interop.
    include: ['tweetnacl', 'iframe-shared-storage'],
  },
  server: { port: 5173 },
});
