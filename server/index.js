import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiMiddleware } from './api.js'

const types = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
}

async function loadFrontend() {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  const assets = join(dist, 'assets')
  const html = { type: 'text/html; charset=utf-8', data: await readFile(join(dist, 'index.html')), cache: 'no-cache' }
  const files = new Map([['/', html], ['/index.html', html]])
  for (const entry of await readdir(assets, { withFileTypes: true, recursive: true })) {
    const type = types[extname(entry.name)]
    if (!entry.isFile() || !type) continue
    const path = join(entry.parentPath, entry.name)
    const parts = relative(dist, path).split(sep)
    if (parts.some(part => part.startsWith('.'))) continue
    const key = '/' + parts.map(encodeURIComponent).join('/')
    files.set(key, { type, data: await readFile(path), cache: 'public, max-age=31536000, immutable' })
  }
  return files
}

async function start() {
  const files = await loadFrontend()
  const api = createApiMiddleware({
    env: process.env,
    databaseFile: fileURLToPath(new URL('../.trade-data/orders.sqlite', import.meta.url)),
  })
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 需为 0 至 65535 的整数。')
  const server = createServer((req, res) => {
    void api(req, res, () => {
      const path = req.url?.split('?', 1)[0]
      const file = files.get(path)
      if (!file) return res.writeHead(404).end()
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.data.length,
        'Cache-Control': file.cache, 'X-Content-Type-Options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : file.data)
    })
  })
  server.on('close', api.close)
  server.on('error', error => {
    console.error('交易工作台启动失败。', error.message)
    process.exitCode = 1
  })
  process.once('SIGINT', () => server.close())
  process.once('SIGTERM', () => server.close())
  server.listen(port, host, () => {
    const address = server.address()
    const hostname = address.family === 'IPv6' ? '[' + address.address + ']' : address.address
    console.log(`交易工作台已启动 http://${hostname}:${address.port}`)
  })
}

start().catch(error => {
  console.error(error.code === 'ENOENT' ? '找不到前端构建文件，请先运行 npm run build。' : error.message)
  process.exitCode = 1
})
