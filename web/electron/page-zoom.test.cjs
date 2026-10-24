'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PAGE_ZOOM_FACTORS,
  stepPageZoomFactor,
  classifyPageZoomKeys,
  createPageZoomHandler,
} = require('./page-zoom.cjs');

test('zoom steps move one stop along the Chromium table', () => {
  assert.equal(stepPageZoomFactor(1, 1), 1.1);
  assert.equal(stepPageZoomFactor(1.1, 1), 1.25);
  assert.equal(stepPageZoomFactor(1, -1), 0.9);
  assert.equal(stepPageZoomFactor(0.9, -1), 0.8);
  assert.equal(stepPageZoomFactor(1, 0), 1);
  assert.equal(stepPageZoomFactor(2.5, 0), 1);
});

test('zoom steps clamp at the ends of the table', () => {
  const min = PAGE_ZOOM_FACTORS[0];
  const max = PAGE_ZOOM_FACTORS[PAGE_ZOOM_FACTORS.length - 1];
  assert.equal(stepPageZoomFactor(max, 1), max);
  assert.equal(stepPageZoomFactor(min, -1), min);
  assert.equal(stepPageZoomFactor(99, 1), max);
  assert.equal(stepPageZoomFactor(0.01, -1), min);
});

test('between-stop factors move to the adjacent stop, not the nearest', () => {
  // 0.95 sits between 0.9 and 1.
  assert.equal(stepPageZoomFactor(0.95, 1), 1);
  assert.equal(stepPageZoomFactor(0.95, -1), 0.9);
});

test('zoom-out then zoom-in returns to where it started', () => {
  let factor = 1;
  factor = stepPageZoomFactor(factor, -1);
  factor = stepPageZoomFactor(factor, -1);
  factor = stepPageZoomFactor(factor, 1);
  factor = stepPageZoomFactor(factor, 1);
  assert.equal(factor, 1);
});

test('every layout of the bigger/smaller/reset keys classifies', () => {
  // US Shift+=, bare =, numpad +.
  assert.equal(classifyPageZoomKeys({ key: '+', code: 'Equal' }), 'in');
  assert.equal(classifyPageZoomKeys({ key: '=', code: 'Equal' }), 'in');
  assert.equal(classifyPageZoomKeys({ key: '+', code: 'NumpadAdd' }), 'in');
  assert.equal(classifyPageZoomKeys({ key: '-', code: 'Minus' }), 'out');
  assert.equal(classifyPageZoomKeys({ key: '_', code: 'Minus' }), 'out');
  assert.equal(classifyPageZoomKeys({ key: '-', code: 'NumpadSubtract' }), 'out');
  assert.equal(classifyPageZoomKeys({ key: '0', code: 'Digit0' }), 'reset');
  assert.equal(classifyPageZoomKeys({ key: '0', code: 'Numpad0' }), 'reset');
  assert.equal(classifyPageZoomKeys({ key: 'k', code: 'KeyK' }), null);
  assert.equal(classifyPageZoomKeys({ key: '', code: '' }), null);
});

function harness(factor = 1) {
  const events = [];
  let current = factor;
  const handler = createPageZoomHandler({
    getFactor: () => current,
    setFactor: (next) => { current = next; },
  });
  return {
    handler,
    factor: () => current,
    press(input) {
      const event = {
        prevented: false,
        preventDefault() { this.prevented = true; events.push(input); },
      };
      const handled = handler(event, { type: 'keyDown', ...input });
      return { handled, prevented: event.prevented };
    },
  };
}

test('Ctrl+= and Ctrl+Shift+= zoom in exactly once', () => {
  for (const input of [
    { key: '=', code: 'Equal', control: true },
    { key: '+', code: 'Equal', control: true, shift: true },
  ]) {
    const h = harness(1);
    const { handled, prevented } = h.press(input);
    assert.equal(handled, true);
    assert.equal(prevented, true);
    assert.equal(h.factor(), 1.1);
  }
});

test('Ctrl+- zooms out and Ctrl+0 resets', () => {
  const h = harness(1.25);
  h.press({ key: '-', code: 'Minus', control: true });
  assert.equal(h.factor(), 1.1);
  h.press({ key: '0', code: 'Digit0', control: true });
  assert.equal(h.factor(), 1);
});

test('Cmd chords work too, Alt chords and bare keys are left alone', () => {
  const meta = harness(1);
  meta.press({ key: '+', code: 'Equal', meta: true });
  assert.equal(meta.factor(), 1.1);

  const alt = harness(1);
  const altPress = alt.press({ key: '+', code: 'Equal', control: true, alt: true });
  assert.equal(altPress.handled, false);
  assert.equal(alt.factor(), 1);

  const bare = harness(1);
  const barePress = bare.press({ key: '=', code: 'Equal' });
  assert.equal(barePress.handled, false);
  assert.equal(bare.factor(), 1);
});

test('key releases and unrelated chords never zoom', () => {
  const h = harness(1);
  assert.equal(h.press({ key: '+', code: 'Equal', control: true }).handled, true);
  const after = h.factor();
  const upEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(h.handler(upEvent, { type: 'keyUp', key: '+', code: 'Equal', control: true }), false);
  assert.equal(upEvent.prevented, false);
  assert.equal(h.factor(), after);
  const quickSwitcher = h.press({ key: 'k', code: 'KeyK', control: true });
  assert.equal(quickSwitcher.handled, false);
  assert.equal(h.factor(), after);
});
