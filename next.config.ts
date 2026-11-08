import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // lets several throwaway dev servers (ios/scripts/demo-server.sh) run side by side without sharing one build folder
  distDir: process.env.RR_NEXT_DIST_DIR || ".next",
  // PGlite loads its wasm and extension bundles relative to its own files, so it runs from node_modules unbundled
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "@electric-sql/pglite-postgis"],
  // lets other devices on the same network load the dev server, e.g. RR_DEV_ORIGINS=10.32.18.243
  allowedDevOrigins: process.env.RR_DEV_ORIGINS ? process.env.RR_DEV_ORIGINS.split(",") : [],
  // response links are bearer tokens: keep request paths out of the dev log (docs/IMPLEMENTATION.md logging rules)
  logging: { incomingRequests: false },
  async headers() {
    // every page and route: no framing (clickjacking on approve/send), no mime sniffing, no full-url referrers.
    // the microphone stays allowed for this origin because Care records voice notes; camera and location are off.
    // no script-src here: the app router's inline bootstrap scripts would need nonces first.
    const global = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
      { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
    ];
    const strict = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Robots-Tag", value: "noindex" },
    ];
    // the global entry comes first: for a duplicate key next uses the later match, so the strict routes keep no-referrer
    return [
      { source: "/(.*)", headers: global },
      { source: "/r/:path*", headers: strict },
      { source: "/api/responses/:path*", headers: strict },
      { source: "/outbox", headers: strict },
    ];
  },
};
export default config;
