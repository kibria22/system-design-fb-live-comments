import type { NextConfig } from "next";

/**
 * When the app is reached via Gateway API, the browser calls same-origin /v1/*
 * and Envoy routes those directly to backend services — no rewrite needed.
 *
 * Set API_GATEWAY_URL only for local `npm run dev` (or direct frontend access)
 * so Next.js can proxy /v1/* to a gateway/backend.
 */
const apiGatewayUrl = process.env.API_GATEWAY_URL?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    if (!apiGatewayUrl) {
      return [];
    }

    return [
      {
        source: "/v1/:path*",
        destination: `${apiGatewayUrl}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
