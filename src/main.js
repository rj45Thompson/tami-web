// tami-web A1 skeleton: render the live Tami battle from /api/state.
// The C# sim (standalone player / editor play mode) is authoritative; this is a view.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── CONFIG ───────────────────────────────────────────────────────────────────
const POLL_STATE_MS = 400;      // /api/state cadence
const POLL_CONSOLE_MS = 2000;   // /api/console/tail cadence
const TILE = 1.0;               // world size of one grid tile
const UNIT_LERP = 8;            // unit position smoothing (1/s)
const TERRAIN_COLORS = {
  Grassland: 0x3f8f4a, ShallowWater: 0x4fa8d8, DeepWater: 0x1d4e89,
  Obstacle: 0x6b6b6b, Ridge: 0x8a6a4a, Sand: 0xd8c27a, Burning: 0xd86a30,
  Frozen: 0xbfe8f5, Mist: 0x9aa8c0, default: 0x55607a,
};

// ── SCENE ────────────────────────────────────────────────────────────────────
const app = document.getElementById('app');
const hud = document.getElementById('hud');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e1a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
camera.position.set(6, 9, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(3, 0, 3);

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(8, 14, 6);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── LIVE STATE → MESHES ──────────────────────────────────────────────────────
const tileGroup = new THREE.Group();
scene.add(tileGroup);
const tileMeshes = new Map();   // "c,r" -> mesh
const tileGeo = new THREE.BoxGeometry(TILE * 0.96, 0.2, TILE * 0.96);
const tileMats = new Map();     // terrain -> material

const unitGroup = new THREE.Group();
scene.add(unitGroup);
const unitSprites = new Map();  // name -> {sprite, hpBar, ring, target}
const texLoader = new THREE.TextureLoader();
const portraitTex = new Map();  // name -> texture

function terrainMat(terrain) {
  if (!tileMats.has(terrain)) {
    const c = TERRAIN_COLORS[terrain] ?? TERRAIN_COLORS.default;
    tileMats.set(terrain, new THREE.MeshLambertMaterial({ color: c }));
  }
  return tileMats.get(terrain);
}

function syncTiles(tiles) {
  for (const t of tiles) {
    const key = `${t.c},${t.r}`;
    let m = tileMeshes.get(key);
    if (!m) {
      m = new THREE.Mesh(tileGeo, terrainMat(t.terrain));
      m.position.set(t.c * TILE, -0.1, t.r * TILE);
      m.userData.terrain = t.terrain;
      tileGroup.add(m);
      tileMeshes.set(key, m);
    } else if (m.userData.terrain !== t.terrain) {
      m.material = terrainMat(t.terrain);
      m.userData.terrain = t.terrain;
    }
  }
}

function unitEntry(u) {
  let e = unitSprites.get(u.name);
  if (!e) {
    if (!portraitTex.has(u.name)) {
      portraitTex.set(u.name, texLoader.load(`/api/portrait?unit=${encodeURIComponent(u.name)}`));
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: portraitTex.get(u.name), transparent: true }));
    sprite.scale.set(0.9, 0.9, 1);

    const hpBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x222222 }));
    hpBg.scale.set(0.8, 0.09, 1);
    const hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x44dd55 }));
    hpFill.scale.set(0.78, 0.07, 1);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe066, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;

    const grp = new THREE.Group();
    grp.add(sprite, hpBg, hpFill, ring);
    sprite.position.y = 0.55;
    hpBg.position.y = 1.12;
    hpFill.position.y = 1.12;
    ring.position.y = 0.02;
    unitGroup.add(grp);
    e = { grp, sprite, hpFill, ring, target: new THREE.Vector3(), team: u.team };
    unitSprites.set(u.name, e);
  }
  return e;
}

function syncUnits(units, active) {
  const seen = new Set();
  for (const u of units) {
    seen.add(u.name);
    const e = unitEntry(u);
    e.target.set(u.c * TILE, 0, u.r * TILE);
    const frac = Math.max(0, Math.min(1, u.hp / (u.maxHp || 1)));
    e.hpFill.scale.x = 0.78 * frac;
    e.hpFill.material.color.setHex(frac > 0.5 ? 0x44dd55 : frac > 0.25 ? 0xe8c545 : 0xdd4444);
    e.ring.visible = !!u.active;
    e.sprite.material.color.setHex(u.team === 'player' ? 0xffffff : 0xffd6d6);
  }
  // Deaths / despawns: remove meshes whose unit left the state.
  for (const [name, e] of unitSprites) {
    if (!seen.has(name)) {
      unitGroup.remove(e.grp);
      unitSprites.delete(name);
    }
  }
}

// ── POLLING ──────────────────────────────────────────────────────────────────
let lastState = null;
let lastErrCount = 0;
let stateOk = false;

async function pollState() {
  try {
    const r = await fetch('/api/state');
    lastState = await r.json();
    stateOk = !!lastState.ok;
    if (stateOk) {
      syncTiles(lastState.tiles || []);
      syncUnits(lastState.units || [], lastState.active);
    }
  } catch { stateOk = false; }
  drawHud();
}

async function pollConsole() {
  try {
    const r = await fetch('/api/console/tail?errors=1&n=5');
    const j = await r.json();
    lastErrCount = j.errorCount ?? -1;
  } catch { lastErrCount = -1; }
}

function drawHud() {
  const s = lastState;
  const units = s?.units?.length ?? 0;
  const errLine = lastErrCount === 0
    ? '<span class="ok">console errors: 0</span>'
    : `<span class="err">console errors: ${lastErrCount}</span>`;
  hud.innerHTML = stateOk
    ? `sim: <span class="ok">connected</span>  state: ${s.state}\nunits: ${units}  yourTurn: ${s.yourTurn}\n${errLine}`
    : 'sim: <span class="err">unreachable</span> - start the player + a battle\n(see README runbook)';
}

setInterval(pollState, POLL_STATE_MS);
setInterval(pollConsole, POLL_CONSOLE_MS);
pollState();
pollConsole();

// ── RENDER LOOP ──────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  for (const e of unitSprites.values()) {
    e.grp.position.lerp(e.target, Math.min(1, UNIT_LERP * dt));
  }
  controls.update();
  renderer.render(scene, camera);
}
tick();
