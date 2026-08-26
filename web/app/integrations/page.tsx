import { cookies } from 'next/headers';
import PageHeader from '@/components/ui/PageHeader';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import IntegrationsTabs from './IntegrationsTabs';

// Integrations hub — one home for the three distinct categories: Datasources (observability query
// backends), Connectors (external services like Notion), and Agents & Skills. canManage (admin) is
// resolved server-side and gates the mutating UI; reads + Explore are available to all authenticated users.
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage({ searchParams }: { searchParams?: { tab?: string } }) {
  let canManage = false;
  try {
    const user = await verifyUser(cookies().toString());
    canManage = user ? await isAdmin(user) : false;
  } catch { canManage = false; }

  return (
    <div>
      <PageHeader title="연동 · Integrations" subtitle="데이터소스 · 커넥터 · 에이전트와 스킬을 한 곳에서 관리합니다." />
      <IntegrationsTabs initialTab={searchParams?.tab} canManage={canManage} />
    </div>
  );
}
