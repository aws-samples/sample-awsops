'use client';
import DiagnosisView from '@/components/diagnosis/DiagnosisView';
import PageHeader from '@/components/ui/PageHeader';
import { useI18n } from '@/components/shell/LanguageProvider';

// Client component so the header strings go through tt() (gap L52 — they were registered in
// TERMS but never applied while this was a server component).
export default function AiDiagnosisPage() {
  const { tt } = useI18n();
  return (
    <div>
      <PageHeader title={tt('AI 진단')} subtitle={tt('AWS 네이티브 데이터 기반 종합 운영 진단 리포트.')} />
      <div className="px-8 py-6">
        <DiagnosisView />
      </div>
    </div>
  );
}
