// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import Composer from './Composer';

afterEach(cleanup);

function setup() {
  const onSend = vi.fn();
  render(<Composer disabled={false} onSend={onSend} />);
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { onSend, input };
}

describe('Composer slash targeting', () => {
  it('typing / opens the section menu; typing narrows it', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.change(input, { target: { value: '/co' } });
    const opts = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent).join(' ');
    expect(opts).toMatch(/container/);
    expect(opts).toMatch(/cost/);
    expect(opts).not.toMatch(/network/);
  });

  it('Enter while the menu is open selects (chip), clears the field, does NOT send (R3/R4)', () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: '/cost' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(screen.getByText(/Cost/)).toBeTruthy(); // chip label
  });

  it('after a chip is set, Enter sends the body to that section', () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: '/cost' } });
    fireEvent.keyDown(input, { key: 'Enter' });            // sets chip
    fireEvent.change(input, { target: { value: '지난달 비용' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('지난달 비용', 'cost');
  });

  it('a plain message routes auto (section null)', () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hi', null);
  });

  it('a fully-typed "/data foo" (menu closed by the space) sends to data', () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: '/data foo' } });
    expect(screen.queryByRole('listbox')).toBeNull(); // space closed the menu
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('foo', 'data');
  });

  it('ArrowDown moves the active option; Escape closes the menu (R5)', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const ad = input.getAttribute('aria-activedescendant');
    expect(ad).toBeTruthy();
    expect(document.getElementById(ad as string)).toBeTruthy(); // points at a real option
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('empty input does not send', () => {
    const { input, onSend } = setup();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Composer multiline (Shift+Enter)', () => {
  it('Shift+Enter does NOT submit and does NOT clear the field (lets a newline through)', () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('line one'); // not cleared → not submitted
  });
  it('plain Enter still submits the message', () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('hello there');
  });
  it('renders a textarea (multiline-capable), not a single-line input', () => {
    const { input } = setup();
    expect(input.tagName).toBe('TEXTAREA');
  });
});
