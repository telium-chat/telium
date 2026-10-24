import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  Checkbox, Field, FilePicker, SearchField, Select, Switch, TextArea, TextInput,
} from '../components/index.js';

describe('Field', () => {
  it('hands the label to a control that labels itself, rather than adding a second', () => {
    render(<Field label="Guild name"><TextInput value="" onChange={() => {}} /></Field>);

    expect(document.querySelectorAll('label')).toHaveLength(1);
    expect(screen.getByLabelText('Guild name').tagName).toBe('INPUT');
  });

  it('lets the control keep a label of its own', () => {
    render(<Field label="Outer"><TextInput label="Inner" value="" onChange={() => {}} /></Field>);

    expect(screen.getByLabelText('Inner')).toBeTruthy();
    expect(screen.queryByLabelText('Outer')).toBe(null);
  });

  it('wraps anything else, keeping the child intact', () => {
    render(
      <Field label="Accent" hint="Behind your name, wherever your card is drawn.">
        <div role="group" aria-label="Accent colour">
          <button type="button">Blue</button>
        </div>
      </Field>,
    );

    expect(screen.getByRole('group', { name: 'Accent colour' })).toBeTruthy();
    expect(screen.getByText('Accent')).toBeTruthy();
    expect(screen.getByText('Behind your name, wherever your card is drawn.')).toBeTruthy();
  });

  it('passes its hint down to a control that labels itself', () => {
    render(
      <Field label="Guild name" hint="Members see this everywhere.">
        <TextInput value="" onChange={() => {}} />
      </Field>,
    );
    expect(screen.getByText('Members see this everywhere.')).toBeTruthy();
  });
});

describe('TextInput', () => {
  it('is named by its label and described by its hint, not named by both', () => {
    render(
      <TextInput label="Minimum account age" hint="Measured on a server you do not run." value="" onChange={() => {}} />,
    );

    const input = screen.getByLabelText('Minimum account age');
    const described = input.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described.split(' ')[0]).textContent)
      .toContain('Measured on a server you do not run.');
  });

  it('falls back to the placeholder for a control with nowhere to put a label', () => {
    render(<TextInput placeholder="Search members" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Search members')).toBeTruthy();
  });

  it('prefers an explicit aria-label to the placeholder', () => {
    render(<TextInput aria-label="Member filter" placeholder="Search members" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Member filter')).toBeTruthy();
  });

  it('stays a controlled field when the value is null', () => {
    render(<TextInput label="Topic" value={null} onChange={() => {}} />);
    expect(screen.getByLabelText('Topic').value).toBe('');
  });

  it('hands over the event, so a text field and a select stay interchangeable', () => {
    const seen = [];
    render(<TextInput label="Topic" value="" onChange={(e) => seen.push(e.target.value)} />);

    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'hello' } });

    expect(seen).toEqual(['hello']);
  });
});

describe('TextArea', () => {
  it('is named by its label and controlled from null', () => {
    render(<TextArea label="Description" value={null} onChange={() => {}} />);

    const area = screen.getByLabelText('Description');
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.value).toBe('');
  });
});

