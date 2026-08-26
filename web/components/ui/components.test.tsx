// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import Button from './Button';
import Badge from './Badge';
import StatePill from './StatePill';
import Meter from './Meter';
import StatTile from './StatTile';
import StatCard from './StatCard';
import Card from './Card';
import SectionLabel from './SectionLabel';
import PageHeader from './PageHeader';

afterEach(cleanup);

describe('Button', () => {
  it('renders children and applies the primary variant class', () => {
    const { container } = render(<Button>저장</Button>);
    expect(screen.getByText('저장')).toBeTruthy();
    expect(container.querySelector('button')!.className).toContain('bg-brand-action');
  });

  it('applies the secondary variant class', () => {
    const { container } = render(<Button variant="secondary">취소</Button>);
    const cls = container.querySelector('button')!.className;
    expect(cls).toContain('bg-card');
    expect(cls).toContain('border-ink-100');
  });

  it('applies size classes (sm=30px)', () => {
    const { container } = render(<Button size="sm">x</Button>);
    expect(container.querySelector('button')!.className).toContain('h-[30px]');
  });
});

describe('Badge', () => {
  it('renders the tone styling (positive soft)', () => {
    const { container } = render(<Badge tone="positive">OK</Badge>);
    const cls = container.querySelector('span')!.className;
    expect(cls).toContain('bg-emerald-50');
    expect(cls).toContain('text-emerald-700');
  });

  it('renders a leading dot when dot=true', () => {
    const { container } = render(
      <Badge tone="negative" dot>
        Err
      </Badge>,
    );
    // outer span + dot span
    expect(container.querySelectorAll('span').length).toBeGreaterThanOrEqual(2);
  });
});

describe('StatePill', () => {
  it("maps 'running' to positive styling", () => {
    const { container } = render(<StatePill value="running" />);
    const cls = container.querySelector('span')!.className;
    expect(cls).toContain('bg-emerald-50');
  });

  it("maps 'CrashLoopBackOff' to negative styling", () => {
    const { container } = render(<StatePill value="CrashLoopBackOff" />);
    expect(container.querySelector('span')!.className).toContain('bg-rose-50');
  });

  it("maps 'Pending' to brand styling", () => {
    const { container } = render(<StatePill value="Pending" />);
    expect(container.querySelector('span')!.className).toContain('bg-brand-50');
  });

  it("maps 'stopped' to neutral styling", () => {
    const { container } = render(<StatePill value="stopped" />);
    expect(container.querySelector('span')!.className).toContain('bg-ink-100');
  });
});

describe('Meter', () => {
  it('colors emerald below 50', () => {
    const { container } = render(<Meter value={17} />);
    expect(container.innerHTML).toContain('bg-emerald-500');
    expect(screen.getByText('17%')).toBeTruthy();
  });

  it('colors brand in [50,75)', () => {
    const { container } = render(<Meter value={60} />);
    expect(container.innerHTML).toContain('bg-brand-500');
  });

  it('colors rose at or above 75', () => {
    const { container } = render(<Meter value={92} />);
    expect(container.innerHTML).toContain('bg-rose-500');
  });

  it('clamps values above 100', () => {
    render(<Meter value={150} />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('clamps values below 0', () => {
    render(<Meter value={-10} />);
    expect(screen.getByText('0%')).toBeTruthy();
  });
});

describe('StatTile (legacy StatCard props)', () => {
  it('renders label + value from the old { label, value, accent } shape', () => {
    render(<StatTile label="EKS 클러스터" value={8} accent="#00d4ff" />);
    expect(screen.getByText('EKS 클러스터')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
  });

  it('StatCard alias renders identically to StatTile', () => {
    render(<StatCard label="Jobs 성공" value={3} accent="#00ff88" />);
    expect(screen.getByText('Jobs 성공')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('danger variant uses rose value color', () => {
    const { container } = render(<StatTile label="Security Issues" value={9} variant="danger" />);
    expect(container.innerHTML).toContain('text-rose-700');
  });

  it('accent variant renders the AwsopsMark watermark', () => {
    const { container } = render(<StatTile label="EC2" value={25} variant="accent" />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('compact size shrinks the value text and hides hint/trend/watermark (design handoff 개선안 ①)', () => {
    const { container } = render(
      <StatTile label="VPC" value={4} size="compact" hint="ignored" trend="↑1%" variant="accent" />,
    );
    expect(container.innerHTML).toContain('text-[19px]');
    expect(container.innerHTML).not.toContain('text-[26px]');
    expect(screen.queryByText('ignored')).toBeNull();
    expect(screen.queryByText('↑1%')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('Card / SectionLabel / PageHeader', () => {
  it('Card renders children and the card surface classes', () => {
    const { container } = render(<Card>body</Card>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain('bg-card');
    expect(cls).toContain('border-ink-100');
    expect(cls).toContain('shadow-card');
    expect(screen.getByText('body')).toBeTruthy();
  });

  it('SectionLabel renders uppercase eyebrow text', () => {
    const { container } = render(<SectionLabel>운영 요약</SectionLabel>);
    expect(container.firstElementChild!.className).toContain('uppercase');
    expect(screen.getByText('운영 요약')).toBeTruthy();
  });

  it('SectionLabel renders a leading color dot and a trailing right slot', () => {
    const { container } = render(
      <SectionLabel dot="var(--negative)" right={<span>모두 정상</span>}>
        요주의
      </SectionLabel>,
    );
    expect(container.querySelector('span[style*="background"]')).toBeTruthy();
    expect(screen.getByText('모두 정상')).toBeTruthy();
  });

  it('PageHeader renders the title and a live badge when live', () => {
    render(<PageHeader title="대시보드" live subtitle="요약" />);
    expect(screen.getByText('대시보드')).toBeTruthy();
    expect(screen.getByText('실시간')).toBeTruthy();
    expect(screen.getByText('요약')).toBeTruthy();
  });
});
