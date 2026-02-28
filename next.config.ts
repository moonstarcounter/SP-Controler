import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack 配置 - 解決 Next.js 16 建置錯誤
  turbopack: {},

  // 啟用實驗性功能以支持 WebSocket
  experimental: {
    // 在 Next.js 15+ 中需要這個配置來支持自定義伺服器功能
  },

  // 配置 Webpack 以正確處理 ws 模組
  webpack: (config, { isServer }) => {
    if (isServer) {
      // 排除 ws 和其他原生模組，因為它們只在伺服器端使用
      config.externals.push({
        'bufferutil': 'bufferutil',
        'utf-8-validate': 'utf-8-validate',
      });
    }
    return config;
  },

  // 禁用嚴格模式以避免某些 WebSocket 相關問題
  reactStrictMode: false,
};

export default nextConfig;