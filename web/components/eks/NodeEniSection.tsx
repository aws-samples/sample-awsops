'use client';
import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';

interface EniRow { id: string; privateIp: string; publicIp: string | null; subnet: string | null; ips: number }
interface NodeEni {
  found: boolean; instanceId?: string; instanceType?: string | null;
  maxEnis?: number | null; eniCount?: number; totalIps?: number; enis?: EniRow[];
  /** ENI당 IPv4 슬롯 한도(타입별, 미등재 타입은 15 폴백 — v1 parity). */
  ipv4PerEni?: number;
  /** 인스턴스 트래픽(1h 누적) — CloudWatch에 ENI별 메트릭은 없어 인스턴스 레벨로 표시. */
  traffic?: { netIn: number | null; netOut: number | null; pktIn: number | null; pktOut: number | null } | null;
}

const mb = (v: number | null | undefined) => (v == null ? '—' : `${(v / 1024 / 1024).toFixed(1)} MB`);
const cnt = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());

/** 노드 ENI 패널 (v1 parity): 노드의 EC2 네트워크 인터페이스 + IP 용량 — 동기화된 ec2 행에서 매칭. */
export default function NodeEniSection({ nodeName }: { nodeName: string }) {
  const [d, setD] = useState<NodeEni | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setD(null); setErr(false);
    fetch(`/api/eks/node-eni?node=${encodeURIComponent(nodeName)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (alive) setD(body); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [nodeName]);

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-700">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-600"><Network size={12} /></span>
        네트워크 인터페이스 (ENI)
      </h3>
      {!d && !err && <p className="text-[12px] text-ink-400">조회 중…</p>}
      {(err || (d && !d.found)) && <p className="text-[12px] text-ink-300">인벤토리에서 노드 인스턴스를 찾지 못했습니다</p>}
      {d?.found && (
        <>
          <p className="mb-2 text-[12px] text-ink-600">
            <span className="font-mono text-[11px] text-ink-500">{d.instanceId}</span>
            {d.instanceType && <span> · {d.instanceType}</span>}
            <span> · ENI {d.eniCount}{d.maxEnis ? ` / max ${d.maxEnis}` : ''} · IP {d.totalIps}개</span>
          </p>
          {d.traffic && (
            <div className="mb-2 grid grid-cols-4 gap-2" title="인스턴스 트래픽 (1h 누적) — CloudWatch에 ENI별 메트릭은 없어 인스턴스 레벨로 표시">
              {([['In', mb(d.traffic.netIn)], ['Out', mb(d.traffic.netOut)], ['Pkts In', cnt(d.traffic.pktIn)], ['Pkts Out', cnt(d.traffic.pktOut)]] as const).map(([l, v]) => (
                <div key={l} className="rounded-md border border-ink-100 bg-paper-muted/40 px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-[0.04em] text-ink-400">{l}</div>
                  <div className="tabular text-[12.5px] font-medium text-ink-700">{v}</div>
                </div>
              ))}
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {(d.enis ?? []).map((e) => (
              <li key={e.id} className="rounded-md border border-ink-100 bg-paper-muted/40 px-2 py-1.5 text-[12px]">
                <span className="font-mono text-[11px] text-brand-700">{e.id}</span>
                <span className="ml-2 text-ink-700">{e.privateIp}</span>
                {e.publicIp && <span className="ml-2 text-ink-500">(pub {e.publicIp})</span>}
                {e.subnet && <span className="ml-2 font-mono text-[10.5px] text-ink-400">{e.subnet}</span>}
                <span className="ml-2 text-[10.5px] text-ink-400">IP {e.ips}{d.ipv4PerEni ? `/${d.ipv4PerEni}` : ''}</span>
                {d.ipv4PerEni ? (
                  <span className="ml-2 inline-flex h-1.5 w-16 items-center overflow-hidden rounded-full bg-ink-100 align-middle" title={`IP 슬롯 사용 ${e.ips}/${d.ipv4PerEni}`}>
                    <span
                      className={`h-full rounded-full ${e.ips / d.ipv4PerEni >= 0.9 ? 'bg-rose-500' : e.ips / d.ipv4PerEni >= 0.7 ? 'bg-brand-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, (e.ips / d.ipv4PerEni) * 100)}%` }}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
