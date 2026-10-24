import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Store } from '../lib/store.js';
import { EditBox } from '../views/chat/MessageRow.jsx';

afterEach(cleanup);

function mount() {
  const store = new Store();
  const surface = { guildId: null, edit: vi.fn(async () => {}) };
  const done = vi.fn();
  const msg = { id: 'm1', content: 'helo' };
  render(<StoreProvider store={store}><EditBox msg={msg} surface={surface} done={done} /></StoreProvider>);
  return { surface, done, msg };
}

describe('the edit box without a keyboard', () => {
  it('saves from the word "save" under the box', async () => {
    const { surface, done, msg } = mount();
    fireEvent.change(screen.getByLabelText('Edit message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(done).toHaveBeenCalled();
    await waitFor(() => expect(surface.edit).toHaveBeenCalledWith(msg, 'hello'));
  });

  it('cancels from the word "cancel" without saving', () => {
    const { surface, done } = mount();
    fireEvent.change(screen.getByLabelText('Edit message'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(done).toHaveBeenCalled();
    expect(surface.edit).not.toHaveBeenCalled();
  });
});
