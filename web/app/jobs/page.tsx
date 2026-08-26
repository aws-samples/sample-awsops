'use client';
import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DataTable from '@/components/ui/DataTable';

export default function JobsPage() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/jobs');
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setRows(d.jobs);
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="Async Jobs"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-4">
        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {!rows && !err && <div className="text-ink-400">로딩 중…</div>}
        {rows && (
          <DataTable
            columns={[
              { key: 'type', label: 'Type' },
              { key: 'status', label: 'Status' },
              { key: 'runtime', label: 'Runtime' },
              { key: 'error', label: 'Error' },
              { key: 'created_at', label: 'Created' },
            ]}
            rows={rows}
          />
        )}
      </div>
    </div>
  );
}
