import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MediaTierSection } from '../views/user-settings/AccountPane.jsx';

function storeFor({ quota, used }) {
  return {
    session: { home: { domain: 'home.example' } },
    caps: new Map([[
      'home.example',
      { account: { tier1_upload: true, quota_bytes: quota, used_bytes: used } },
    ]]),
    mediaPreference: { tier: 1, origin: null },
    setMediaPreference: vi.fn(),
  };
}

function mediaSection({ quota, used }) {
  return render(
    <MediaTierSection
      store={storeFor({ quota, used })}
      pref={{ tier: 1, origin: null }}
      hosts={[]}
      externalHosts={[]}
    />,
  );
}

describe('the media quota line', () => {
  it('says what the account has used against its ceiling', () => {
    mediaSection({ quota: 1024, used: 100 });
    expect(screen.getByText(/used on home\.example/).textContent).toMatch(/100/);
  });

  it('warns near the ceiling and points at the way out', () => {
    mediaSection({ quota: 1024, used: 1000 });
    const warn = screen.getByText(/used on home\.example/);
    expect(warn.textContent).toMatch(/Delete files/);
  });

  it('says nothing when the server puts no ceiling on uploads', () => {
    mediaSection({ quota: null, used: 500 });
    expect(screen.queryByText(/used on/)).toBeNull();
  });
});
