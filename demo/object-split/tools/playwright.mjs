// Playwright is only used to run Spark in a headless browser (WebGL, the same splat renderer the page uses).
// Point PLAYWRIGHT_CORE at any playwright-core/index.mjs, or install playwright-core in this repo.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadChromium() {
  const spec = process.env.PLAYWRIGHT_CORE;
  try {
    const mod = await import(spec ? (path.isAbsolute(spec) ? pathToFileURL(spec).href : spec) : 'playwright-core');
    return (mod.chromium ?? mod.default?.chromium);
  } catch (err) {
    throw new Error(`Could not load playwright-core${spec ? ` from PLAYWRIGHT_CORE=${spec}` : ''} (${err.code ?? err.message}).\n` +
      '  Set PLAYWRIGHT_CORE=/absolute/path/to/playwright-core/index.mjs (any project that has it), or run: npm i -D playwright-core');
  }
}
