import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from 'vite'
import { createApiMiddleware } from './server/api.js'

function localApi(server: ViteDevServer | PreviewServer) {
  const { root, mode } = server.config
  const middleware = createApiMiddleware({
    env: loadEnv(mode, root, ['BINANCE_FUTURES_', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']),
    databaseFile: resolve(root, '.trade-data', 'orders.sqlite'),
  })
  server.httpServer?.once('close', () => middleware.close())
  server.middlewares.use(middleware)
}

export default defineConfig({
  plugins: [vue(), { name: 'trade-api', configureServer: localApi, configurePreviewServer: localApi }],
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.trade-data/**', '**/*.vault-key', '**/*.vault-key.*'] },
  },
})
