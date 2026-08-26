// THE allow-list swap-point for OpenCost. Delegates to eks-registry's isAllowed —
// env clusters (ONBOARDED_EKS_CLUSTERS) + runtime registrations + Aurora-stored auth
// (sa-token/assume-role) all count, matching what the fleet/allocation routes read.
// (Originally env-only; the planned 1-line swap landed with the eks-registry buildout.)
import { isAllowed } from '@/lib/eks-registry';

export async function isClusterOnboarded(cluster: string): Promise<boolean> {
  return isAllowed(cluster);
}
