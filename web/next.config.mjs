/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Test fixture type noise stays outside the production application check.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
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
