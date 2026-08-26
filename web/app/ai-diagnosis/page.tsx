import DiagnosisView from '@/components/diagnosis/DiagnosisView';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default function AiDiagnosisPage() {
  return (
    <div>
      <PageHeader title="AI 진단" subtitle="AWS 네이티브 데이터 기반 종합 운영 진단 리포트." />
      <div className="px-8 py-6">
        <DiagnosisView />
      </div>
    </div>
  );
}
