import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { EnvHttpProxyAgent, WebSocket } from 'undici'

const run = promisify(execFile)

async function windowsProxyFor(origin) {
  // Ask Windows for this origin so its proxy bypass list and per-host rules apply.
  // Only the origin is needed, including for signed requests.
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$target = [Uri]$env:BN_TRADE_PROXY_ORIGIN',
    '$proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy($target)',
    'if ($proxy -and $proxy -ne $target) { $proxy.AbsoluteUri }',
  ].join('\n')
  try {
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { SystemRoot: process.env.SystemRoot, BN_TRADE_PROXY_ORIGIN: origin },
      timeout: 3500, windowsHide: true,
    })
    return stdout.trim()
  } catch {
    console.warn('无法读取 Windows 系统代理，将尝试直连币安。可通过 HTTPS_PROXY 指定服务端代理。')
    return ''
  }
}

export function createBinanceTransport(env, systemProxyFor = process.platform === 'win32' ? windowsProxyFor : undefined) {
  const httpProxy = env.http_proxy || env.HTTP_PROXY || ''
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? ''
  const dispatchers = new Map()

  async function createDispatcher(origin) {
    const systemProxy = !httpsProxy && noProxy.trim() !== '*' && systemProxyFor ? await systemProxyFor(origin) : ''
    return new EnvHttpProxyAgent({ httpProxy, httpsProxy: httpsProxy || systemProxy, noProxy })
  }

  function dispatcherFor(origin) {
    if (!dispatchers.has(origin)) dispatchers.set(origin, createDispatcher(origin))
    return dispatchers.get(origin)
  }

  return {
    async fetch(url, init) {
      return fetch(url, { ...init, dispatcher: await dispatcherFor(url.origin) })
    },
    async websocket(address) {
      const url = new URL(address)
      if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('行情连接需要公开的 WSS 地址。')
      return new WebSocket(url.href, { dispatcher: await dispatcherFor('https://' + url.host) })
    },
    close() {
      return Promise.allSettled([...dispatchers.values()].map(async pending => (await pending).close()))
    },
  }
}
