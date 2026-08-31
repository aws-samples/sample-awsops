'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';
import DatasourceForm, { type DatasourceFormValue } from './DatasourceForm';
import { useI18n } from '@/components/shell/LanguageProvider';

interface Instance {
  id: number; name: string; kind: string; endpoint?: string | null; authType?: string | null; isDefault?: boolean; connected?: boolean;
}

// The Datasources tab: manage instances (multi-per-type, named) + drill into Explore. Read-visible to
// all authenticated users; mutating actions are admin-only (canManage).
export default function DatasourcesTab({ canManage = false }: { canManage?: boolean }) {
  const { tt } = useI18n();
  const [list, setList] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<null | { mode: 'add' } | { mode: 'edit'; value: DatasourceFormValue }>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/datasources');
      setList(r.ok ? ((await r.json()).datasources ?? []) : []);
    } catch { setList([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onDelete = async (i: Instance) => {
    if (typeof window !== 'undefined' && !window.confirm(tt(`"${i.name}" 데이터소스를 삭제할까요?`))) return;
    setBusyId(i.id);
    try { await fetch(`/api/datasources/${i.id}`, { method: 'DELETE' }); await load(); }
    finally { setBusyId(null); }
  };
  const onSetDefault = async (i: Instance) => {
    setBusyId(i.id);
    try { await fetch(`/api/datasources/${i.id}/default`, { method: 'POST' }); await load(); }
    finally { setBusyId(null); }
  };

  if (form && canManage) {
    return (
      <Card className="p-4 max-w-xl">
        <DatasourceForm
          initial={form.mode === 'edit' ? form.value : undefined}
          onSaved={() => { setForm(null); load(); }}
          onCancel={() => setForm(null)}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-500">{tt('관측성 데이터소스 (Prometheus·Mimir·Loki·Tempo·ClickHouse). 같은 타입 여러 개 등록 가능.')}</p>
        {canManage && <Button onClick={() => setForm({ mode: 'add' })}>＋ Add datasource</Button>}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400 border-b border-ink-100">
              <th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th>{canManage && <th className="px-3 py-2">URL</th>}<th className="px-3 py-2">Auth</th>
              <th className="px-3 py-2">Status</th><th className="px-3 py-2">Default</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-400">{tt('불러오는 중…')}</td></tr>}
            {!loading && list.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-400">{tt('등록된 데이터소스가 없습니다.')}</td></tr>
            )}
            {list.map((i) => (
              <tr key={i.id} className="border-b border-ink-50">
                <td className="px-3 py-2 font-medium text-ink-800">
                  <span className="inline-flex items-center gap-2"><IntegrationIcon kind={i.kind} /> {i.name}</span>
                </td>
                <td className="px-3 py-2 text-ink-600">{i.kind}</td>
                {canManage && (
                  <td className="px-3 py-2">
                    <span className="block max-w-[260px] truncate font-mono text-[11px] text-ink-500" title={i.endpoint ?? ''}>{i.endpoint ?? '—'}</span>
                  </td>
                )}
                <td className="px-3 py-2 text-ink-500">{i.authType ?? 'none'}</td>
                <td className="px-3 py-2">
                  <span className={i.connected ? 'text-emerald-600' : 'text-amber-600'}>{i.connected ? '● connected' : '○ unconfigured'}</span>
                </td>
                <td className="px-3 py-2">{i.isDefault ? <span className="text-amber-600">★ default</span> : (canManage && <button className="text-[12px] text-brand-600 hover:underline" onClick={() => onSetDefault(i)} disabled={busyId === i.id}>set default</button>)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <Link href={`/integrations/datasources/${i.id}`} className="text-[12px] text-brand-600 hover:underline mr-3">Explore →</Link>
                  {canManage && <button className="text-[12px] text-ink-600 hover:underline mr-3" onClick={() => setForm({ mode: 'edit', value: { id: i.id, name: i.name, kind: i.kind, endpoint: i.endpoint ?? '', authType: i.authType ?? 'none' } })}>Edit</button>}
                  {canManage && <button className="text-[12px] text-rose-600 hover:underline" onClick={() => onDelete(i)} disabled={busyId === i.id}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
