import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// Absolute path into the Plastic workspace - assets are read in place, never copied.
export const TAMI_ASSETS = 'D:/code/Tami/Tami/Assets';

// Game bridge (WebPlayBridge inside the standalone player / editor play mode).
// Port may fall back 7870-7875; read the port file when present.
function bridgePort() {
  // Prefer a unity-docker instance if the manager has any up - the MOST
  // RECENTLY STARTED one (docker.mjs appends to state.instances on `up`,
  // stamping startedAtMs, so the freshest instance is the one you just
  // launched, not whichever happened to be first in the array).
  try {
    const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), '_docker/state.json'), 'utf8'));
    if (st.instances?.length) {
      const newest = st.instances.reduce((a, b) =>
        (b.startedAtMs ?? 0) > (a.startedAtMs ?? 0) ? b : a);
      return newest.port;
    }
  } catch { /* no docker state */ }
  for (const f of ['D:/_tami_build/web_play_port.txt', 'D:/code/Tami/Tami/web_play_port.txt']) {
    try {
      const p = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
      if (p > 0) return p;
    } catch { /* not running from this root */ }
  }
  return 7870;
}

/**
 * /api/* proxy with the target resolved FRESH on every request (not once at
 * server start, unlike vite's built-in server.proxy). Without this, bringing
 * up a NEWER unity-docker container after vite has already started leaves
 * the dev proxy pointed at the stale one until vite itself restarts - which
 * defeats "auto-connect to whichever last started" for the common case of
 * `node docker.mjs up` while the page is already open (2026-07-21).
 */
function apiProxyPlugin() {
  return {
    name: 'api-live-proxy',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        // connect's use('/api', fn) already strips the '/api' prefix from
        // req.url before calling this handler.
        const port = bridgePort();
        const upstream = new URL(req.url || '/', `http://localhost:${port}`);
        // Drop the browser's original Host header (localhost:5173) - Windows
        // HttpListener matches its registered prefix against Host and 502s
        // (well, resets) a request whose Host doesn't say the listener's own
        // port. http.request sets the correct Host itself once this key is gone.
        const { host: _drop, ...headers } = req.headers;
        const proxyReq = http.request(upstream, { method: req.method, headers }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
          console.error('[api-live-proxy]', upstream.href, err.code || err.message);
          res.statusCode = 502; res.end('sim unreachable');
        });
        req.pipe(proxyReq);
      });
    },
  };
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
  plugins: [tamiAssetsPlugin(), snapSinkPlugin(), apiProxyPlugin()],
  server: {
    port: 5173,
  },
}));
