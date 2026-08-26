'use client';
import { useState } from 'react';
import DatasourcesTab from './datasources/DatasourcesTab';
import ConnectorsTab from './connectors/ConnectorsTab';
import AgentsSkillsTab from './agents-skills/AgentsSkillsTab';

// The Integrations hub tab bar. Three distinct categories: Datasources (observability query backends),
// Connectors (external services like Notion), Agents & Skills. `tab` query-param selects the initial tab.
const TABS = [
  { key: 'datasources', label: 'Datasources' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'agents-skills', label: 'Agents & Skills' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function normalize(t?: string): TabKey {
  return TABS.some((x) => x.key === t) ? (t as TabKey) : 'datasources';
}

export default function IntegrationsTabs({ initialTab, canManage = false }: { initialTab?: string; canManage?: boolean }) {
  const [active, setActive] = useState<TabKey>(normalize(initialTab));

  const select = (k: TabKey) => {
    setActive(k);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', k);
      window.history.replaceState(null, '', url.toString());
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-ink-100">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            onClick={() => select(t.key)}
            className={`px-4 py-2 text-[13px] rounded-t-md border-b-2 -mb-px ${
              active === t.key ? 'border-brand-500 text-brand-600 font-semibold' : 'border-transparent text-ink-500 hover:text-ink-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>
        {active === 'datasources' && <DatasourcesTab canManage={canManage} />}
        {active === 'connectors' && <ConnectorsTab canManage={canManage} />}
        {active === 'agents-skills' && <AgentsSkillsTab />}
      </div>
    </div>
  );
}
