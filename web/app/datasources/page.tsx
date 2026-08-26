import { redirect } from 'next/navigation';

// Folded into the Integrations hub (Task 29). The global Explore is now reached from a Datasources-tab
// row → per-instance Explore. Preserve an existing ?instance= deep link by mapping it to the instance route.
export const dynamic = 'force-dynamic';

export default function DatasourcesRedirect({ searchParams }: { searchParams?: { instance?: string } }) {
  const instance = searchParams?.instance;
  redirect(instance ? `/integrations/datasources/${encodeURIComponent(instance)}` : '/integrations?tab=datasources');
}
