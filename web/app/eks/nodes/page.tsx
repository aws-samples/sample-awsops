import FleetKindPage from '@/components/eks/FleetKindPage';

// Fleet-wide EKS Nodes (v1 /k8s/nodes parity) — all rendering in FleetKindPage.
export default function EksFleetNodesPage() {
  return <FleetKindPage kind="nodes" />;
}
