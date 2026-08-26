import { notFound } from 'next/navigation';
import { groupBySlug } from '@/lib/inventory-types';
import GroupOverviewClient from './GroupOverviewClient';

export const dynamic = 'force-dynamic';

// Group overview = a per-category status summary (reuses /api/inventory/summary).
// Server wrapper validates the slug against the overview-eligible (non-singleton)
// groups and 404s otherwise, so /inventory/g/<bad> and /inventory/g/monitoring
// (singleton) hit the real Next.js not-found boundary instead of a half-empty page.
export default function GroupOverviewPage({ params }: { params: { group: string } }) {
  const node = groupBySlug(params.group);
  if (!node) notFound();
  return <GroupOverviewClient slug={node.slug} />;
}
