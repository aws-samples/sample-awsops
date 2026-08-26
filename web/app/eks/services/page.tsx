import FleetKindPage from '@/components/eks/FleetKindPage';

// Fleet-wide EKS Services (v1 /k8s/services parity) — all rendering in FleetKindPage.
export default function EksFleetServicesPage() {
  return <FleetKindPage kind="services" />;
}
