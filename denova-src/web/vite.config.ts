import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const backendPort = process.env.DENOVA_BACKEND_PORT || process.env.NOVA_BACKEND_PORT || '8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    // 与运行时保持一致：应用会在 localhost 上重定向到规范回环地址 127.0.0.1
    // （见 src/main.tsx 的 redirectLocalhostToCanonicalLoopback）。
    // jsdom 默认 URL 是 http://localhost:3000/，会命中该重定向并跳过整个启动流程，
    // 使 main.test.tsx 必然失败。这里用规范地址，避免测试环境制造假红灯。
    environmentOptions: {
      jsdom: { url: 'http://127.0.0.1:3000/' },
    },
    setupFiles: './src/test/setup.ts',
    globals: true,
    css: true,
    // 默认 5s 对大型组件树偏紧：本机冷启动时单纯 import 一个页面级模块
    // 就可能花掉数秒（同时跑 200+ 测试文件时更明显），会让「断言其实没问题」
    // 的用例随机超时，制造与代码无关的红灯。这里给足预算，断言标准不变。
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep size caps on individual groups: a global cap can split tightly coupled SDKs into cyclic chunks.
          minSize: 20 * 1024,
          groups: [
            { name: 'shiki', test: /node_modules[\\/](?:shiki|@shikijs)[\\/]/, priority: 40 },
            { name: 'monaco', test: /node_modules[\\/](?:monaco-editor|@monaco-editor)[\\/]/, priority: 30 },
            { name: 'ai-sdk', test: /node_modules[\\/](?:ai|@ai-sdk)[\\/]/, priority: 20 },
            { name: 'markdown', test: /node_modules[\\/](?:react-markdown|remark-|rehype-|micromark|mdast|hast|unified)[^\\/]*[\\/]/, priority: 10 },
            { name: 'vendor', test: /node_modules[\\/]/, maxSize: 450 * 1024, priority: 1, entriesAware: true },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
})
