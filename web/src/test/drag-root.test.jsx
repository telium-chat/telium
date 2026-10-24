import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DndProvider, useDragDropManager } from 'react-dnd';
import { useDragRoot } from '../hooks/useDragRoot.js';

function Probe({ report }) {
  report(useDragDropManager());
  return null;
}

function List({ label, report }) {
  const [setRoot, manager] = useDragRoot();
  return (
    <div ref={setRoot} data-testid={label}>
      {manager ? (
        <DndProvider manager={manager}>
          <Probe report={report} />
        </DndProvider>
      ) : null}
    </div>
  );
}

describe('a drag context per list', () => {
  it('listens on the list that asked for it, not on the first one that mounted', () => {
    const seen = {};
    const { getByTestId } = render(
      <>
        <List label="rail" report={(m) => { seen.rail = m; }} />
        <List label="sidebar" report={(m) => { seen.sidebar = m; }} />
      </>,
    );

    expect(seen.rail).toBeTruthy();
    expect(seen.sidebar).toBeTruthy();
    expect(seen.rail).not.toBe(seen.sidebar);

    expect(seen.rail.getBackend().rootElement).toBe(getByTestId('rail'));
    expect(seen.sidebar.getBackend().rootElement).toBe(getByTestId('sidebar'));
  });
});
