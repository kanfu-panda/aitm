import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * pdf.js 运行时按需拉取的资源（CMap、标准字体、图像解码器），以同源静态资源提供在 /pdfjs/ 下：
 * 开发时由中间件直接读 node_modules，构建时原样输出到 dist/pdfjs/。
 * 不带 quickjs-eval：那是 PDF 内嵌脚本的沙箱，我们不执行 PDF 脚本。
 */
function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm"];
  const wanted = (dir: string, name: string) => dirs.includes(dir) && !name.startsWith("quickjs");
  const mime = (name: string) =>
    name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream";
  return {
    name: "aitm-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const [dir, name, ...rest] = decodeURIComponent((req.url ?? "").split("?")[0])
          .replace(/^\/+/, "")
          .split("/");
        if (rest.length > 0 || !name || name.includes("..") || !wanted(dir, name)) return next();
        const file = path.join(root, dir, name);
        if (!fs.existsSync(file)) return next();
        res.setHeader("Content-Type", mime(name));
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of fs.readdirSync(path.join(root, dir))) {
          if (!wanted(dir, name)) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: fs.readFileSync(path.join(root, dir, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: 5174 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
  },
});
