import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let the route observe >10MiB before rejecting, including chunked uploads.
  experimental: { proxyClientMaxBodySize: "12mb" },
  turbopack: { root: process.cwd() },
};

export default nextConfig;
