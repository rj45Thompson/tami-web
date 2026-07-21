// tami-web A2: render the live Tami battle from /api/state with terrain relief,
// tile effects, combat-log floaters and a kill feed.
// The C# sim (standalone player / editor play mode) is authoritative; this is a view.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── SIM DISCOVERY ────────────────────────────────────────────────────────────
// Dev: the vite proxy at /api targets the first unity-docker container.
// Hosted (GitHub Pages): no proxy exists, but browsers treat localhost as a
// secure origin and WebPlayBridge sends CORS on every route - so the hosted
// page probes the local container ports directly and drives the sim that way.
let API_BASE = '/api';
async function resolveSim() {
  const candidates = ['/api'];
  for (let p = 7890; p <= 7899; p++) candidates.push(`http://localhost:${p}`);
  for (let p = 7870; p <= 7875; p++) candidates.push(`http://localhost:${p}`);
  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/state`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok !== undefined) { API_BASE = base; console.log('[tami-web] sim at', base); return true; }
      }
    } catch { /* next candidate */ }
  }
  return false;
}

// ── CONFIG ───────────────────────────────────────────────────────────────────
const POLL_STATE_MS = 400;      // /api/state cadence
const POLL_CONSOLE_MS = 1000;   // /api/console/tail cadence (combat log + errors)
const STATE_MARGIN = 12;        // tiles beyond the unit bounding box to request
const TILE = 1.0;               // world size of one grid tile
const HEIGHT_STEP = 0.35;       // world Y per game height level
const UNIT_LERP = 8;            // unit position smoothing (1/s)
const FLOATER_LIFE = 1.4;       // seconds a damage floater lives
const KILL_FEED_MAX = 6;        // lines kept in the HUD feed
const TERRAIN_COLORS = {
  Grassland: 0x4a9b55, ShallowWater: 0x58b7e8, DeepWater: 0x1d4e89,
  Obstacle: 0x7a7a7a, Ridge: 0x8a6a4a, Sand: 0xd8c27a, Burning: 0xd86a30,
  Frozen: 0xbfe8f5, Mist: 0x9aa8c0, default: 0x55607a,
};
// glTF map mode: glTFast exports Unity's left-handed coords to right-handed
// glTF by negating X - unit world positions must be mirrored the same way.
const MAP_FLIP_X = -1;

// ── SCENE ────────────────────────────────────────────────────────────────────
const app = document.getElementById('app');
const hud = document.getElementById('hud');
const feedEl = document.getElementById('feed');
const renderer = new THREE.WebGLRenderer({ antialias: true });
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101528);
scene.fog = new THREE.Fog(0x101528, 30, 90);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
camera.position.set(6, 9, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(3, 0, 3);
controls.enableDamping = true;
let userOrbited = false;
controls.addEventListener('start', () => { userOrbited = true; });

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30241a, 0.9));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.4);
sun.position.set(12, 20, 8);
scene.add(sun);

function fitRenderer() {
  const w = innerWidth || document.documentElement.clientWidth || 800;
  const h = innerHeight || document.documentElement.clientHeight || 600;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', fitRenderer);
setInterval(() => {
  const c = renderer.domElement;
  if (c.width === 0 || c.height === 0) fitRenderer();
}, 500);
fitRenderer();

// ── REAL MAP (auto-ported from Unity via glTFast, if present) ────────────────
// When /map.glb exists (AgentExportMap.Export), render the ACTUAL battle map
// and place units at their world positions; the schematic tile grid becomes a
// debug layer (press G to toggle it back on).
let mapMode = false;
new GLTFLoader().load(
  import.meta.env.BASE_URL + 'map.gltf',
  (gltf) => {
    scene.add(gltf.scene);
    mapMode = true;
    tileGroup.visible = false;
    scene.fog = null;
    // The switch to world coordinates invalidates any earlier framing -
    // retake camera control for one fresh fit even if the user touched it.
    userOrbited = false;
    lastGridKey = '';
    console.log('[tami-web] real map loaded - world-position mode');
  },
  (progress) => {
    if (progress.total) console.log(`[tami-web] map ${Math.round(progress.loaded / progress.total * 100)}%`);
  },
  (err) => console.error('[tami-web] map load FAILED:', err?.message || err),
);
window.__mapDbg = () => JSON.stringify({ mapMode, sceneChildren: scene.children.length, tilesVisible: tileGroup.visible });
window.__sceneRef = scene;
window.__THREE = THREE;
window.__camRef = camera;
addEventListener('keydown', (e) => {
  if (e.key === 'g' || e.key === 'G') tileGroup.visible = !tileGroup.visible;
});

// ── TILES ────────────────────────────────────────────────────────────────────
const tileGroup = new THREE.Group();
scene.add(tileGroup);
const tileMeshes = new Map();   // "c,r" -> {mesh, fx: Map(kind -> obj)}
const tileMats = new Map();     // terrain -> material

function terrainMat(terrain) {
  if (!tileMats.has(terrain)) {
    const c = TERRAIN_COLORS[terrain] ?? TERRAIN_COLORS.default;
    tileMats.set(terrain, new THREE.MeshLambertMaterial({ color: c }));
  }
  return tileMats.get(terrain);
}

const FX_STYLE = {
  burn:   { color: 0xff5a1a, opacity: 0.55, lift: 0.06 },
  frozen: { color: 0xa8e6ff, opacity: 0.55, lift: 0.05 },
  mist:   { color: 0xdfe6f5, opacity: 0.35, lift: 0.55 },
  plant:  { color: 0x2fae4a, opacity: 0.5,  lift: 0.05 },
  flower: { color: 0xff7ad1, opacity: 0.5,  lift: 0.05 },
};
const fxGeo = new THREE.PlaneGeometry(TILE * 0.92, TILE * 0.92);

function tileTopY(h) { return 0.1 + h * HEIGHT_STEP; }

function syncTiles(tiles) {
  for (const t of tiles) {
    const key = `${t.c},${t.r}`;
    const h = t.h ?? 0;
    let e = tileMeshes.get(key);
    if (!e) {
      // Column box: top face sits at the tile's height level so cliffs read.
      const depth = 0.2 + Math.max(0, h) * HEIGHT_STEP;
      const geo = new THREE.BoxGeometry(TILE * 0.98, depth, TILE * 0.98);
      const mesh = new THREE.Mesh(geo, terrainMat(t.terrain));
      mesh.position.set(t.c * TILE, tileTopY(h) - depth / 2, t.r * TILE);
      mesh.userData = { terrain: t.terrain, h };
      tileGroup.add(mesh);
      e = { mesh, fx: new Map() };
      tileMeshes.set(key, e);
    } else if (e.mesh.userData.terrain !== t.terrain) {
      e.mesh.material = terrainMat(t.terrain);
      e.mesh.userData.terrain = t.terrain;
    }
    // Effect overlays (burning / frozen / mist / plant / flower).
    for (const kind of Object.keys(FX_STYLE)) {
      const want = !!t[kind];
      const have = e.fx.has(kind);
      if (want && !have) {
        const s = FX_STYLE[kind];
        const m = new THREE.Mesh(fxGeo, new THREE.MeshBasicMaterial({
          color: s.color, transparent: true, opacity: s.opacity,
          depthWrite: false, side: THREE.DoubleSide,
        }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(t.c * TILE, tileTopY(t.h ?? 0) + s.lift, t.r * TILE);
        tileGroup.add(m);
        e.fx.set(kind, m);
      } else if (!want && have) {
        tileGroup.remove(e.fx.get(kind));
        e.fx.delete(kind);
      }
    }
  }
}

// ── UNITS ────────────────────────────────────────────────────────────────────
const unitGroup = new THREE.Group();
scene.add(unitGroup);
const unitSprites = new Map();  // name -> entry
const texLoader = new THREE.TextureLoader();
const portraitTex = new Map();  // name -> texture

function unitEntry(u) {
  let e = unitSprites.get(u.name);
  if (!e) {
    if (!portraitTex.has(u.name)) {
      const tex = texLoader.load(
        `${API_BASE}/portrait?unit=${encodeURIComponent(u.name)}`,
        (t) => {
          // Scale the billboard by the sprite's real aspect ratio.
          const a = t.image.width / t.image.height;
          const s = unitSprites.get(u.name);
          if (s) s.sprite.scale.set(0.95 * a, 0.95, 1);
        },
      );
      tex.magFilter = THREE.NearestFilter; // keep pixel art crisp
      portraitTex.set(u.name, tex);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: portraitTex.get(u.name), transparent: true }));
    sprite.scale.set(0.95, 0.95, 1);

    const hpBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x111111 }));
    hpBg.scale.set(0.8, 0.09, 1);
    const hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x44dd55 }));
    hpFill.scale.set(0.78, 0.07, 1);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe066, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;

    const team = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.4, 24),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    );
    team.rotation.x = -Math.PI / 2;

    const grp = new THREE.Group();
    grp.add(sprite, hpBg, hpFill, ring, team);
    sprite.position.y = 0.62;
    hpBg.position.y = 1.22;
    hpFill.position.y = 1.22;
    ring.position.y = 0.03;
    team.position.y = 0.02;
    unitGroup.add(grp);
    e = { grp, sprite, hpFill, ring, team, target: new THREE.Vector3(), dying: 0 };
    unitSprites.set(u.name, e);
  }
  return e;
}

function syncUnits(units) {
  const seen = new Set();
  for (const u of units) {
    seen.add(u.name);
    const e = unitEntry(u);
    if (mapMode && u.wx !== undefined) {
      e.target.set(u.wx * MAP_FLIP_X, u.wy, u.wz);
    } else {
      const key = tileMeshes.get(`${u.c},${u.r}`);
      const y = key ? tileTopY(key.mesh.userData.h) : 0.1;
      e.target.set(u.c * TILE, y, u.r * TILE);
    }
    const frac = Math.max(0, Math.min(1, u.hp / (u.maxHp || 1)));
    e.hpFill.scale.x = Math.max(0.001, 0.78 * frac);
    e.hpFill.material.color.setHex(frac > 0.5 ? 0x44dd55 : frac > 0.25 ? 0xe8c545 : 0xdd4444);
    e.ring.visible = !!u.active;
    e.team.material.color.setHex(u.team === 'player' ? 0x4aa3ff : 0xff5a5a);
  }
  // Death: shrink+fade out instead of popping.
  for (const [name, e] of unitSprites) {
    if (!seen.has(name) && e.dying === 0) e.dying = FLOATER_LIFE;
  }
}

// ── DAMAGE FLOATERS + KILL FEED (parsed from the game's console ring) ───────
const floaters = [];  // {sprite, vel, life}
const feed = [];

function makeTextSprite(text, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 96;
  const g = cv.getContext('2d');
  g.font = 'bold 52px Consolas, monospace';
  g.textAlign = 'center';
  g.lineWidth = 8; g.strokeStyle = '#000';
  g.strokeText(text, 128, 62);
  g.fillStyle = color;
  g.fillText(text, 128, 62);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(1.6, 0.6, 1);
  return sp;
}

function spawnFloater(unitName, text, color) {
  const e = unitSprites.get(unitName);
  if (!e) return;
  const sp = makeTextSprite(text, color);
  sp.position.copy(e.grp.position).add(new THREE.Vector3(0, 1.5, 0));
  scene.add(sp);
  floaters.push({ sprite: sp, life: FLOATER_LIFE });
}

function pushFeed(line) {
  feed.push(line);
  while (feed.length > KILL_FEED_MAX) feed.shift();
  feedEl.innerHTML = feed.map((l) => `<div>${l.replace(/</g, '&lt;')}</div>`).join('');
}

let consoleTotalSeen = 0;
let lastErrCount = 0;
// CombatLog lines carry Unity rich-text (<color=#..>, <b>) - strip before parsing.
function stripRich(s) { return s.replace(/<\/?[a-z][^>]*>/gi, ''); }
const DMG_ARROW_RE = /(CRIT!\s*)?.+?'s .+? -> (.+?) for (\d+) dmg/;
const DMG_USED_RE = /.+? used .+? on (.+?) for (\d+) dmg/;
const KO_RE = /(.+?) was defeated!/;

async function pollConsole() {
  try {
    const r = await fetch(`${API_BASE}/console/tail?n=300`);
    const j = await r.json();
    lastErrCount = j.errorCount ?? -1;
    const lines = j.lines || [];
    // Only process lines that arrived since the previous poll.
    const fresh = j.total > consoleTotalSeen ? lines.slice(-(j.total - consoleTotalSeen)) : [];
    consoleTotalSeen = j.total ?? consoleTotalSeen;
    for (const raw of fresh) {
      if (!raw.includes('[CombatLog]')) continue;
      const clean = stripRich(raw).replace(/^\[\w+\]\s*\[CombatLog\]\s*/, '').trim();
      pushFeed(clean);
      let m;
      if ((m = DMG_ARROW_RE.exec(clean))) {
        spawnFloater(m[2].trim(), (m[1] ? '✦' : '-') + m[3], m[1] ? '#ff4444' : '#ffd24a');
      } else if ((m = DMG_USED_RE.exec(clean))) {
        spawnFloater(m[1].trim(), '-' + m[2], '#ffd24a');
      } else if ((m = KO_RE.exec(clean))) {
        spawnFloater(m[1].trim(), 'KO', '#ff7b7b');
      }
    }
  } catch { lastErrCount = -1; }
}

// ── CAMERA AUTO-FIT ──────────────────────────────────────────────────────────
let lastGridKey = '';
function autoFit(grid, units) {
  if (userOrbited) return;
  if (mapMode && !units?.length) return;   // between battles: hold framing
  if (mapMode && units?.length) {
    // Fit the units' world bounding box on the real map.
    const box = new THREE.Box3();
    for (const u of units)
      if (u.wx !== undefined) box.expandByPoint(new THREE.Vector3(u.wx * MAP_FLIP_X, u.wy, u.wz));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const span = Math.max(6, box.getSize(new THREE.Vector3()).length());
    const key = `map:${c.x.toFixed(0)},${c.z.toFixed(0)},${span.toFixed(0)}`;
    if (key === lastGridKey) return;
    lastGridKey = key;
    controls.target.copy(c);
    camera.position.set(c.x + span * 0.5, c.y + span * 0.8, c.z + span * 0.7);
    return;
  }
  const key = `${grid.minC},${grid.maxC},${grid.minR},${grid.maxR}`;
  if (key === lastGridKey) { return; }
  lastGridKey = key;
  const cx = ((grid.minC + grid.maxC) / 2) * TILE;
  const cz = ((grid.minR + grid.maxR) / 2) * TILE;
  const span = Math.max(grid.maxC - grid.minC, grid.maxR - grid.minR) + 2;
  controls.target.set(cx, 0, cz);
  const d = span * 0.9;
  camera.position.set(cx + d * 0.45, d * 0.85, cz + d * 0.75);
}

// ── POLLING ──────────────────────────────────────────────────────────────────
let lastState = null;
let stateOk = false;

async function pollState() {
  try {
    const r = await fetch(`${API_BASE}/state?margin=${STATE_MARGIN}`);
    lastState = await r.json();
    stateOk = !!lastState.ok;
    if (stateOk) {
      syncTiles(lastState.tiles || []);
      syncUnits(lastState.units || []);
      if (lastState.grid) autoFit(lastState.grid, lastState.units);
    }
  } catch { stateOk = false; }
  drawHud();
}

function drawHud() {
  const s = lastState;
  const units = s?.units?.length ?? 0;
  const errLine = lastErrCount === 0
    ? '<span class="ok">console errors: 0</span>'
    : `<span class="err">console errors: ${lastErrCount}</span>`;
  hud.innerHTML = stateOk
    ? `sim: <span class="ok">connected</span>  state: ${s.state}\nunits: ${units}  tiles: ${s.tiles?.length ?? 0}\n${errLine}`
    : 'sim: <span class="err">unreachable</span> - start the player + a battle\n(see README runbook)';
}

resolveSim().then(() => {
  setInterval(pollState, POLL_STATE_MS);
  setInterval(pollConsole, POLL_CONSOLE_MS);
  pollState();
  pollConsole();
});

// ── UNITY LIVE VIEW ──────────────────────────────────────────────────────────
// Picture-in-picture of the REAL Unity render, polled from /frame (the
// "reuse Unity, redo only the delivery" shortcut). Click toggles size.
const POLL_FRAME_MS = 150;
const unityView = document.getElementById('unityview');
const unityImg = document.getElementById('unityframe');
unityView.addEventListener('click', () => unityView.classList.toggle('big'));
let lastFrameUrl = null;
async function pollFrame() {
  try {
    const r = await fetch(`${API_BASE}/frame`);
    if (!r.ok || !(r.headers.get('content-type') || '').includes('image')) {
      unityView.style.display = 'none';
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    unityImg.src = url;
    if (lastFrameUrl) URL.revokeObjectURL(lastFrameUrl);
    lastFrameUrl = url;
    unityView.style.display = 'block';
  } catch {
    unityView.style.display = 'none';
  }
}
setInterval(pollFrame, POLL_FRAME_MS);
pollFrame();

// ── AGENT HOOK ───────────────────────────────────────────────────────────────
// Deterministic canvas snapshot for the AI harness (render + read in one task,
// so no preserveDrawingBuffer needed). Returns a PNG data URL.
window.__snap = (w = 640, h = 360) => {
  const c = renderer.domElement;
  const ow = c.width, oh = c.height;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setSize(ow, oh, false);
  camera.aspect = ow / oh;
  camera.updateProjectionMatrix();
  return url;
};

// ── RENDER LOOP ──────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  for (const [name, e] of unitSprites) {
    if (e.dying > 0) {
      e.dying -= dt;
      const k = Math.max(0, e.dying / FLOATER_LIFE);
      e.grp.scale.setScalar(k);
      e.grp.position.y += dt * 0.6;
      if (e.dying <= 0) { unitGroup.remove(e.grp); unitSprites.delete(name); }
      continue;
    }
    e.grp.position.lerp(e.target, Math.min(1, UNIT_LERP * dt));
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    f.sprite.position.y += dt * 1.2;
    f.sprite.material.opacity = Math.max(0, f.life / FLOATER_LIFE);
    if (f.life <= 0) { scene.remove(f.sprite); floaters.splice(i, 1); }
  }
  controls.update();
  renderer.render(scene, camera);
}
tick();
