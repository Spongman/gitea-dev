import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const localWebKitLibraries = resolve('data/browser-libs');
if (existsSync(`${localWebKitLibraries}/libicudata.so.66`)) {
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  // The Ubuntu 20.04 WebKit build is the one the local libraries run (newer builds need glibc 2.35 or later).
  // Playwright 1.62 and later do not work with it; 1.61.1 is the newest that does.
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE ??= 'ubuntu20.04-x64';
}
const webkitEnv = existsSync(`${localWebKitLibraries}/libicudata.so.66`) ? {
  ...process.env,
  LD_PRELOAD: ['libicudata.so.66', 'libicuuc.so.66', 'libicui18n.so.66',
    'libwoff2common.so.1.0.2', 'libwoff2dec.so.1.0.2', 'libjpeg.so.8',
    'libwebp.so.6', 'libffi.so.7'].map(name => `${localWebKitLibraries}/${name}`).join(':'),
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1',
} : process.env;

// Parallel workers; the server creates one Gitea account per worker slot (tests/browser/fixtures.ts).
const workers = Number(process.env.BROWSER_WORKERS ?? 4);
// Opt-in mode of tests/browser/server.ts.
const tls = process.env.BROWSER_HTTPS === '1';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers,
  use: { baseURL: `${tls ? 'https' : 'http'}://127.0.0.1:8081`, trace: 'retain-on-failure', ignoreHTTPSErrors: tls },
  projects: [
    // Chromium registers no service worker on an origin with a certificate error, ignoreHTTPSErrors or not.
    { name: 'chromium', use: { ...devices['Desktop Chrome'],
      ...(tls ? { launchOptions: { args: ['--ignore-certificate-errors'] } } : {}) } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], launchOptions: { env: webkitEnv } } },
  ],
  webServer: {
    // No npx or tsx CLI wrapper: they exit on SIGTERM before server.ts's stop() removes the Gitea dir.
    command: 'node --import tsx tests/browser/server.ts',
    url: 'http://127.0.0.1:8082/__test/ready',
    timeout: 180_000,
    reuseExistingServer: false,
    // Let tests/browser/server.ts stop Gitea and delete its temp dir; the default is SIGKILL.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: { ...process.env as Record<string, string>, BROWSER_WORKERS: String(workers) },
  },
});
