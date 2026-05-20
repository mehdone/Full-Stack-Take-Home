import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile the shared contracts package so Next.js can handle its ESM source directly
  transpilePackages: ["@highwood/contracts"],
};

export default nextConfig;
