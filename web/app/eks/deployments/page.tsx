import FleetKindPage from '@/components/eks/FleetKindPage';

// Fleet-wide EKS Deployments (v1 /k8s/deployments parity) — all rendering in FleetKindPage.
export default function EksFleetDeploymentsPage() {
  return <FleetKindPage kind="deployments" />;
}
