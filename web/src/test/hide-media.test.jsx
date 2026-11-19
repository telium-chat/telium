import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { MessageRow } from '../views/chat/MessageRow.jsx';
import { mount, signedInStore } from './harness.jsx';

const BOB = '@bob:home.example';

function surface() {
  return {
    id: 'c1', kind: 'channel', guildId: 'g1', encrypted: false, avatarBase: '',
    perms: 0n, mayEdit: () => false, menu: () => null,
    avatarFor: () => ({}), memberOf: () => null, colourFor: () => null,
  };
}

function draw(msg) {
  return mount(
    <MessageRow msg={msg} surface={surface()} grouped={false} onEdit={() => {}} onReply={() => {}} />,
    signedInStore({}),
  );
}

describe('Hide Media', () => {
  it('hides a message\'s media behind a click-to-show line, and brings it back', () => {
    const msg = {
      id: 'hm1', channel_id: 'c1', author: BOB, content: 'look',
      attachments: [{ name: 'cat.png', mime: 'image/png', ref: 'abc' }],
    };
    const { container } = draw(msg);
    expect(container.querySelector('img[src*="abc"]')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Hide Media'));
    expect(container.querySelector('img[src*="abc"]')).toBeNull();
    expect(screen.getByText('Media hidden. Click to show.')).toBeTruthy();

    fireEvent.click(screen.getByText('Media hidden. Click to show.'));
    expect(container.querySelector('img[src*="abc"]')).toBeTruthy();
  });

  it('offers no button on a message without media', () => {
    draw({ id: 'hm2', channel_id: 'c1', author: BOB, content: 'just words' });
    expect(screen.queryByTitle('Hide Media')).toBeNull();
  });
});
