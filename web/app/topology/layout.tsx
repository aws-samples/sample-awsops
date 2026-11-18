import { TopologyCapability } from '@/components/topology/TopologyCapability';
import type { ReactNode } from 'react';
export const dynamic = 'force-dynamic';
export default function TopologyLayout({ children }: { children: ReactNode }) {
  return <TopologyCapability value={process.env.TOPOLOGY_ENTITIES_ENABLED === 'true'}>{children}</TopologyCapability>;
}
