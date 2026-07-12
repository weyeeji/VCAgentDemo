import type { NextConfig } from "next";

const scriptPolicy = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["mammoth", "pdf-parse"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // frame-ancestors/XFO 用 SAMEORIGIN：允许同域 iframe 预览 PDF，同时禁止外站嵌套本站。
        { key: "Content-Security-Policy", value: `default-src 'self'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'; object-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; connect-src 'self'` },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ],
    }];
  },
};

export default nextConfig;
