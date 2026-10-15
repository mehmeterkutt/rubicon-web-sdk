// A static export served by the test server under /frameworks/next/ (step 8.1).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/frameworks/next',
  devIndicators: false,
};

export default nextConfig;
