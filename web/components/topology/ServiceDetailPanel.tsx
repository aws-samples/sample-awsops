'use client';

// Right-hand detail panel for one Service of the K8s service graph. Pods and Nodes appear ONLY
// here (they are never graph nodes); Secret references are names only — values are never read.
import { X } from 'lucide-react';
import type { GNode, ServiceDetail } from '@/lib/k8s-service-graph';
import { useI18n } from '@/components/shell/LanguageProvider';

const POD_STATUS_TONE = (status: string) =>
  status === 'Running' || status === 'Succeeded' ? 'text-positive-text'
    : status === 'Pending' ? 'text-warning-text' : 'text-negative-text';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-ink-100 px-4 py-3">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
      {children}
    </section>
  );
}

function NodeList({ label, nodes, empty }: { label: string; nodes: GNode[]; empty: string }) {
  if (!nodes.length) return <p className="text-xs text-ink-400">{empty}</p>;
  return (
    <ul aria-label={label} className="space-y-1">
      {nodes.map((n) => (
        <li key={n.id} className="truncate text-xs" title={n.id}>
          <span className="font-medium">{n.label}</span>
          {n.namespace && <span className="ml-1 text-ink-400">{n.namespace}</span>}
          {n.sub && <span className="ml-1 text-ink-400">· {n.sub}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function ServiceDetailPanel({ detail, service, onClose }: { detail: ServiceDetail; service: GNode; onClose(): void }) {
  const { tt } = useI18n();
  const none = tt('없음');
  return (
    <aside
      aria-label={tt('서비스 상세')}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="flex h-full w-full flex-col overflow-y-auto bg-card text-ink-800"
    >
      <header className="flex items-start gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-ink-500">{tt('서비스')} · {service.namespace}</p>
          <h2 className="truncate text-sm font-semibold" title={service.label}>{service.label}</h2>
          {service.sub && <p className="truncate text-xs text-ink-500" title={service.sub}>{service.sub}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label={tt('닫기')}
          className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-800">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {detail.secretRefs.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-3">
          {detail.secretRefs.map((s) => (
            <span key={s} className="rounded border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[10px] text-warning-text">
              {`${tt('Secret 참조')}: ${s}`}
            </span>
          ))}
        </div>
      )}

      <Section title={`${tt('Pod 목록')} (${detail.pods.length})`}>
        {detail.pods.length ? (
          <table aria-label={tt('Pod 목록')} className="w-full table-fixed text-xs">
            <thead className="text-left text-[10px] text-ink-500">
              <tr><th className="w-[40%] font-medium">{tt('이름')}</th><th className="font-medium">{tt('상태')}</th>
                <th className="w-12 font-medium">{tt('재시작')}</th><th className="font-medium">{tt('노드')}</th></tr>
            </thead>
            <tbody>
              {detail.pods.map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className="border-t border-ink-50">
                  <td className="truncate py-1 pr-1" title={p.name}>{p.name}</td>
                  <td className={`truncate py-1 pr-1 ${POD_STATUS_TONE(p.status)}`} title={p.status}>{p.status}</td>
                  <td className="py-1 pr-1 tabular-nums">{p.restarts}</td>
                  <td className="truncate py-1" title={p.node}>{p.node || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-400">{none}</p>}
      </Section>

      <Section title={`${tt('노드')} (${detail.nodes.length})`}>
        {detail.nodes.length ? (
          <table aria-label={tt('노드')} className="w-full table-fixed text-xs">
            <thead className="text-left text-[10px] text-ink-500">
              <tr><th className="w-[40%] font-medium">{tt('이름')}</th><th className="font-medium">{tt('상태')}</th>
                <th className="font-medium">{tt('인스턴스 유형')}</th></tr>
            </thead>
            <tbody>
              {detail.nodes.map((n) => (
                <tr key={n.name} className="border-t border-ink-50">
                  <td className="truncate py-1 pr-1" title={n.name}>{n.name}</td>
                  <td className="truncate py-1 pr-1" title={n.readyText}>{n.readyText}</td>
                  <td className="truncate py-1" title={`${n.instanceType} · ${n.zone}`}>{n.instanceType || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-400">{none}</p>}
      </Section>

      <Section title={tt('호출 주체')}><NodeList label={tt('호출 주체')} nodes={detail.callers} empty={none} /></Section>
      <Section title={tt('호출 대상')}><NodeList label={tt('호출 대상')} nodes={detail.callees} empty={none} /></Section>
      <Section title={tt('데이터 저장소')}><NodeList label={tt('데이터 저장소')} nodes={detail.datastores} empty={none} /></Section>
    </aside>
  );
}
