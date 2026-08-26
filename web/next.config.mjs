/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Enables instrumentation.ts's register() hook (graph-rebuild interval; default OFF via
  // GRAPH_REBUILD_INTERVAL_MINS). Not on by default in this Next version (14.2).
  experimental: { instrumentationHook: true },
  async redirects() {
    return [
      { source: '/ec2', destination: '/inventory/ec2', permanent: false },
      // OpenCost moved per-cluster onto the EKS detail page; keep old bookmarks working.
      { source: '/opencost', destination: '/eks', permanent: false },
    ];
  },
};
export default nextConfig;
