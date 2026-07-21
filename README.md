# tami-web - three.js mirror of the Tami battle sim

**Hosted viewer: https://rj45thompson.github.io/tami-web/** - the GitHub-Pages
page drives your *locally running* game: browsers treat localhost as a secure
origin and WebPlayBridge sends CORS on every route, so the hosted page probes
ports 7890-7899/7870-7875 and connects to whatever container it finds. Start a
container (`node docker.mjs up 1`, or any player/editor play session) and open
the URL - no local web server needed. The exported map (`public/map.gltf`)
stays local-only (vendor art is not published); hosted mode shows the schematic
board + live Unity frames instead.

A web renderer + AI test harness for Tami. The REAL C# game runs headless (standalone
player build or editor play mode); this repo renders its live state in three.js and
gives agents/browsers an instant-iteration surface. No game assets are copied - sprites
are read from the Plastic workspace on disk and portraits stream from the game itself.

## Why (the pitch)

Testing a change in Unity costs a domain reload + editor focus + play-mode entry.
Testing it here costs a browser refresh: the sim runs headless, the web stack hot-reloads
in milliseconds, and an AI agent can drive the whole loop - start battles, step turns,
read console errors, screenshot the board - over plain HTTP. This is the tool line:
designer edits data or C#, agent verifies in seconds, human watches a URL.

## Architecture (Track A - zero-port, running today)

```
D:\code\Tami (Plastic)                      this repo (git)
┌──────────────────────────┐               ┌─────────────────────────┐
│ Standalone player build  │  HTTP :7870   │ vite dev server :5173   │
│ (or editor play mode)    │◄──────────────│  /api/* proxy ──────────┼──► browser
│ WebPlayBridge inside:    │               │  /tami-assets/* reads   │    three.js board
│  /state /scenario/start  │               │  D:\code\Tami\...\Assets│    (no copies)
│  /watchbattle /megabattle│               └─────────────────────────┘
│  /console/tail /shot     │
└──────────────────────────┘
```

- **100% C# reuse**: the authoritative sim IS the shipped game code. Zero rules ported.
- The player build comes from `AgentBuild.cs` (checked into the Tami repo, cs:1268) and
  is produced headlessly from the clone at `D:\_tami_testclone` - the live editor is
  never touched. Build output: `D:\_tami_build\Tami.exe`.

## Runbook

```powershell
# 1. start the headless game (any of):
Start-Process D:\_tami_build\Tami.exe -ArgumentList '-screen-width','1280','-screen-height','720','-screen-fullscreen','0'
#    port lands in D:\_tami_build\web_play_port.txt (7870-7875)

# 2. start a battle in it:
curl "http://localhost:7870/watchbattle?perSide=6"      # or /megabattle?cols=30&rows=30&perSide=10
#    (menu-free Random Battle bootstrap is phase A4 - see budget)

# 3. this repo:
npm install
npm run dev          # http://localhost:5173 - live board
```

Agent verification loop: `GET /api/console/tail?errors=1` after any battle = the
regression channel (BUG-361 class); `GET /api/state` = assertable game state;
`GET /api/frame` = live JPEG of the real Unity render (~7 fps).

## unity-docker - one disposable game instance per agent

Instead of N agents contending for the single shared Unity editor, each agent gets
its own standalone player "container", launched from the one build:

```powershell
node docker.mjs up 3            # agent0 :7890, agent1 :7891, agent2 :7892
node docker.mjs ls              # live health via /state
node docker.mjs battle agent0 watch
node docker.mjs battle agent1 mega 10
node docker.mjs stop            # all (or: stop agent1)
```

Each instance gets `-bridgeport N -instance NAME` (exact port, own port file, own
`-logFile`), and the player forces `Application.runInBackground` so unfocused
instances keep simulating. Agents talk straight HTTP to `localhost:<port>` -
`/state`, `/frame`, `/console/tail`, `/watchbattle`, `/megabattle`, `/shot`,
`/quit` - full isolation: a crashed or wedged instance is `stop`+`up` away from
fresh, and never touches the editor or other agents. The vite proxy auto-targets
the first docker instance when any are up.

Editor-vs-builds tradeoff, honestly: the editor still wins for rapid C# iteration
(domain reload beats the 0.8-min clone rebuild), but for AI chores - test battles,
verification sweeps, screenshots, parallel exploration - builds win outright:
isolated, parallel, disposable, no focus/compile contention.

## Budget - "copy the game to three.js", one game mode (Random Battle, no menus)

Two tracks. A is the tool we sell this week; B is the true port, built behind A using
A as the reference oracle. **No interpreter is needed for C# reuse** - Track A runs the
real compiled game; Track B compiles the same C# to WebAssembly with .NET's official
wasm target once the rules layer is Unity-free. Rewriting rules in JS is explicitly
off the table.

### Track A - thin three.js view over the live C# sim  (≈ 1 week to sellable)

| Phase | What | Est. |
|---|---|---|
| A1 | Repo + vite + three.js board rendering /state (tiles, unit billboards from /portrait, HP bars, active ring) | 0.5-1 d (skeleton landed 07-20) |
| A2 | State-delta stream + motion: move lerps, attack/hit flashes, floating damage, deaths | 1-2 d |
| A3 | VFX approximations: map TechniqueVFXMap categories to ~10 generic web effects (projectile arcs, bursts, auras, terrain overlays) | 2-4 d to "reads right"; polish is open-ended |
| A4 | Menu-free bootstrap: `-randombattle` CLI flag in the player (small C# addition) so the sim boots straight into Random Battle headless | 0.5-1 d |
| A5 | AI harness polish: deterministic seed route, turn-step route, screenshot diff helper, one-command loop | 1-2 d |

**Calendar: demo on day 1-2, sellable tool by end of week.** Iteration cost after setup:
view/harness changes are instant (HMR); C# rule changes are a 2-4 min clone rebuild
(scripts-only build can push this under 90 s).

### Track B - true port: C# rules compiled to wasm, three.js is the whole game view

| Phase | What | Est. |
|---|---|---|
| B1 | Extract Random-Battle rules into a Unity-free assembly (UnityEngine shim for Vector2Int/Mathf/etc.). The `Tami.Core` headless branch (tami-core-headless, da886c2) proves the tactics core separates; GameManager's UI/camera/cutscene entanglement is the real work | 1-2 wk if Tami.Core covers the core loop; 3-6 wk from raw Assembly-CSharp |
| B2 | .NET-wasm host + JS interop bridge (rules in the browser, no server) | 2-4 d |
| B3 | Renderer - shared with A2/A3 | reused |
| B4 | Conformance loop to "100% copy": replay-parity harness (same seed, turn-log diff Unity vs web) + run the existing 5.5k-test suite against the extracted core | 3-5 d to build, then the convergence grind the user described ("looping until 100%") |

**Calendar: 3-8 weeks depending on how much of the battle loop Tami.Core already holds.**

### What "100%" can and cannot mean
- Rules/outcomes: 100% achievable and machine-checkable (replay parity + test suite).
- Visuals: sprites are the real PNGs read off the Plastic repo; Unity particle prefabs
  (Piloto/Hovl) are NOT web-consumable - web VFX are approximations, converging on
  look-alike, never byte-identical.

### Risks
- GameManager mixes turn logic with camera/UI/cinematics; extraction (B1) is the only
  phase with real variance - hence the wide range and the A-first ordering.
- WebPlayBridge JSON is hand-built; adding fields is trivial C# but touches the shared repo.
- Screenshot-based visual assertion in the player needs the window unminimized.
