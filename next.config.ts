import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-unrar-js wajib external: file unrar.wasm-nya harus dibaca dari
  // disk saat runtime (di-bundle Turbopack malah error "Failed to parse URL").
  serverExternalPackages: ["sharp", "tesseract.js", "node-unrar-js"],
};

export default nextConfig;
