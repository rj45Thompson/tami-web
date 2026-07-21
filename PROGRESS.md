# tami-web overnight menu-parity port - progress log

Goal for tonight (started 2026-07-20 late): make the Title -> Deploy -> Battle ->
Victory/Defeat flow fully **interactive** in tami-web, not just spectator. The
WebPlayBridge backend for this ALREADY EXISTS (menu/select, deploy/*, roster/*,
action) - built by RJ before this session. Tonight's work is almost entirely
front-end: a phase-driven UI in main.js wired to those existing routes, plus one
tiny additive backend route (`/menu/state`) to detect "are we at the title screen".

Honest scope note: this is the CORE INTERACTIVE LOOP, not full pixel/feature
parity with every Unity panel (options, tamer roster browser, item shop, etc).
See the chat budget estimate (2-3mo hybrid / 3-5mo full standalone) for the
difference between "core loop interactive" (tonight's target) and "exactly the
same, every menu" (much bigger, out of scope for one night).

## Checklist

- [x] Read WebPlayBridge menu/deploy/action routes end to end (MenuSelect,
      DeployStateJson, DeployPlace/Recall/Finish/Equip/Select/EquipItem,
      Roster*, DoAction move/attack/end) - full protocol understood.
- [x] Added `/menu/state` route (WebPlayBridge.cs) - `{titleUp, modes[]}` so the
      front-end can distinguish title vs loading vs deploy vs battle.
- [x] Fixed a stray Unity-generated ProjectReference (AgentExport.Editor.csproj)
      that was breaking local `dotnet build` sanity checks - set asmdef
      autoReferenced:false + stripped the ProjectReference from
      Assembly-CSharp.csproj (transient, Unity regenerates it). Verified via
      shared editor /test/technique 445/0 that this was NEVER a real compile
      break for RJ's editor - Unity isolates per-assembly compile failures.
- [x] Rebuilt player (docker pipeline) with /menu/state, relaunched container.
- [x] Front-end: phase state machine in main.js. Real bug found + fixed:
      GameManager.Instance is non-null (state:"Idle") even at the title
      screen, so /state ALONE can't distinguish title from battle - had to
      check /menu/state's titleUp FIRST, then /deploy/state, then fall back
      to /state + a live-unit-count guard for "actually battle".
- [x] Title screen overlay: mode buttons -> /menu/select?mode=X. Verified live
      (screenshot) - all 7 modes render, Unity PiP confirms same screen.
- [x] Deploy screen: roster cards, ability-equip chips, zone-tile highlighting
      (22/22 gold tiles confirmed in the three.js scene), click-to-place +
      click-to-recall (added DeploymentController.PlacedTile(i) + col/row in
      DeployStateJson - recall-by-click needs to know which tile a unit is
      on, which the backend didn't expose before tonight), Start Battle.
      Verified live: placed a unit through the REAL client click path (DOM
      arm-button -> raycaster-equivalent dispatch -> /deploy/place), placed
      count went 0->1, recall went 1->0.
- [x] Battle HUD: technique buttons, Move, End Turn - all wired and verified
      live (Move actually relocated a unit c:6->7, End Turn cycled the turn).
- [x] **Found + fixed a real softlock**: arming an attack/move then clicking
      an out-of-range/invalid tile leaves gm.state stuck in
      PlayerMovement/PlayerAttack: yourTurn (which requires state===Idle)
      goes false, and EVERY action including End Turn was rejected by
      DoAction's yourTurn guard - no way back via the HTTP API at all.
      Fixed: `/action?type=cancel` calls gm.OnCancelPressed(), placed BEFORE
      the yourTurn gate (cancelling must work precisely when you're NOT in
      Idle). Front-end shows a Cancel button whenever state is
      PlayerMovement/PlayerAttack. Reproduced live, confirmed stuck
      (state:PlayerAttack, yourTurn:false), clicked Cancel, confirmed
      recovered (state:Idle, yourTurn:true, canMove:true).
- [x] Raycaster: mouse click on canvas -> NDC -> intersect tileGroup meshes ->
      resolve (c,r) -> dispatch to current phase's click handler. Also
      exposed `window.__testClick(c,r)` - fires the IDENTICAL onTileClick
      dispatch a real raycaster hit would, used all night for fast headless
      verification without fighting screenshot-pixel coordinate mapping.
- [x] End-to-end verified in a docker container: title -> DeploymentTest ->
      deploy (place+recall+start) -> battle (move, attack-arm, cancel-recover,
      end turn). Random mode confirmed to SKIP deploy entirely (matches the
      earlier ask to "avoid doing any menus" for the AI-test path) - both
      paths now provably work.
- [x] **Range preview** - added `Tile.HasHighlight(layer)` (Tile.cs already
      tracks per-layer highlight state for its own rendering) + surfaced as
      `atkRange`/`moveRange` tile flags in `/state`. This is the EXACT
      valid-target set the game itself computed (respects obstacles/
      movement traits/everything), not a client approximation. Verified
      live: armed an attack, confirmed 3 `atkRange:true` tiles server-side,
      confirmed the client renders exactly 3 red overlay meshes for them
      (one false-negative check turned out to be a stale-HMR-module
      artifact, resolved by a hard reload - not a real bug).
- [x] **Proactive arm** (the follow-up from the item above, done same night):
      `/action?type=arm` (attack) / `type=armmove` (move) call
      OnAttackClick/OnMoveClick ONLY, no tile - so atkRange/moveRange
      populate on the NEXT poll, before the player picks a target, instead
      of only reactively after a bad guess. Verified live through the
      actual browser UI: clicked a technique button, confirmed 3 exact
      valid-target tiles highlighted within ~900ms, zero tile clicks made
      first. Existing `attack`/`move` (tile+fire) cases unchanged, idempotent
      re-arm-safe either way a client calls them.
- [x] Range-highlight color tuned (amber/cyan) after the first screenshot
      showed it blending with the existing red/blue per-unit team rings -
      cosmetic-only fix, mechanism was already correct.
- [ ] NOT done tonight (deliberately deferred): full Victory/Defeat
      playthrough to match conclusion (mechanism is a 2-line CSS class
      toggle on an already-correct field, low risk, just didn't sit through
      a full battle); roster editor open/close/add/remove/apply (routes
      exist, wired to nothing in the UI - RosterAdd needs a pool-list route
      that doesn't exist yet; DeploymentController.Roster.cs is a whole
      procedural UGui pool-grid+18-element-filter system, real scope);
      equip-item/accessory chips (53 options per unit, skipped for
      UI-clutter reasons, ability chips only); mapMode raycasting against
      invisible schematic tiles (harmless edge case).
- [x] Commit + push tami-web (git commits through the arm/armmove +
      color-tune commit), checkin Tami C# changes (Plastic cs:1276, 1277,
      1278 - suites 5559/0 immediately before EACH checkin), redeployed
      GitHub Pages after every meaningful chunk.
- [x] Update memory (project_tami_web_threejs.md) with final state.

## Tonight's real findings, for anyone reading this cold
Two genuine bugs were found and fixed in the ALREADY-EXISTING WebPlayBridge
backend while building tonight's front-end against it live - not code review,
actually reproduced against a running container each time:
1. Title screen indistinguishable from battle via `/state` alone (GameManager
   exists even pre-battle) - fixed by checking `/menu/state` first.
2. A real softlock: out-of-range attack/move target leaves the game stuck with
   NO recovery via the HTTP API (End Turn included) - fixed with
   `/action?type=cancel`, ungated on the yourTurn/Idle guard that blocks
   everything else.
Both are server-side fixes (cs:1276/1277), not just client workarounds - they'd
have bitten the ORIGINAL WebPlayBridge HTML client too, had anyone pushed on it
hard enough. A third addition (not a bug fix, a feature closing the gap #2's
UX left open): proactive range preview via `/action?type=arm|armmove`
(cs:1278) - shows the exact valid-target set BEFORE the player has to guess.

## Session summary (2026-07-20 -> 2026-07-21 overnight)
Started from "port menus to three.js, how long would it take" (estimated
2-3mo for full parity) -> discovered the interactive BACKEND already existed
-> built the front-end for it in one night instead -> found and fixed 2 real
bugs + shipped a proactive UX feature, all verified live against a running
container, all checked into Plastic with full-suite verification each time,
all pushed to GitHub + redeployed to Pages. Full interactive loop (title,
deploy w/ placement+recall+equip, battle w/ move+attack+range-preview+cancel)
is real and working, not a mockup. See the checklist above for exactly what's
NOT covered (roster editor, victory/defeat playthrough, accessory equipping).

## Notes / gotchas for future-me (or future session)
- WebPlayBridge GameMode enum: Random, VSMatch, Arena, Retro, TestScenarios,
  DeploymentTest, WatchBattle.
- BattleState strings in /state: NoBattle (no GameManager), Idle,
  PlayerMovement, PlayerAttack, EndPlayerTurn, EnemyTurn, EnemyMovement,
  EnemyAttack, Victory, Defeat.
- /deploy/state only returns deploying:true while DeploymentController.Instance
  exists AND is active; between title-confirm and deploy screen actually
  appearing there's a brief scene-load window where titleUp, deploying are
  both false/absent - front-end should show a neutral "loading" state there,
  not error.
- Docker container rebuild recipe unchanged: stop containers (`node
  docker.mjs stop`) before rebuilding (locked DLLs), sync clone Assets/,
  headless AgentBuild.BuildWindows, relaunch.
