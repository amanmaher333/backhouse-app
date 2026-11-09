/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Tags browser error reports with the deployed commit (Railway sets this at build time).
  env: { NEXT_PUBLIC_RELEASE: process.env.RAILWAY_GIT_COMMIT_SHA ?? '' },
};
export default nextConfig;
