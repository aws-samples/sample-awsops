/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Test fixture type noise stays outside the production application check.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  poweredByHeader: false,
  // Turbopack uses PptxGenJS's browser mappings. Webpack resolves node: URLs before
  // consulting those mappings, so ignore only the package's two Node-only imports.
  turbopack: {},
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      config.plugins.push(new webpack.IgnorePlugin({
        checkResource: (request, context) =>
          (request === 'node:fs' || request === 'node:https') && /[\\/]pptxgenjs[\\/]dist$/.test(context),
      }));
    }
    return config;
  },
  async redirects() {
    return [
      { source: '/ec2', destination: '/inventory/ec2', permanent: false },
      // OpenCost moved per-cluster onto the EKS detail page; keep old bookmarks working.
      { source: '/opencost', destination: '/eks', permanent: false },
    ];
  },
};
export default nextConfig;
