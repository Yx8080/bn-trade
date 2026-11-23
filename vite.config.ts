import { Agent } from 'node:https'
import type { IncomingMessage } from 'node:http'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

function stripCredentials(request: IncomingMessage) {
  delete request.headers.cookie
  delete request.headers.authorization
  delete request.headers['x-api-key']
}

const portfolioPath = '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio'
const binanceProxy = {
  target: 'https://www.binance.com',
  changeOrigin: true,
  agent: new Agent({ proxyEnv: process.env }),
  headers: { clienttype: 'web' },
  proxyTimeout: 15000,
  bypass: stripCredentials,
}

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '^/api/binance/latest-records$': {
        ...binanceProxy,
        rewrite: () => `${portfolioPath}/order-history`,
      },
      '^/api/binance/portfolio-detail(?:\\?.*)?$': {
        ...binanceProxy,
        rewrite: path => path.replace('/api/binance/portfolio-detail', `${portfolioPath}/detail`),
      },
    },
  },
})
