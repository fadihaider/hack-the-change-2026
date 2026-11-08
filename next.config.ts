import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // PGlite loads its wasm and extension bundles relative to its own files, so it runs from node_modules unbundled
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "@electric-sql/pglite-postgis"],
  // lets other devices on the same network load the dev server, e.g. RR_DEV_ORIGINS=10.32.18.243
  allowedDevOrigins: process.env.RR_DEV_ORIGINS ? process.env.RR_DEV_ORIGINS.split(",") : [],
  // response links are bearer tokens: keep request paths out of the dev log (docs/IMPLEMENTATION.md logging rules)
  logging: { incomingRequests: false },
  async headers() {
    const strict = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Robots-Tag", value: "noindex" },
    ];
    return [
      { source: "/r/:path*", headers: strict },
      { source: "/api/responses/:path*", headers: strict },
      { source: "/outbox", headers: strict },
    ];
  },
};
export default config;
