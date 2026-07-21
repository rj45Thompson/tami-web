#!/usr/bin/env node
// unity-docker: disposable Tami player instances, one per agent.
// Each "container" = one standalone player process with its own port, log,
// and port file, all launched from the single build at BUILD_DIR. Agents talk
// straight HTTP to their instance; nothing touches the shared Unity editor.
//
//   node docker.mjs up [N]          spawn N instances (default 1)
//   node docker.mjs ls              list instances + live health (/state)
//   node docker.mjs stop [name]     stop one (or all) via /quit + hard kill
//   node docker.mjs battle <name> <watch|mega> [perSide]
//
// State: _docker/state.json   Logs: _docker/<name>.player.log
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const BUILD_DIR = 'D:/_tami_build';
const EXE = path.join(BUILD_DIR, 'Tami.exe');
const BASE_PORT = 7890;
const DOCKER_DIR = path.join(process.cwd(), '_docker');
const STATE_FILE = path.join(DOCKER_DIR, 'state.json');
const BOOT_TIMEOUT_MS = 120_000;

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { instances: [] }; }
};
const saveState = (s) => {
  fs.mkdirSync(DOCKER_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function probe(port, timeoutMs = 3000) {
  try {
    const r = await fetch(`http://localhost:${port}/state`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return j.ok ? j : null;
  } catch { return null; }
}

async function up(count) {
  if (!fs.existsSync(EXE)) throw new Error(`build not found: ${EXE} (run AgentBuild first)`);
  fs.mkdirSync(DOCKER_DIR, { recursive: true });
  const state = loadState();
  state.instances = state.instances.filter((i) => alive(i.pid));
  const used = new Set(state.instances.map((i) => i.port));

  for (let n = 0; n < count; n++) {
    let port = BASE_PORT;
    while (used.has(port)) port++;
    used.add(port);
    const name = `agent${port - BASE_PORT}`;
    const portFile = path.join(BUILD_DIR, `web_play_port_${name}.txt`);
    try { fs.unlinkSync(portFile); } catch {}

    const child = spawn(EXE, [
      '-bridgeport', String(port),
      '-instance', name,
      '-screen-width', '960', '-screen-height', '540', '-screen-fullscreen', '0',
      '-logFile', path.join(DOCKER_DIR, `${name}.player.log`),
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    // Wait for the bridge to come up on its assigned port.
    const t0 = Date.now();
    let ok = null;
    while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2500));
      ok = await probe(port);
      if (ok) break;
    }
    if (!ok) {
      // Boot flakes happen (observed once 2026-07-20: orderly self-quit right
      // after the bridge came up). One clean retry on the same slot.
      console.error(`[docker] ${name} failed to come up on :${port} (pid ${child.pid}) - retrying once`);
      try { execSync(`taskkill /F /PID ${child.pid}`, { stdio: 'ignore' }); } catch {}
      const retry = spawn(EXE, [
        '-bridgeport', String(port),
        '-instance', name,
        '-screen-width', '960', '-screen-height', '540', '-screen-fullscreen', '0',
        '-logFile', path.join(DOCKER_DIR, `${name}.player.log`),
      ], { detached: true, stdio: 'ignore' });
      retry.unref();
      const t1 = Date.now();
      while (Date.now() - t1 < BOOT_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 2500));
        ok = await probe(port);
        if (ok) break;
      }
      if (!ok) {
        console.error(`[docker] ${name} FAILED twice on :${port} - giving up`);
        continue;
      }
      state.instances.push({ name, port, pid: retry.pid });
      saveState(state);
      console.log(`[docker] ${name} up  :${port}  pid ${retry.pid}  state=${ok.state} (retry)`);
      continue;
    }
    state.instances.push({ name, port, pid: child.pid });
    saveState(state);
    console.log(`[docker] ${name} up  :${port}  pid ${child.pid}  state=${ok.state}`);
  }
}

async function ls() {
  const state = loadState();
  if (!state.instances.length) return console.log('[docker] no instances');
  for (const i of state.instances) {
    const health = alive(i.pid) ? await probe(i.port) : null;
    const status = !alive(i.pid) ? 'DEAD' : health ? `ok state=${health.state} units=${(health.units || []).length}` : 'UNRESPONSIVE';
    console.log(`${i.name.padEnd(8)} :${i.port}  pid ${String(i.pid).padEnd(6)} ${status}`);
  }
}

async function stop(name) {
  const state = loadState();
  const targets = name ? state.instances.filter((i) => i.name === name) : [...state.instances];
  for (const i of targets) {
    try { await fetch(`http://localhost:${i.port}/quit`, { signal: AbortSignal.timeout(3000) }); } catch {}
    await new Promise((r) => setTimeout(r, 3000));
    if (alive(i.pid)) {
      try { execSync(`taskkill /F /PID ${i.pid}`, { stdio: 'ignore' }); } catch {}
    }
    console.log(`[docker] ${i.name} stopped`);
  }
  state.instances = state.instances.filter((i) => !targets.includes(i));
  saveState(state);
}

async function battle(name, mode, perSide = 6) {
  const inst = loadState().instances.find((i) => i.name === name);
  if (!inst) throw new Error(`no such instance: ${name}`);
  const route = mode === 'mega'
    ? `/megabattle?cols=30&rows=30&perSide=${perSide}`
    : `/watchbattle?perSide=${perSide}`;
  const r = await fetch(`http://localhost:${inst.port}${route}`, { signal: AbortSignal.timeout(15000) });
  console.log(`[docker] ${name} ${mode}: ${await r.text()}`);
}

const [, , cmd, a1, a2, a3] = process.argv;
try {
  if (cmd === 'up') await up(parseInt(a1 || '1', 10));
  else if (cmd === 'ls') await ls();
  else if (cmd === 'stop') await stop(a1);
  else if (cmd === 'battle') await battle(a1, a2 || 'watch', parseInt(a3 || '6', 10));
  else console.log('usage: node docker.mjs up [N] | ls | stop [name] | battle <name> <watch|mega> [perSide]');
} catch (e) {
  console.error('[docker] error:', e.message);
  process.exit(1);
}
