import type { NextConfig } from "next";

const desktopDistDir = process.env.NEXTWAVES_NEXT_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  ...(desktopDistDir ? { distDir: desktopDistDir } : {}),
  output: "standalone",
  // Keep standalone/server.js at the web root even with the desktop lockfile above it.
  outputFileTracingRoot: __dirname,
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value:
              "serial=(self), local-network=(self), loopback-network=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
