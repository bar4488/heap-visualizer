// The browser smoke suite (spec TOOL-003): a few flows through the real page —
// the dock engine, the worker and its wasm, canvases, menus, pointer drags —
// that the unit suite cannot reach. Run with `npm run test:browser` after
// `./build.sh`; it serves `dist/` as built and never builds anything itself.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const PORT = 8699;

// The tests drive the built tree. A missing build fails here, once, with the
// fix, rather than as a page that never loads.
for (const f of ['dist/index.html', 'dist/heap_visualizer_core.wasm', 'dist/demo.heapl']) {
  if (!existsSync(fileURLToPath(new URL(f, import.meta.url)))) {
    throw new Error(`${f} is missing: run ./build.sh before npm run test:browser`);
  }
}

// The system Chromium, so `npm install` downloads no browser. HEAPVIZ_CHROMIUM
// names another binary; with neither, Playwright's own (`npx playwright install
// chromium`) is used.
const chromium = process.env.HEAPVIZ_CHROMIUM
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 1500, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  webServer: {
    command: `./serve.py ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stderr: 'ignore', // http.server logs every request there
    timeout: 15_000,
  },
});
