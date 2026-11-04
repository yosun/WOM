// What the slide checks share: where the app is, how to get a browser, and a few helpers.
//
// The checks drive a real Chromium with Playwright, which this repo does not install. They find
// `playwright-core` (or `playwright`) the way Node does, from this folder upwards, so `npm i -D playwright-core`
// is enough; or PLAYWRIGHT_CORE names an install elsewhere (its folder, or its index.mjs).
//
//   BASE             the web app. It also proxies /api and /files to the server, so nothing else is needed
//                    (default http://localhost:5173, which is what `npm run dev` serves)
//   OUT              where screenshots go (default data/checks/slides, which git ignores)
//   BROWSER_CHANNEL  Playwright's channel for the browser to start (default chromium; chrome for an installed Chrome)
//   BROWSER_ARGS     more Chromium flags, separated by spaces
//   WOM_DATA_DIR     the server's data folder, for the checks that look at files (the same variable the server reads)
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const BASE = (process.env.BASE ?? 'http://localhost:5173').replace(/\/$/, '');
export const DATA_DIR = path.resolve(process.env.WOM_DATA_DIR ?? path.join(ROOT, 'data'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playwright() {
  const hint = process.env.PLAYWRIGHT_CORE;
  if (hint) {
    const file = existsSync(hint) && statSync(hint).isDirectory() ? path.join(hint, 'index.mjs') : hint;
    try {
      return await import(pathToFileURL(path.resolve(file)).href);
    } catch (err) {
      throw new Error(`PLAYWRIGHT_CORE=${hint} could not be loaded: ${err.message}`);
    }
  }
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return await import(name);
    } catch (err) {
      if (err.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes(`'${name}'`)) throw err;
    }
  }
  throw new Error(
    'These checks drive a browser with Playwright, which is not installed. Run `npm i -D playwright-core` ' +
      '(and `npx playwright-core install chromium` if there is no Chromium yet), or set PLAYWRIGHT_CORE to an ' +
      'install elsewhere: PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core',
  );
}

/** A headless Chromium with the GPU on: the viewer and the slide space are WebGL and CSS 3D. */
export async function launch() {
  const { chromium } = await playwright();
  const args = ['--enable-gpu', '--ignore-gpu-blocklist'];
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  if (process.env.BROWSER_ARGS) args.push(...process.env.BROWSER_ARGS.split(/\s+/).filter(Boolean));
  return chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chromium', headless: true, args });
}

/** `WIDTHxHEIGHT` as numbers. */
export function parseSize(size) {
  const [w, h] = size.split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`"${size}" is not a size: use WIDTHxHEIGHT, for example 1440x900`);
  return [w, h];
}

/** Where a run's screenshots go; made if it is not there. */
export function outDir(tag) {
  const dir = path.resolve(ROOT, process.env.OUT ?? path.join('data', 'checks', 'slides'), tag);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** GET a route of the app (the API goes through the same address) and parse the JSON. */
export async function getJson(route) {
  let res;
  try {
    res = await fetch(`${BASE}${route}`);
  } catch (err) {
    throw new Error(`Could not reach ${BASE} (${err.cause?.code ?? err.message}). Start the app with \`npm run dev\`, or set BASE to where it runs.`);
  }
  if (!res.ok) throw new Error(`GET ${route} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** The first world that has finished building, which is what a check needs to open. */
export async function firstBuiltWorld() {
  const worlds = await getJson('/api/worlds');
  const world = worlds.find((w) => w.status === 'done');
  if (!world) throw new Error('No built world to check against. Build one first, or name a world id.');
  return world.id;
}

/**
 * Runs the page's clock slowly (`window.__setSpeed(0.05)`), so a flight can be looked at frame by frame.
 * Add it with `page.addInitScript(slowClock)`.
 */
export function slowClock() {
  const real = performance.now.bind(performance);
  let base = real(), virt = base, factor = 1;
  performance.now = () => virt + (real() - base) * factor;
  window.__setSpeed = (f) => { virt = performance.now(); base = real(); factor = f; };
}

/**
 * Timestamped log lines, PASS/FAIL checks, and a verdict at the end that sets the exit code. Pass `done` the
 * error that stopped the run, if one did, so the verdict counts it.
 */
export function reporter() {
  const t0 = Date.now();
  const results = [];
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    log(ok ? 'PASS' : 'FAIL', name, detail);
  };
  const done = (stopped = null) => {
    if (stopped) check('the run got to the end', false, String(stopped.message ?? stopped).split('\n')[0]);
    const failed = results.filter((r) => !r.ok);
    log(failed.length ? `${failed.length} FAILED: ${failed.map((f) => f.name).join('; ')}` : `all ${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  };
  return { log, check, done };
}
