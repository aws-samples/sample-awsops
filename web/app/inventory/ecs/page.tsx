import EcsOverview from '@/components/inventory/EcsOverview';

export const dynamic = 'force-dynamic';

// ECS unified overview (gap L216): a STATIC segment, so it wins over the /inventory/[type]
// dynamic catch-all ('ecs' is not an inventory type — the generic API route is untouched).
export default function EcsOverviewPage() {
  return <EcsOverview />;
}
