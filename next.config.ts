import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
    middlewareClientMaxBodySize: "500mb",
    // Next 15.5+ — route handler büyük FormData (proxy katmanı)
    proxyClientMaxBodySize: "500mb",
  },
};

export default nextConfig;
