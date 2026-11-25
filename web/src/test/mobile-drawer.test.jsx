import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDrawer } from '../views/mobile/MobileDrawer.jsx';
import { dragProgress, pickDrawerDrag, settleOpen, useDrawerGestures } from '../views/mobile/drawer-gesture.js';
import { BackDepthContext, backLevel, useMobileBackDismiss } from '../hooks/useMobileBackDismiss.js';

describe('drawer drag decisions', () => {
  it('opens the drawer toward the inline end and members toward the start, off messages', () => {
    const base = { drawerOpen: false, membersOpen: false, membersAvailable: true };
    expect(pickDrawerDrag({ ...base, dx: 30 })).toBe('open-drawer');
    expect(pickDrawerDrag({ ...base, dx: -30 })).toBe('open-members');
    expect(pickDrawerDrag({ ...base, dx: -30, onMessage: true })).toBeNull();
    expect(pickDrawerDrag({ ...base, dx: 30, onMessage: true })).toBe('open-drawer');
    expect(pickDrawerDrag({ ...base, dx: -30, membersAvailable: false })).toBeNull();
  });

  it('mirrors directions in RTL', () => {
    const base = { drawerOpen: false, membersOpen: false, membersAvailable: true, rtl: true };
    expect(pickDrawerDrag({ ...base, dx: -30 })).toBe('open-drawer');
    expect(pickDrawerDrag({ ...base, dx: 30 })).toBe('open-members');
    expect(pickDrawerDrag({ ...base, drawerOpen: true, dx: 30 })).toBe('close-drawer');
  });

  it('only closes an open panel toward its own edge', () => {
    expect(pickDrawerDrag({ dx: -30, drawerOpen: true })).toBe('close-drawer');
    expect(pickDrawerDrag({ dx: 30, drawerOpen: true })).toBeNull();
    expect(pickDrawerDrag({ dx: 30, membersOpen: true })).toBe('close-members');
    expect(pickDrawerDrag({ dx: -30, membersOpen: true })).toBeNull();
  });

  it('tracks the finger as a fraction of the panel width, clamped', () => {
    expect(dragProgress('open-drawer', 150, 300)).toBe(0.5);
    expect(dragProgress('open-drawer', 900, 300)).toBe(1);
    expect(dragProgress('close-drawer', -75, 300)).toBe(0.75);
    expect(dragProgress('open-members', -150, 300)).toBe(0.5);
    expect(dragProgress('close-members', 300, 300)).toBe(0);
  });

  it('settles by fling over position', () => {
    expect(settleOpen('open-drawer', 0.2, 0.8)).toBe(true);
    expect(settleOpen('open-drawer', 0.9, -0.8)).toBe(false);
    expect(settleOpen('open-drawer', 0.6, 0.05)).toBe(true);
    expect(settleOpen('close-drawer', 0.6, -0.5)).toBe(false);
    expect(settleOpen('open-members', 0.2, -0.6)).toBe(true);
  });
});

function Harness({ onSettle }) {
  const root = useRef(null);
  const drawer = useRef(null);
  const [open, setOpen] = useState(false);
  useDrawerGestures(root, {
    drawerOpen: open,
    membersOpen: false,
    membersAvailable: false,
    drawers: { drawer: () => drawer.current },
    onSettle: (which, next) => { onSettle(which, next); setOpen(next); },
  });
  return (
    <div ref={root} data-testid="shell">
      <p data-testid="content">hello</p>
      <MobileDrawer ref={drawer} open={open} onClose={() => setOpen(false)} closeLabel="Close menu">
        <span>channels</span>
      </MobileDrawer>
    </div>
  );
}

