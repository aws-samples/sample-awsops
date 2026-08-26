import PageHeader from '@/components/ui/PageHeader';
import ExplorePanel from '@/components/datasources/ExplorePanel';

// Per-instance Explore: reached from a Datasources-tab row ("Explore →"). Scopes the query console to
// one instance id (the picker is hidden).
export const dynamic = 'force-dynamic';

export default function DatasourceExplorePage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  return (
    <div>
      <PageHeader title="데이터소스 탐색" subtitle="선택한 데이터소스 인스턴스를 네이티브 쿼리 언어로 조회합니다 (읽기 전용)." />
      <div className="p-6 lg:p-8">
        <ExplorePanel instanceId={Number.isInteger(id) && id > 0 ? id : undefined} />
      </div>
    </div>
  );
}
