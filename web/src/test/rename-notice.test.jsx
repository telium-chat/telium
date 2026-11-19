import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { RenameNoticeRow } from '../views/chat/RenameNotice.jsx';
import { mount, signedInStore } from './harness.jsx';

describe('the rename line', () => {
  it('says who renamed the group and to what', () => {
    mount(<RenameNoticeRow entry={{ id: 'rename:1', author: '@bob:home.example', name: 'Game night', created_at: 1 }} />, signedInStore({}));
    expect(screen.getByText(/renamed the group to “Game night”/)).toBeTruthy();
  });

  it('says so when the name was removed', () => {
    mount(<RenameNoticeRow entry={{ id: 'rename:2', author: '@bob:home.example', name: null, created_at: 1 }} />, signedInStore({}));
    expect(screen.getByText(/removed the group name/)).toBeTruthy();
  });
});
