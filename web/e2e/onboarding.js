
import { expect } from '@playwright/test';

const HOST = '127.0.0.1:8448';

export async function register(page, { home, username, password }) {
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByRole('button', { name: 'Choose a different home' }).click();
  await page.getByRole('textbox', { name: 'Home server' }).fill(home);
  await page.getByRole('button', { name: 'Use this server' }).click();
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

export async function signIn(page, { username, password }) {
  await page.getByRole('textbox', { name: 'Telium address' }).fill(`@${username}:${HOST}`);
  await page.getByRole('textbox', { name: 'Telium address' }).press('Enter');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/// The username goes in bare: the address names the server by the host it was reached at.
export async function recover(page, { username, recoveryKey, password }) {
  await page.getByRole('textbox', { name: 'Telium address' }).fill(`@${username}:${HOST}`);
  await page.getByRole('button', { name: 'Recover your account' }).click();
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByLabel('Recovery key').fill(recoveryKey);
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill(password);
  await page.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
}
