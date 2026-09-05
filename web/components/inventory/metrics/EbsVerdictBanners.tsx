'use client';
import { useI18n } from '@/components/shell/LanguageProvider';

// EBS detail call-outs (gap L210, v1 parity): an encryption verdict banner (green with the
// KMS key, or red with the encrypted-copy recommendation) and an idle-volume cost hint for
// detached volumes. Pure render from the row — no fetch. Tri-state honesty: an ABSENT
// encrypted field or state renders nothing (the EBS-snapshot precedent — unknown must never
// read as a definitive verdict).

const isTrue = (v: unknown) => v === true || v === 'true';
const isFalse = (v: unknown) => v === false || v === 'false';

export function EbsVerdictBanners({ data }: { data: Record<string, unknown> }) {
  const { tt } = useI18n();
  const enc = data.encrypted;
  const kms = typeof data.kms_key_id === 'string' && data.kms_key_id ? data.kms_key_id : null;
  // 'available' in the SYNCED SNAPSHOT — a stale snapshot can't prove it is still detached,
  // so the banner says so (the FinOps rule wraps the same signal in staleness guards).
  const idle = data.state === 'available';
  const banners = [] as JSX.Element[];
  if (isTrue(enc)) {
    banners.push(
      <div key="enc" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
        <span className="font-semibold">{tt('암호화됨')}</span>
        {kms && <span className="ml-2 break-all font-mono text-[11px] text-emerald-700">{kms}</span>}
      </div>,
    );
  } else if (isFalse(enc)) {
    banners.push(
      <div key="enc" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
        <span className="font-semibold">{tt('미암호화')}</span>
        <span className="ml-2">{tt('스냅샷으로 암호화 사본 생성을 검토하세요.')}</span>
      </div>,
    );
  }
  if (idle) {
    banners.push(
      <div key="idle" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
        <span className="font-semibold">{tt('유휴 볼륨 (스냅샷 기준)')}</span>
        <span className="ml-2">{tt('마지막 sync 시점에 미연결 — 여전히 과금되므로 삭제로 비용 절감을 검토하세요.')}</span>
      </div>,
    );
  }
  if (!banners.length) return null;
  return <div className="flex flex-col gap-2">{banners}</div>;
}
