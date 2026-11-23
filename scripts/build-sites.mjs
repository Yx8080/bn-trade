import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

const dist = new URL('../dist/', import.meta.url)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
const assets = Object.fromEntries(await Promise.all([
  'index.html',
  ...(await readdir(new URL('assets/', dist))).sort().map(name => 'assets/' + name),
].map(async file => {
  const contentType = types[extname(file)]
  if (!contentType) throw new Error('Unsupported Sites asset: ' + file)
  const body = await readFile(new URL(file, dist), 'utf8')
  return ['/' + file, { contentType, body }]
})))
const worker = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8')

await Promise.all([
  mkdir(new URL('server/', dist), { recursive: true }),
  mkdir(new URL('.openai/', dist), { recursive: true }),
])
await Promise.all([
  writeFile(new URL('server/index.js', dist), 'const siteAssets = ' + JSON.stringify(assets) + '\n\n' + worker),
  copyFile(new URL('../.openai/hosting.json', import.meta.url), new URL('.openai/hosting.json', dist)),
])