describe('SearchField', () => {
  it('is named even though it has no visible label', () => {
    render(<SearchField value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Search')).toBeTruthy();
  });

  it('takes a name of its own, since several of these sit on one screen', () => {
    render(<SearchField label="Search members" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Search members')).toBeTruthy();
  });

  it('offers no clear button on an empty field, which would do nothing', () => {
    render(<SearchField value="" onChange={() => {}} onClear={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBe(null);
  });

  it('offers one once there is a query, and clears on it', () => {
    const clear = vi.fn();
    render(<SearchField value="ali" onChange={() => {}} onClear={clear} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('offers none at all where the caller has nothing to clear with', () => {
    render(<SearchField value="ali" onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBe(null);
  });
});

describe('Select', () => {
  const options = [['', 'Auto'], ['eu', 'Europe'], ['us', 'North America']];

  it('draws the label of the option that means "none of them"', () => {
    render(<Select label="Voice region" options={options} value="" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Voice region' }).textContent).toContain('Auto');
  });

  it('draws the label of an ordinary option', () => {
    render(<Select label="Voice region" options={options} value="eu" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Voice region' }).textContent).toContain('Europe');
  });

  it('takes bare strings as both value and label', () => {
    render(<Select label="Sort" options={['Newest', 'Oldest']} value="Oldest" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Sort' }).textContent).toContain('Oldest');
  });

  it('matches a numeric option against a string value', () => {
    render(<Select label="Limit" options={[[10, 'Ten'], [25, 'Twenty-five']]} value="25" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Limit' }).textContent).toContain('Twenty-five');
  });

  it('is named without a visible label when it is given one', () => {
    render(<Select aria-label="Voice region" options={options} value="eu" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Voice region' })).toBeTruthy();
  });
});

describe('Checkbox', () => {
  it('hands over the next value, since there is no event to read it off', () => {
    const change = vi.fn();
    render(<Checkbox label="Require verification" checked={false} onChange={change} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Require verification' }));

    expect(change).toHaveBeenCalledWith(true);
  });

  it('describes with the hint rather than being named by it', () => {
    render(
      <Checkbox
        label="Require verification"
        hint="New members must confirm an email before speaking."
        checked={false}
        onChange={() => {}}
      />,
    );

    const box = screen.getByRole('checkbox', { name: 'Require verification' });
    const described = document.getElementById(box.getAttribute('aria-describedby'));
    expect(described.textContent).toBe('New members must confirm an email before speaking.');
  });

  it('is unchecked rather than indeterminate when nobody said', () => {
    render(<Checkbox label="Require verification" checked={undefined} onChange={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'Require verification' }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('Switch', () => {
  it('hands over the next value', () => {
    const change = vi.fn();
    render(<Switch label="Quiet mode" checked onChange={change} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Quiet mode' }));

    expect(change).toHaveBeenCalledWith(false);
  });

  it('keeps its name when the row already shows it', () => {
    render(<Switch label="Manage roles" hideLabel checked={false} onChange={() => {}} />);

    expect(screen.getByRole('switch', { name: 'Manage roles' })).toBeTruthy();
    expect(document.querySelectorAll('label')).toHaveLength(0);
  });

  it('describes with the hint', () => {
    render(<Switch label="Quiet mode" hint="Notifications stay off." checked={false} onChange={() => {}} />);

    const control = screen.getByRole('switch', { name: 'Quiet mode' });
    expect(document.getElementById(control.getAttribute('aria-describedby')).textContent)
      .toBe('Notifications stay off.');
  });
});

describe('FilePicker', () => {
  const file = (name) => new File(['x'], name, { type: 'image/png' });

  it('is a real file input inside a label, which is the only thing allowed to open a picker', () => {
    const { container } = render(<FilePicker label="Choose an avatar" />);

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input.closest('label')).toBeTruthy();
    expect(screen.getByText('Choose an avatar')).toBeTruthy();
  });

  it('hands over one file by default and a list when it takes several', () => {
    const single = vi.fn();
    const { container, unmount } = render(<FilePicker onPick={single} />);
    fireEvent.change(container.querySelector('input'), { target: { files: [file('a.png')] } });
    expect(single.mock.calls[0][0].name).toBe('a.png');
    unmount();

    const many = vi.fn();
    const second = render(<FilePicker multiple onPick={many} />);
    fireEvent.change(second.container.querySelector('input'), {
      target: { files: [file('a.png'), file('b.png')] },
    });
    expect(many.mock.calls[0][0].map((f) => f.name)).toEqual(['a.png', 'b.png']);
  });

  it('says nothing when the picker was cancelled', () => {
    const pick = vi.fn();
    const { container } = render(<FilePicker onPick={pick} />);

    fireEvent.change(container.querySelector('input'), { target: { files: [] } });

    expect(pick).not.toHaveBeenCalled();
  });
});