describe('MobileDrawer with gestures', () => {
  let raf;
  beforeEach(() => {
    raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
  });
  afterEach(() => raf.mockRestore());

  const touch = (el, type, x, y = 100, timeStamp = 0) => {
    const key = type === 'touchEnd' || type === 'touchCancel' ? 'changedTouches' : 'touches';
    const event = createEvent[type](el, { [key]: [{ clientX: x, clientY: y }], ...(key === 'changedTouches' ? { touches: [] } : {}) });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    fireEvent(el, event);
  };

  it('stays mounted and inert while closed', () => {
    render(<Harness onSettle={() => {}} />);
    expect(screen.getByText('channels')).toBeTruthy();
    expect(document.querySelector('[data-drawer-panel]').hasAttribute('inert')).toBe(true);
  });

  it('follows a drag and opens once released past half way', () => {
    const settle = vi.fn();
    render(<Harness onSettle={settle} />);
    const content = screen.getByTestId('content');
    const drawerEl = document.querySelector('.mobile-drawer');
    document.querySelector('[data-drawer-panel]').getBoundingClientRect = () => ({ width: 300 });

    touch(content, 'touchStart', 20, 100, 1);
    touch(content, 'touchMove', 40, 100, 20);
    expect(drawerEl.hasAttribute('data-dragging')).toBe(true);
    touch(content, 'touchMove', 190, 100, 200);
    expect(Number(drawerEl.style.getPropertyValue('--drawer-progress'))).toBeCloseTo(0.5);
    touch(content, 'touchMove', 230, 100, 400);
    act(() => touch(content, 'touchEnd', 230, 100, 420));

    expect(settle).toHaveBeenCalledWith('drawer', true);
    expect(drawerEl.hasAttribute('data-dragging')).toBe(false);
    expect(drawerEl.style.getPropertyValue('--drawer-progress')).toBe('1');
    expect(document.querySelector('[data-drawer-panel]').hasAttribute('inert')).toBe(false);
  });

  it('snaps back when a short slow drag is released', () => {
    const settle = vi.fn();
    render(<Harness onSettle={settle} />);
    const content = screen.getByTestId('content');
    const drawerEl = document.querySelector('.mobile-drawer');
    document.querySelector('[data-drawer-panel]').getBoundingClientRect = () => ({ width: 300 });

    touch(content, 'touchStart', 20, 100, 1);
    touch(content, 'touchMove', 40, 100, 100);
    touch(content, 'touchMove', 60, 100, 400);
    touch(content, 'touchEnd', 60, 100, 500);
    expect(settle).not.toHaveBeenCalled();
    expect(drawerEl.style.getPropertyValue('--drawer-progress')).toBe('0');
  });

  it('ignores vertical scrolling', () => {
    const settle = vi.fn();
    render(<Harness onSettle={settle} />);
    const content = screen.getByTestId('content');
    const drawerEl = document.querySelector('.mobile-drawer');
    touch(content, 'touchStart', 20, 100);
    touch(content, 'touchMove', 30, 160);
    touch(content, 'touchMove', 200, 170);
    touch(content, 'touchEnd', 200, 170);
    expect(drawerEl.hasAttribute('data-dragging')).toBe(false);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('Back dismiss order', () => {
  function Layer({ name, active, base = false, level, log, children = null }) {
    useMobileBackDismiss(() => log.push(name), { active, base, level });
    return children;
  }

  function Modal({ depth, name, log, children }) {
    return (
      <BackDepthContext.Provider value={depth}>
        <Layer name={name} active level={backLevel.modal(depth)} log={log} />
        {children}
      </BackDepthContext.Provider>
    );
  }

  it('routes Back to a confirm over a settings page, then the page, then the modal', () => {
    const log = [];
    const page = { current: true };
    function App({ confirm }) {
      return (
        <>
          <Layer name="shell" active base log={log} />
          <Modal depth={1} name="settings" log={log}>
            <Layer name="settings-page" active={page.current} log={log} />
          </Modal>
          {confirm ? <Modal depth={2} name="confirm" log={log} /> : null}
        </>
      );
    }
    const { rerender } = render(<App confirm />);
    window.dispatchEvent(new Event('androidback'));
    rerender(<App confirm={false} />);
    window.dispatchEvent(new Event('androidback'));
    page.current = false;
    rerender(<App confirm={false} />);
    window.dispatchEvent(new Event('androidback'));
    expect(log).toEqual(['confirm', 'settings-page', 'settings']);
  });

  it('keeps an open panel in the app below a modal opened over it', () => {
    const log = [];
    const { rerender } = render(<Layer name="emoji-panel" active log={log} />);
    rerender(<>
      <Layer name="emoji-panel" active log={log} />
      <Modal depth={1} name="profile" log={log} />
    </>);
    window.dispatchEvent(new Event('androidback'));
    expect(log).toEqual(['profile']);
  });

  it('keeps the shell under a modal that mounted before it and was already open', () => {
    const log = [];
    // The modal provider renders before the shell, as in the app.
    const { rerender } = render(<>
      <Layer name="modal" active log={log} />
      <Layer name="shell" active={false} base log={log} />
    </>);
    rerender(<>
      <Layer name="modal" active log={log} />
      <Layer name="shell" active base log={log} />
    </>);
    window.dispatchEvent(new Event('androidback'));
    expect(log).toEqual(['modal']);
  });

  it('puts a modal opened later above the shell', () => {
    const log = [];
    const { rerender } = render(<>
      <Layer name="modal" active={false} log={log} />
      <Layer name="shell" active base log={log} />
    </>);
    rerender(<>
      <Layer name="modal" active log={log} />
      <Layer name="shell" active base log={log} />
    </>);
    window.dispatchEvent(new Event('androidback'));
    expect(log).toEqual(['modal']);
  });
});
