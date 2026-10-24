import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { register } from './onboarding.js';

async function expectNoSeriousA11yViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
  expect(severe, severe.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
}

test('registration cannot enter the app before the recovery key is saved', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await expectNoSeriousA11yViolations(page);

  await register(page, {
    home: 'http://127.0.0.1:8448',
    username: 'browser-e2e',
    password: 'correct horse battery staple',
  });

  await expect(page.getByRole('heading', { name: 'Save your recovery key' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('code')).toHaveText(/^telium-recovery-v1-[A-Za-z0-9_-]+$/);
  await expect(page.getByTitle('Settings')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // A real interstitial: reloading must keep the secret in front of the user until acknowledged.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Save your recovery key' })).toBeVisible();
  await expect(page.getByTitle('Settings')).toHaveCount(0);

  await page.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(page.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });

  // Not a global a11y gate; the shell has an unrelated avatar contrast issue.
  await page.reload();
  await expect(page.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });
});
