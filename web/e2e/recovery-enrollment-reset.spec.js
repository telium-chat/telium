import { test, expect } from '@playwright/test';
import { recover, register, signIn as signInAs } from './onboarding.js';

const APP = 'http://127.0.0.1:5173';
const HOME = 'http://127.0.0.1:8448';
const USER = 'existing-recovery-e2e';
const OLD_PASSWORD = 'old correct horse battery staple';
const NEW_PASSWORD = 'new correct horse battery staple';

async function openRecoverySettings(page) {
  await expect(page.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });
  await page.getByTitle('Settings').click();
  const recovery = page.getByRole('button', { name: 'Encryption key', exact: true });
  await expect(recovery).toBeVisible({ timeout: 20_000 });
  await recovery.click();
  await expect(page.getByRole('heading', { name: 'Encryption key' })).toBeVisible();
}

async function identityLabel(page) {
  const label = page.getByText(/^Identity tid:/).first();
  await expect(label).toBeVisible({ timeout: 20_000 });
  return (await label.textContent()).trim();
}

async function signIn(page, password) {
  await page.goto(APP);
  await signInAs(page, { username: USER, password });
}

test('an existing account can enroll a recovery key and use it for password reset', async ({ browser }) => {
  const originalContext = await browser.newContext();
  const original = await originalContext.newPage();

  try {
    // Simulates an account made before recovery keys existed: drops only the optional recovery public key.
    let strippedRecoveryEnrollment = false;
    await original.route('**/_telium/v1/register/opaque/finish', async (route) => {
      if (strippedRecoveryEnrollment) {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON();
      delete body.recovery_public_key;
      const headers = { ...route.request().headers() };
      delete headers['content-length'];
      headers['content-type'] = 'application/json';
      const response = await route.fetch({ headers, postData: JSON.stringify(body) });
      strippedRecoveryEnrollment = true;
      await route.fulfill({ response });
    });

    await original.goto(APP);
    await register(original, { home: HOME, username: USER, password: OLD_PASSWORD });
    await expect(original.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });
    expect(strippedRecoveryEnrollment).toBe(true);
    await original.unroute('**/_telium/v1/register/opaque/finish');

    await openRecoverySettings(original);
    await expect(original.getByText(
      'This existing account does not have a generated recovery key yet.',
      { exact: true },
    )).toBeVisible({ timeout: 20_000 });
    const immutableBefore = await identityLabel(original);

    await original.getByRole('textbox', { name: 'Current password', exact: true })
      .fill(OLD_PASSWORD);
    await original.getByRole('button', { name: 'Create recovery key', exact: true }).click();

    const code = original.locator('code').filter({ hasText: 'telium-recovery-v1-' }).first();
    await expect(code).toHaveText(/^telium-recovery-v1-[A-Za-z0-9_-]+$/, { timeout: 20_000 });
    const recoveryKey = (await code.textContent()).trim();

    await original.reload();
    await expect(original.getByRole('heading', { name: 'Save your recovery key' }))
      .toBeVisible({ timeout: 20_000 });
    await expect(original.locator('code')).toHaveText(recoveryKey);
    await expect(original.getByTitle('Settings')).toHaveCount(0);
    await original.getByRole('button', { name: 'I saved my recovery key' }).click();
    await expect(original.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });

    await openRecoverySettings(original);
    await expect(original.getByText(
      'Your account recovery key is protecting this vault too.',
      { exact: true },
    )).toBeVisible({ timeout: 20_000 });
    expect(await identityLabel(original)).toBe(immutableBefore);

    const recoveredContext = await browser.newContext();
    const recovered = await recoveredContext.newPage();
    try {
      await recovered.goto(APP);
      await recover(recovered, { username: USER, recoveryKey, password: NEW_PASSWORD });
      await expect(recovered.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });

      await openRecoverySettings(recovered);
      expect(await identityLabel(recovered)).toBe(immutableBefore);
      await expect(recovered.getByText(
        'Your account recovery key is protecting this vault too.',
        { exact: true },
      )).toBeVisible({ timeout: 20_000 });
      await expect(recovered.getByText(
        'Automatic DM recovery could not open this vault.',
        { exact: true },
      )).toHaveCount(0);
    } finally {
      await recoveredContext.close();
    }

    const oldPasswordContext = await browser.newContext();
    const oldPasswordPage = await oldPasswordContext.newPage();
    try {
      await signIn(oldPasswordPage, OLD_PASSWORD);
      await expect(oldPasswordPage.getByText(/^Sign in failed:/))
        .toBeVisible({ timeout: 20_000 });
      await expect(oldPasswordPage.getByTitle('Settings')).toHaveCount(0);
    } finally {
      await oldPasswordContext.close();
    }

    const newPasswordContext = await browser.newContext();
    const newPasswordPage = await newPasswordContext.newPage();
    try {
      await signIn(newPasswordPage, NEW_PASSWORD);
      await expect(newPasswordPage.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });
    } finally {
      await newPasswordContext.close();
    }
  } finally {
    await originalContext.close();
  }
});
