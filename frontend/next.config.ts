import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Emit .next/standalone: the server, plus only the node_modules it actually
   * reaches, so the demo image does not carry a 500 MB dependency tree it will
   * never open. Required by frontend/Dockerfile; harmless for `next dev`.
   */
  output: 'standalone',
};

export default nextConfig;
