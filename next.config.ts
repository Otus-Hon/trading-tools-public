import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    // Force Turbopack to treat this folder as the project root to resolve node_modules correctly.
    root: __dirname,
  },
};

export default nextConfig;
