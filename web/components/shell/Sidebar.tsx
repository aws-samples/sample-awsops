'use client';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, MessagesSquare, Activity, DollarSign,
  Box, Gauge,
  Server, Zap, Container, Package,
  Archive, HardDrive, Database, Table, DatabaseZap, Search, Radio,
  Network, Waypoints, Locate, BrickWall, Globe, Scale, Split, Webhook, Cable, CloudCog, Route, ListFilter, Router, Flame,
  KeyRound, Users, Shield, FileSearch, Bell,
  Stethoscope, // /ai-diagnosis nav (this branch)
  Cpu, Lock, Target, ShieldAlert, Milestone, ChevronRight, Boxes, Layers, Terminal,
  type LucideIcon,
} from 'lucide-react';
import { navTree, groupForPath, type NavLeaf, type NavGroupNode } from '@/lib/inventory-types';
import AwsopsMark from '@/components/ui/AwsopsMark';
import SectionLabel from '@/components/ui/SectionLabel';
import { useI18n } from '@/components/shell/LanguageProvider';
import LanguageToggle from '@/components/shell/LanguageToggle';
import UserIdentity from '@/components/shell/UserIdentity';
import ChangelogVersion from './ChangelogVersion';
import ThemeToggle from '@/components/shell/ThemeToggle';
import ScopeSelector from '@/components/shell/ScopeSelector';
import { cn } from '@/lib/cn';

// Fixed top-level pages. `tkey` resolves the label via i18n.
const FIXED: { href: string; tkey: string; icon: LucideIcon }[] = [
  { href: '/', tkey: 'nav.overview', icon: LayoutDashboard },
  { href: '/ai-diagnosis', tkey: 'nav.aiDiagnosis', icon: Stethoscope },
  { href: '/assistant', tkey: 'nav.assistant', icon: MessagesSquare },
  { href: '/jobs', tkey: 'nav.jobs', icon: Activity },
  { href: '/cost', tkey: 'nav.cost', icon: DollarSign },
  { href: '/bedrock', tkey: 'nav.bedrock', icon: Gauge },
  { href: '/agentcore', tkey: 'nav.agentcore', icon: Cpu },
  { href: '/topology', tkey: 'nav.topology', icon: Network },
  { href: '/security', tkey: 'nav.security', icon: Shield },
  { href: '/compliance', tkey: 'nav.compliance', icon: FileSearch },
  { href: '/integrations', tkey: 'nav.integrations', icon: Cable },
  { href: '/accounts', tkey: 'nav.accounts', icon: Users },
];

// One distinct lucide icon per inventory type (keyed by the registry slug).
const TYPE_ICON: Record<string, LucideIcon> = {
  // Compute
  ec2: Server,
  lambda: Zap,
  ecs_cluster: Container,
  ecs_task: Container,
  ecr: Package,
  // Storage & DB
  s3: Archive,
  ebs_volume: HardDrive,
  rds: Database,
  dynamodb: Table,
  elasticache: DatabaseZap,
  opensearch: Search,
  msk: Radio,
  // Network
  vpc: Network,
  subnet: Waypoints,
  security_group: BrickWall,
  cloudfront: Globe,
  route53: Milestone,
  alb: Scale,
  nlb: Split,
  target_group: Target,
  apigatewayv2_api: Webhook,
  apigatewayv2_integration: Cable,
  cloudfront_vpc_origin: CloudCog,
  apigatewayv2_route: Route,
  alb_listener_rule: ListFilter,
  // Security
  iam_role: KeyRound,
  iam_user: Users,
  waf: Shield,
  cloudtrail: FileSearch,
  s3_public_access: ShieldAlert,
  // Monitoring
  cloudwatch_alarm: Bell,
};

// Icon per group (header) and per injected feature leaf.
const GROUP_ICON: Record<string, LucideIcon> = { compute: Cpu, storage: Database, network: Network, security: Lock, monitoring: Gauge };
const FEATURE_ICON: Record<string, LucideIcon> = {
  eks: Box,
  'eks-nodes': Server, 'eks-pods': Boxes, 'eks-deployments': Layers,
  'eks-services': Network, 'eks-explorer': Terminal, 'eks-cost': DollarSign,
  'network-flow': Activity, 'dns-query': FileSearch, 'ip-addresses': Locate, 'vpc-endpoints': Cable,
  'direct-connect': Router, 'network-firewall': Flame, 'network-paths': Waypoints,
  'sg-rules': ListFilter, 'sg-usage': Activity,
};

