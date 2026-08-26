// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ThreadList from './ThreadList';

afterEach(cleanup);
const threads = [
  { id: 't1', title: '첫 대화', sessionId: 's1', updatedAt: new Date().toISOString() },
  { id: 't2', title: '둘째 대화', sessionId: 's2', updatedAt: new Date().toISOString() },
];

describe('ThreadList (sidebar)', () => {
  it('renders thread titles and calls onSelect on click', () => {
    const onSelect = vi.fn();
    render(<ThreadList threads={threads} activeId="t1" onSelect={onSelect} onDelete={() => {}} onNew={() => {}} />);
    fireEvent.click(screen.getByText('둘째 대화'));
    expect(onSelect).toHaveBeenCalledWith('t2');
  });
  it('calls onDelete with the thread id (and not onSelect)', () => {
    const onSelect = vi.fn(); const onDelete = vi.fn();
    render(<ThreadList threads={threads} activeId={null} onSelect={onSelect} onDelete={onDelete} onNew={() => {}} />);
    fireEvent.click(screen.getAllByLabelText(/삭제/)[0]);
    expect(onDelete).toHaveBeenCalledWith('t1');
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('has a new-chat button at the top (Claude-app style)', () => {
    const onNew = vi.fn();
    render(<ThreadList threads={threads} activeId={null} onSelect={() => {}} onDelete={() => {}} onNew={onNew} />);
    fireEvent.click(screen.getByRole('button', { name: '새 대화' }));
    expect(onNew).toHaveBeenCalled();
  });
  it('shows an empty state', () => {
    render(<ThreadList threads={[]} activeId={null} onSelect={() => {}} onDelete={() => {}} onNew={() => {}} />);
    expect(screen.getByText(/저장된 대화가 없습니다/)).toBeTruthy();
  });
});
