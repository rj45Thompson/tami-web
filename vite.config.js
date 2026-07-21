import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Absolute path into the Plastic workspace - assets are read in place, never copied.
export const TAMI_ASSETS = 'D:/code/Tami/Tami/Assets';

// Game bridge (WebPlayBridge inside the standalone player / editor play mode).
// Port may fall back 7870-7875; read the port file when present.
function bridgePort() {
  for (const f of ['D:/_tami_build/web_play_port.txt', 'D:/code/Tami/Tami/web_play_port.txt']) {
    try {
      const p = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
      if (p > 0) return p;
    } catch { /* not running from this root */ }
  }
  return 7870;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.json': 'application/json',
};

/** Serve /tami-assets/<relative> straight from the Plastic workspace on disk. */
function tamiAssetsPlugin() {
  return {
    name: 'tami-assets',
    configureServer(server) {
      server.middlewares.use('/tami-assets', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]);
        const abs = path.normalize(path.join(TAMI_ASSETS, rel));
        // Stay inside the assets root (path traversal guard).
        if (!abs.startsWith(path.normalize(TAMI_ASSETS))) { res.statusCode = 403; return res.end(); }
        const ext = path.extname(abs).toLowerCase();
        if (!MIME[ext] || !fs.existsSync(abs)) return next();
        res.setHeader('Content-Type', MIME[ext]);
        fs.createReadStream(abs).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [tamiAssetsPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${bridgePort()}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
