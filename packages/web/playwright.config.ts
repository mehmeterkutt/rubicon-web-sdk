import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// macOS 27 protects ~/Library/Application Support/Firefox with TCC, and Playwright's Firefox reads
// it even with its own profile, so the launch fails with "Could not find profile folder"
// (microsoft/playwright#42768, fixed in Firefox 158). Its home is pointed at a temporary directory;
// CFFIXED_USER_HOME is read only by macOS. Plan section 15, 2026-10-14.
const firefoxHome = join(tmpdir(), 'rubicon-playwright-firefox-home');
if (process.platform === 'darwin') mkdirSync(firefoxHome, { recursive: true });

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: process.platform === 'darwin' ? { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } } : {},
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
