import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 改造后:后端已抽到独立 Node 服务(server/),dev 时把 /api 代理过去。
// 旧的 2630 行 Vite 插件后端(含实时 WebSocket/PCM 管道)已整体移除。
// 两个独立构建:index.html=管理后台,public.html=候选人公开页(bundle 隔离)。
const API_TARGET = process.env.API_TARGET || "http://127.0.0.1:8787";

// dev 下让 /p/* (候选人页) 走 public.html,而不是默认回退到 admin 的 index.html
function publicRouteDevPlugin() {
  return {
    name: "public-route-dev",
    configureServer(server: any) {
      server.middlewares.use((req: any, _res: any, next: any) => {
        const url: string = req.url || "";
        if (url.startsWith("/p/") && !url.includes(".")) req.url = "/public.html";
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), publicRouteDevPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, "index.html"),
        public: resolve(__dirname, "public.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
