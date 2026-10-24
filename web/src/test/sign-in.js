import { screen, waitFor } from '@testing-library/react';
import { HOME, PASSWORD } from './fake-server.js';

async function caretIn(field) {
  await waitFor(() => {
    if (document.activeElement !== field) throw new Error('the step has not taken focus yet');
  });
}

export async function enterAddress(user, address) {
  const field = await screen.findByRole('textbox', { name: 'Telium address' });
  await caretIn(field);
  await user.clear(field);
  await user.type(field, `${address}{Enter}`);
}

export async function chooseServer(user, home = HOME) {
  await user.click(await screen.findByRole('button', { name: 'Choose a different home' }));
  const field = await screen.findByRole('textbox', { name: 'Home server' });
  await caretIn(field);
  await user.clear(field);
  await user.type(field, home);
  await user.click(screen.getByRole('button', { name: 'Use this server' }));
  await waitFor(() => {
    if (!screen.queryByRole('button', { name: 'Use it anyway' })
      && !screen.queryByRole('textbox', { name: 'Username' })) throw new Error('still probing');
  });
  const anyway = screen.queryByRole('button', { name: 'Use it anyway' });
  if (anyway) await user.click(anyway);
  await screen.findByRole('textbox', { name: 'Username' });
}

export async function chooseWay(user, { register = false } = {}) {
  if (!register) throw new Error('signing in starts from the address field: use enterAddress');
  await user.click(await screen.findByRole('button', { name: 'Create an account' }));
  await screen.findByRole('textbox', { name: 'Username' });
}

export async function chooseRecovery(user) {
  await user.click(await screen.findByRole('button', { name: 'Recover your account' }));
  await caretIn(await screen.findByRole('textbox', { name: 'Recovery key' }));
}

export async function enterUsername(user, username = 'alice') {
  const field = await screen.findByRole('textbox', { name: 'Username' });
  await caretIn(field);
  await user.clear(field);
  await user.type(field, username);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Password');
}

export async function enterPassword(user, password = PASSWORD, { register = false } = {}) {
  const field = await screen.findByLabelText('Password');
  await caretIn(field);
  await user.clear(field);
  await user.type(field, password);
  if (register) {
    const confirm = await screen.findByLabelText('Confirm password');
    await user.clear(confirm);
    await user.type(confirm, password);
  }
}

export async function submitAuth(user, { register = false, reactivate = false } = {}) {
  const name = register
    ? 'Create account'
    : reactivate ? 'Reactivate account' : 'Sign in';
  await user.click(await screen.findByRole('button', { name }));
}

export async function signIn(user, {
  home = HOME,
  username = 'alice',
  password = PASSWORD,
  register = false,
  submit = true,
} = {}) {
  if (register) {
    await chooseWay(user, { register });
    if (home) await chooseServer(user, home);
    await enterUsername(user, username);
  } else {
    const host = new URL(home || window.location.origin).host;
    await enterAddress(user, `@${username}:${host}`);
    await screen.findByLabelText('Password');
  }
  await enterPassword(user, password, { register });
  if (submit) await submitAuth(user, { register });
}
