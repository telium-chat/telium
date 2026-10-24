import { render } from '@testing-library/react';
import {
  afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { Store } from '../lib/store.js';
import { setLocale } from '../lib/i18n/index.js';
import { EN } from '../lib/i18n/catalog/index.js';
import { installPseudo, pseudoCatalog } from '../lib/i18n/pseudo.js';
import { MigrationBanner } from '../views/MigrationBanner.jsx';
import { AppearancePane } from '../views/user-settings/AppearancePane.jsx';

const FIXED_SIZE = /(?:^|\s)(?:w|h|size)-(?:\d|\[)/;
const CLIPS = /(?:^|\s)(?:truncate|overflow-hidden|whitespace-nowrap)(?:\s|$)/;
const SHRINKABLE = /(?:^|\s)(?:min-w-0|w-full|flex-1|basis-0|grid|absolute|fixed)(?:\s|$)/;

function holdsText(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
  }
  return false;
}

function describeEl(el) {
  const text = (el.textContent || '').trim().slice(0, 40);
  return `<${el.tagName.toLowerCase()} class="${el.className}">${text}`;
}

function clippingRisks(container) {
  const risks = [];
  for (const el of container.querySelectorAll('*')) {
    const cls = typeof el.className === 'string' ? el.className : '';

    if (holdsText(el) && FIXED_SIZE.test(cls)) {
      risks.push(`fixed size on a text box: ${describeEl(el)}`);
    }
    const inline = el.getAttribute('style') || '';
    if (holdsText(el) && /(?:^|;)\s*(?:width|height)\s*:\s*\d/.test(inline)) {
      risks.push(`inline fixed size on a text box: ${describeEl(el)}`);
    }

    const parentCls = typeof el.parentElement?.className === 'string' ? el.parentElement.className : '';
    const inFlexRow = /(?:^|\s)flex(?:\s|$)/.test(parentCls) && !/flex-col/.test(parentCls);
    if (inFlexRow && CLIPS.test(cls) && !SHRINKABLE.test(cls)) {
      risks.push(`truncating flex child with no min-w-0: ${describeEl(el)}`);
    }
  }
  return risks;
}

function latinRuns(container, allowed = []) {
  const runs = new Set();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const run of (node.textContent || '').match(/[A-Za-z]{3,}/g) || []) {
      if (!allowed.some((ok) => ok.toLowerCase().includes(run.toLowerCase()))) runs.add(run);
    }
  }
  return [...runs];
}

const HOME = 'home.example';

function migrationStore() {
  const store = new Store();
  store.session = { home: { user_id: '@alice:home.example', device_id: 'd1', domain: HOME } };
  store.home = {
    domain: HOME,
    migrationAlerts: vi.fn(async () => ({
      alerts: [{
        id: 'm1',
        subject_type: 'user',
        subject_id: '@alice:home.example',
        destination: 'new.example',
        state: 'pending',
        created_at: Date.now(),
        executes_at: Date.now() + 24 * 3600 * 1000,
        email: 'sent',
      }],
    })),
    cancelMigration: vi.fn(async (id) => ({ id, state: 'cancelled' })),
  };
  return store;
}

function settingsStore() {
  const store = new Store();
  store.session = { home: { user_id: '@alice:home.example', device_id: 'd1', domain: HOME } };
  Object.assign(store.prefs, { theme: 'dark', scheme: 'custom', locale: 'auto' });
  return store;
}

function draw(ui, store) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>{ui}</ModalProvider>
    </StoreProvider>,
  );
}

const SCREENS = [
  {
    name: 'the migration banner',
    async mount() {
      const store = migrationStore();
      await store.loadMigrationAlerts();
      return draw(<MigrationBanner />, store);
    },
    allowed: ['new.example', 'home.example', 'alice'],
  },
  {
    name: 'the appearance and language pane',
    async mount() {
      return draw(<AppearancePane />, settingsStore());
    },
    allowed: ['English', 'auto'],
  },
];

beforeAll(() => {
  installPseudo('xx-long');
  installPseudo('xx-kana');
});

afterEach(async () => {
  await setLocale('en');
});

describe('pseudolocales', () => {
  it('pads short strings past the 40% growth and keeps the ICU machinery intact', () => {
    const long = pseudoCatalog('xx-long');
    expect(long['common.no'].length).toBeGreaterThan(EN['common.no'].length + 3);
    const kana = pseudoCatalog('xx-kana');
    expect(kana['common.save']).not.toMatch(/[A-Za-z]/);
    expect(kana['common.convo.group']).toContain('{count, plural,');
    expect(kana['common.convo.group']).toContain('other {');
    expect(kana['common.a11y.stepDone']).toContain('{step}');
  });
});

describe.each(SCREENS)('$name', (screen) => {
  it('has no structural clipping risk under long strings', async () => {
    await setLocale('xx-long');
    const { container } = await screen.mount();
    expect(clippingRisks(container)).toEqual([]);
  });

  it('leaves no untranslated Latin text under xx-kana', async () => {
    await setLocale('xx-kana');
    const { container } = await screen.mount();
    expect(latinRuns(container, screen.allowed)).toEqual([]);
  });
});

it('draws the same element tree in every language', async () => {
  const shapeOf = (container) => [...container.querySelectorAll('*')]
    .map((el) => `${el.tagName}.${typeof el.className === 'string' ? el.className : ''}`);
  const english = shapeOf((await SCREENS[1].mount()).container);
  await setLocale('xx-long');
  expect(shapeOf((await SCREENS[1].mount()).container)).toEqual(english);
});