const STORAGE_KEY = 'awsops:nav:expanded';
const gId = (slug: string) => `g:${slug}`;
const sId = (key: string) => `s:${key}`;

// Seed expand state from the active path (pure, identical on server + client → no
// hydration mismatch). localStorage is merged in only after mount.
function seedFromPath(path: string): Set<string> {
  const active = groupForPath(path);
  const s = new Set<string>();
  if (active) {
    s.add(gId(active.slug));
    if (active.subgroupKey) s.add(sId(active.subgroupKey));
  }
  return s;
}

function NavItem({ href, label, icon: Icon, active, className, onNavigate }: { href: string; label: string; icon: LucideIcon; active: boolean; className?: string; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium no-underline transition-colors duration-[120ms]',
        active
          ? 'bg-chrome-active text-chrome-active-fg shadow-sm'
          : 'text-chrome-fg-muted hover:bg-chrome-active/40 hover:text-chrome-fg',
        className,
      )}
    >
      <Icon size={16} strokeWidth={1.7} className={cn('shrink-0', active ? 'text-chrome-active-fg' : 'text-chrome-fg-muted')} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

// `onNavigate` lets a host (e.g. the mobile drawer) close itself when a *navigation*
// link is tapped; chevron toggles never call it (the drawer stays open while you
// expand). `className` lets a host add layout classes. `persist` marks the single
// owner instance allowed to write the shared localStorage key — AppShell mounts the
// desktop Sidebar (owner) AND the drawer's Sidebar simultaneously, so only one must
// write or the hidden instance clobbers the other's stored state. No props = owner.
export default function Sidebar({ onNavigate, className, persist = true }: { onNavigate?: () => void; className?: string; persist?: boolean } = {}) {
  const path = usePathname() || '/'; // defensive: usePathname is string in app-router, but guard null/empty
  const tree = navTree();
  // Instance-scoped id prefix — AppShell mounts the desktop Sidebar AND the mobile
  // drawer's Sidebar simultaneously, so panel ids must be unique per instance or the
  // active group's id would duplicate in the DOM (invalid HTML + ambiguous aria-controls).
  const uid = useId();
  const { t } = useI18n();

  const [expanded, setExpanded] = useState<Set<string>>(() => seedFromPath(path));
  const [hydrated, setHydrated] = useState(false);

  // Hydrate persisted expand state after mount (union with the active seed). Every
  // instance reads so both sidebars reflect remembered state; only the owner writes.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids)) setExpanded((prev) => new Set([...prev, ...ids.filter((x) => typeof x === 'string')]));
      }
    } catch { /* corrupt/unavailable → keep the seed */ }
    setHydrated(true);
  }, []);

  // Persist on change — owner only, and only after hydration (so we never write the
  // un-merged seed back over stored state, even on a rapid pre-hydrate toggle).
  useEffect(() => {
    if (!persist || !hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...expanded])); } catch { /* ignore */ }
  }, [expanded, persist, hydrated]);

  // Navigating into a group (or its subgroup) re-seeds it open — manual collapse
  // persists until the next navigation into that group.
  useEffect(() => {
    const active = groupForPath(path);
    if (!active) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(gId(active.slug));
      if (active.subgroupKey) next.add(sId(active.subgroupKey));
      return next;
    });
  }, [path]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const leafActive = (leaf: NavLeaf) =>
    leaf.kind === 'feature' ? path === leaf.href || path.startsWith(`${leaf.href}/`) : path === leaf.href;
  const leafIcon = (leaf: NavLeaf): LucideIcon =>
    leaf.kind === 'feature' ? FEATURE_ICON[leaf.key] ?? Server : TYPE_ICON[leaf.type!] ?? Server;
  const leafLabel = (leaf: NavLeaf) => (leaf.labelKey ? t(leaf.labelKey) : leaf.label ?? leaf.type ?? '');

  const renderLeaf = (leaf: NavLeaf, className?: string) => (
    <NavItem
      key={leaf.key}
      href={leaf.href}
      label={leafLabel(leaf)}
      icon={leafIcon(leaf)}
      active={leafActive(leaf)}
      onNavigate={onNavigate}
      className={className}
    />
  );

  function renderGroup(g: NavGroupNode) {
    const label = t(g.labelKey);

    // Singleton (e.g. Monitoring): flat — eyebrow label + its item(s), no chevron/overview.
    if (g.singleton) {
      return (
        <div key={g.slug} className="space-y-0.5">
          <SectionLabel className="px-2.5 pb-1 text-[11px] tracking-[0.04em] text-chrome-fg-muted">{label}</SectionLabel>
          {g.items.map((leaf) => renderLeaf(leaf))}
        </div>
      );
    }

    const open = expanded.has(gId(g.slug));
    const panelId = `${uid}-panel-${g.slug}`;
    const GIcon = GROUP_ICON[g.slug] ?? Server;
    const headerActive = path === g.href;

    return (
      <div key={g.slug} className="space-y-0.5">
        {/* Header row: label = Link (navigate to overview); chevron = toggle only. */}
        <div className="flex items-center gap-0.5">
          <Link
            href={g.href!}
            onClick={() => { setExpanded((p) => { const n = new Set(p); n.add(gId(g.slug)); return n; }); onNavigate?.(); }}
            aria-current={headerActive ? 'page' : undefined}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium no-underline transition-colors duration-[120ms]',
              headerActive ? 'bg-chrome-active text-chrome-active-fg shadow-sm' : 'text-chrome-fg-muted hover:bg-chrome-active/40 hover:text-chrome-fg',
            )}
          >
            <GIcon size={16} strokeWidth={1.7} className={cn('shrink-0', headerActive ? 'text-chrome-active-fg' : 'text-chrome-fg-muted')} />
            <span className="truncate">{label}</span>
          </Link>
          <button
            type="button"
            onClick={() => toggle(gId(g.slug))}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`${open ? t('sidebar.collapse') : t('sidebar.expand')} ${label}`}
            className="shrink-0 rounded-md p-1.5 text-chrome-fg-muted transition-colors hover:bg-chrome-active/40 hover:text-chrome-fg"
          >
            <ChevronRight size={15} strokeWidth={2} className={cn('transition-transform duration-150', open && 'rotate-90')} />
          </button>
        </div>

        {/* Panel — unmounted when collapsed so its links leave the tab order. */}
        {open && (
          <div id={panelId} className="space-y-0.5 pl-2">
            {g.items.map((leaf) => renderLeaf(leaf))}
            {g.subgroups.map((sg) => {
              const subOpen = expanded.has(sId(sg.key));
              const subPanelId = `${uid}-sub-${sg.key}`;
              const subLabel = t(sg.labelKey);
              return (
                <div key={sg.key} className="space-y-0.5">
                  <button
                    type="button"
                    onClick={() => toggle(sId(sg.key))}
                    aria-expanded={subOpen}
                    aria-controls={subOpen ? subPanelId : undefined}
                    className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-[6px] text-[11px] font-semibold uppercase tracking-[0.04em] text-chrome-fg-muted transition-colors hover:bg-chrome-active/40 hover:text-chrome-fg"
                  >
                    <ChevronRight size={13} strokeWidth={2.2} className={cn('shrink-0 transition-transform duration-150', subOpen && 'rotate-90')} />
                    <span className="truncate">{subLabel}</span>
                  </button>
                  {subOpen && (
                    <div id={subPanelId} className="space-y-0.5 pl-2">
                      {sg.items.map((leaf) => renderLeaf(leaf))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      className={cn(
        'flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-chrome-border bg-chrome-muted px-4 pb-4 pt-[22px] backdrop-blur',
        className,
      )}
    >
      {/* Lockup */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <AwsopsMark size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-chrome-fg">AWSops</div>
          <div className="text-[10px] text-chrome-fg-muted">{t('sidebar.tagline')}</div>
        </div>
        <LanguageToggle />
      </div>

      {/* Active account/region scope selector + admin link */}
      <div className="mb-4 space-y-1">
        <ScopeSelector />
        <Link href="/accounts" className="block px-0.5 text-[10px] text-chrome-fg-muted hover:text-chrome-fg">{t('sidebar.manageAccounts')}</Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-4">
        <div className="space-y-0.5">
          {FIXED.map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              label={t(item.tkey)}
              icon={item.icon}
              active={path === item.href}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        {tree.map(renderGroup)}
      </nav>

      {/* Footer */}
      <div className="mt-4 border-t border-chrome-border pt-3">
        <UserIdentity />
        <div className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] text-chrome-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>{t('sidebar.statusLine', { status: t('sidebar.online') })}</span>
        </div>
        <ChangelogVersion />
        <ThemeToggle />
      </div>
    </aside>
  );
}
