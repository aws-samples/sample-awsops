/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async redirects() {
    return [
      { source: '/ec2', destination: '/inventory/ec2', permanent: false },
      // OpenCost moved per-cluster onto the EKS detail page; keep old bookmarks working.
      { source: '/opencost', destination: '/eks', permanent: false },
    ];
  },
};
export default nextConfig;
