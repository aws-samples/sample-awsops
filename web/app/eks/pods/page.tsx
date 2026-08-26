import FleetKindPage from '@/components/eks/FleetKindPage';

// Fleet-wide EKS Pods (v1 /k8s/pods parity) — all rendering in FleetKindPage.
export default function EksFleetPodsPage() {
  return <FleetKindPage kind="pods" />;
}
