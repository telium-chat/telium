import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Reorder, useReorderItem } from '../components/Reorder.jsx';

const H = 40;
const real = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function fake() {
    const i = [...document.querySelectorAll('.drag-item')].indexOf(this);
    if (i < 0) return real.call(this);
    const top = i * H;
    return { top, bottom: top + H, height: H, left: 0, right: 0, width: 200, x: 0, y: top, toJSON() { return this; } };
  };
});
afterAll(() => { Element.prototype.getBoundingClientRect = real; });

function Row({ row }) {
  const { ref, dragProps } = useReorderItem(row);
  return (
    <div ref={ref} {...dragProps} data-key={row.key}>
      <button type="button">{row.key}</button>
    </div>
  );
}

function List({ initial, onDrop = () => {} }) {
  const [rows, setRows] = useState(initial);
  const drop = ({ source, entries, index }) => {
    onDrop({ source, entries, index });
    const group = source.carries || (source.leader ? source.group : null);
    const moving = entries.filter((e) => e === source || (group && e.group === group));
    const before = moving.filter((e) => entries.indexOf(e) < index).length;
    const kept = entries.filter((e) => !moving.includes(e));
    setRows([...kept.slice(0, index - before), ...moving, ...kept.slice(index - before)]);
  };
  return <Reorder onDrop={drop}>{rows.map((row) => <Row key={row.key} row={row} />)}</Reorder>;
}

const order = () => [...document.querySelectorAll('.drag-item')].map((el) => el.dataset.key);
const plain = ['a', 'b', 'c'].map((key) => ({ key }));
const status = () => screen.getByRole('status').textContent;

async function press(initial, name, keys, onDrop) {
  const user = userEvent.setup();
  render(<List initial={initial} onDrop={onDrop} />);
  await user.click(screen.getByRole('button', { name }));
  await user.keyboard(keys);
  return user;
}

const DOWN = '{Alt>}{ArrowDown}{/Alt}';
const UP = '{Alt>}{ArrowUp}{/Alt}';

describe('moving a row with the keyboard', () => {
  it('moves down, announces the slot politely, and keeps focus for the next press', async () => {
    const user = await press(plain, 'a', DOWN);
    await waitFor(() => expect(order()).toEqual(['b', 'a', 'c']));
    await waitFor(() => expect(status()).toBe('a moved to 2 of 3.'));
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('a'));
    await user.keyboard(DOWN);
    await waitFor(() => expect(order()).toEqual(['b', 'c', 'a']));
  });

  it('moves up on Alt+ArrowUp', async () => {
    await press(plain, 'c', UP);
    await waitFor(() => expect(order()).toEqual(['a', 'c', 'b']));
  });

  it.each([
    ['a', UP, 'a is already first.'],
    ['c', DOWN, 'c is already last.'],
  ])('refuses to move %s past the edge and says so', async (name, keys, message) => {
    const onDrop = vi.fn();
    await press(plain, name, keys, onDrop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(order()).toEqual(['a', 'b', 'c']);
    await waitFor(() => expect(status()).toBe(message));
  });

  it('leaves a bare arrow key alone', async () => {
    const onDrop = vi.fn();
    await press(plain, 'a', '{ArrowDown}', onDrop);
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('a heading moved with the keyboard', () => {
  it('takes its channels with it and counts among the rows that stood still', async () => {
    await press([
      { key: 'cat1', carries: 'g1' },
      { key: 'one', group: 'g1' },
      { key: 'cat2', carries: 'g2' },
      { key: 'two', group: 'g2' },
    ], 'cat1', DOWN);
    await waitFor(() => expect(order()).toEqual(['cat2', 'cat1', 'one', 'two']));
    await waitFor(() => expect(status()).toBe('cat1 moved to 2 of 3.'));
  });

  it('will not move a carried row on its own', async () => {
    const onDrop = vi.fn();
    await press([
      { key: 'chan', carries: 'th' },
      { key: 'thread', group: 'th', carried: true },
      { key: 'other' },
    ], 'thread', DOWN, onDrop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(order()).toEqual(['chan', 'thread', 'other']);
  });

  it.each([
    ['text', DOWN, ['lounge', 'amy', 'ben', 'text']],
    ['last', UP, ['last', 'lounge', 'amy', 'ben']],
  ])('never lands %s between a voice channel and the people in it', async (name, keys, want) => {
    const rows = [
      { key: 'lounge', carries: 'vc' },
      { key: 'amy', group: 'vc', carried: true },
      { key: 'ben', group: 'vc', carried: true },
    ];
    await press(name === 'text' ? [{ key: 'text' }, ...rows] : [...rows, { key: 'last' }], name, keys);
    await waitFor(() => expect(order()).toEqual(want));
  });
});
