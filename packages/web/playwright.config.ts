import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { TEST_HOST_A, TEST_HOST_B, TEST_SITE } from 'rubicon-analytics-testing/server';

// macOS 27 protects ~/Library/Application Support/Firefox with TCC, and Playwright's Firefox reads
// it even with its own profile, so the launch fails with "Could not find profile folder"
// (microsoft/playwright#42768, fixed in Firefox 158). Its home is pointed at a temporary directory;
// CFFIXED_USER_HOME is read only by macOS. Plan section 15, 2026-10-14.
const firefoxHome = join(tmpdir(), 'rubicon-playwright-firefox-home');
if (process.platform === 'darwin') mkdirSync(firefoxHome, { recursive: true });

// The hostnames of D15 resolve to the loopback interface, where each worker's test server listens
// (test/browser/fixtures.ts), without a change to the machine: a host resolver rule in Chromium, the
// `network.dns.localDomains` preference in Firefox, and in WebKit, which has neither, the worker's
// server as the context's proxy (set in the fixtures, since its port is known only there). Plan
// section 15, step 1.3.
const chromiumHostRules = `--host-resolver-rules=MAP *.${TEST_SITE} 127.0.0.1`;
const firefoxPrefs = { 'network.dns.localDomains': [TEST_HOST_A, TEST_HOST_B].join(',') };

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: [chromiumHostRules] } } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: firefoxPrefs,
          ...(process.platform === 'darwin' ? { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } } : {}),
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
