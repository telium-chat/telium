import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChoiceCard, ChoiceList } from '../components/index.js';

const Glyph = (props) => <svg {...props} data-testid="glyph" />;

const options = (
  <>
    <ChoiceCard value="text" label="Text channel" description="Messages, files and threads." />
    <ChoiceCard value="voice" label="Voice channel" description="Talk and screen share." />
  </>
);

describe('a list holding a value', () => {
  it('is a radio group, so the reader is told it is one choice of several', () => {
    render(<ChoiceList value="text" onChange={() => {}}>{options}</ChoiceList>);

    expect(screen.getByRole('radiogroup')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('marks the chosen card and only the chosen card', () => {
    render(<ChoiceList value="voice" onChange={() => {}}>{options}</ChoiceList>);

    expect(screen.getByRole('radio', { name: /Voice channel/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Text channel/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('reports the value of the card that was picked', () => {
    const change = vi.fn();
    render(<ChoiceList value="text" onChange={change}>{options}</ChoiceList>);

    fireEvent.click(screen.getByRole('radio', { name: /Voice channel/ }));

    expect(change).toHaveBeenCalledWith('voice', expect.anything());
  });

  it('carries the explanation into the name, since that is the difference', () => {
    render(<ChoiceList value="text" onChange={() => {}}>{options}</ChoiceList>);
    expect(screen.getByRole('radio', { name: /Messages, files and threads\./ })).toBeTruthy();
  });

  it('cannot pick a disabled card', () => {
    const change = vi.fn();
    render(
      <ChoiceList value="text" onChange={change}>
        <ChoiceCard value="text" label="Text channel" />
        <ChoiceCard value="voice" label="Voice channel" disabled />
      </ChoiceList>,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Voice channel' }));

    expect(change).not.toHaveBeenCalled();
  });
});

describe('a list holding nothing', () => {
  it('stays buttons, rather than promising a selection that never arrives', () => {
    render(
      <ChoiceList>
        <ChoiceCard label="Create a guild" description="Start something new." onClick={() => {}} />
        <ChoiceCard label="Join a guild" description="You need an invite." onClick={() => {}} />
      </ChoiceList>,
    );

    expect(screen.queryByRole('radiogroup')).toBe(null);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('goes where the card points', () => {
    const go = vi.fn();
    render(<ChoiceList><ChoiceCard label="Join a guild" onClick={go} /></ChoiceList>);

    fireEvent.click(screen.getByRole('button', { name: 'Join a guild' }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('does not submit the dialog it is sitting in', () => {
    const submitted = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={submitted}><ChoiceList><ChoiceCard label="Join a guild" /></ChoiceList></form>);

    fireEvent.click(screen.getByRole('button', { name: 'Join a guild' }));
    expect(submitted).not.toHaveBeenCalled();
  });

  it('cannot be pressed when it is disabled', () => {
    const go = vi.fn();
    render(<ChoiceList><ChoiceCard label="Join a guild" disabled onClick={go} /></ChoiceList>);

    fireEvent.click(screen.getByRole('button', { name: 'Join a guild' }));
    expect(go).not.toHaveBeenCalled();
  });
});

describe('the card itself', () => {
  it('draws a glyph when it is given one, in either shape', () => {
    const { unmount } = render(<ChoiceList><ChoiceCard label="Join" icon={Glyph} /></ChoiceList>);
    expect(screen.getByTestId('glyph')).toBeTruthy();
    unmount();

    render(<ChoiceList value="a" onChange={() => {}}><ChoiceCard value="a" label="Join" icon={Glyph} /></ChoiceList>);
    expect(screen.getByTestId('glyph')).toBeTruthy();
  });

  it('reads fine with a label alone', () => {
    render(<ChoiceList><ChoiceCard label="Join a guild" /></ChoiceList>);
    expect(screen.getByRole('button', { name: 'Join a guild' })).toBeTruthy();
  });

  it('lets a caller put something else where the radio dot goes', () => {
    render(
      <ChoiceList value="a" onChange={() => {}}>
        <ChoiceCard value="a" label="Pro" trailing={<span>$5/mo</span>} />
      </ChoiceList>,
    );
    expect(screen.getByText('$5/mo')).toBeTruthy();
  });
});
