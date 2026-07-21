import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Absolute path into the Plastic workspace - assets are read in place, never copied.
export const TAMI_ASSETS = 'D:/code/Tami/Tami/Assets';

// Game bridge (WebPlayBridge inside the standalone player / editor play mode).
// Port may fall back 7870-7875; read the port file when present.
function bridgePort() {
  // Prefer a unity-docker instance if the manager has any up.
  try {
    const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), '_docker/state.json'), 'utf8'));
    if (st.instances?.length) return st.instances[0].port;
  } catch { /* no docker state */ }
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

/** POST /agent/snap with a PNG data URL body -> writes _snaps/latest.png.
 *  Lets the AI harness persist canvas snapshots (window.__snap()) to disk. */
function snapSinkPlugin() {
  return {
    name: 'agent-snap-sink',
    configureServer(server) {
      server.middlewares.use('/agent/snap', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const m = /^data:image\/png;base64,(.+)$/.exec(body.trim());
          if (!m) { res.statusCode = 400; return res.end('expected png data url'); }
          const dir = path.join(process.cwd(), '_snaps');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'latest.png');
          fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: file.replace(/\\/g, '/') }));
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the built site at /tami-web/ - dev stays at root.
  base: command === 'build' ? '/tami-web/' : '/',
  plugins: [tamiAssetsPlugin(), snapSinkPlugin()],
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
}));
