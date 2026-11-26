import type { FuturesSession, Quote, SpotQuote } from './futures'

type Market = 'spot' | 'futures'
type Environment = FuturesSession['environment']

export interface MarketQuote {
  price: string
  priceTime: number
  mark: string
  markTime: number
}

export function marketStreamUrl(market: Market, symbol: string) {
  const pair = encodeURIComponent(symbol.toLowerCase())
  if (market === 'spot') {
    return `wss://stream.binance.com:443/ws/${pair}@miniTicker`
  }
  return `wss://fstream.binance.com/market/stream?streams=${pair}@miniTicker/${pair}@markPrice@1s`
}

export function subscribeMarketQuote(
  market: Market, environment: Environment, symbol: string,
  readQuote: (signal: AbortSignal) => Promise<SpotQuote | Quote>,
  onQuote: (quote: MarketQuote) => void, onError: (message: string) => void,
  onLoading: (loading: boolean) => void,
) {
  const quote: MarketQuote = { price: '', priceTime: 0, mark: '', markTime: 0 }
  let socket: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let paintTimer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let stopped = false
  let attempts = 0
  let connectedAt = 0
  let lastPriceEvent = 0
  let lastMarkEvent = 0
  const staleAfter = 15_000

  function update(kind: 'price' | 'mark', value: unknown, time: unknown) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !(Number(value) > 0) || !Number.isFinite(Number(value))
      || typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0 || time > Date.now() + 5_000) return false
    const key = kind === 'price' ? 'priceTime' : 'markTime'
    if (time < quote[key]) return false
    quote[kind] = value
    quote[key] = time
    if (paintTimer === undefined) {
      paintTimer = setTimeout(() => {
        paintTimer = undefined
        onQuote({ ...quote })
      }, 200)
    }
    return true
  }

  async function refresh() {
    if (stopped || request) return
    request = new AbortController()
    onLoading(true)
    try {
      const snapshot = await readQuote(request.signal)
      if (stopped) return
      if (snapshot.symbol !== symbol || snapshot.environment !== environment) throw new Error('行情交易对或环境不匹配。')
      if ('markPrice' in snapshot) {
        update('mark', snapshot.markPrice, snapshot.time)
        update('price', snapshot.lastPrice, snapshot.lastTime)
      } else {
        update('price', snapshot.lastPrice, snapshot.time)
      }
    } catch (error) {
      if (!stopped) {
        const status = (error as { status?: number })?.status
        if (status && [403, 418, 429, 451].includes(status)) {
          dispose()
          onError((error instanceof Error ? error.message : '币安拒绝了行情请求。') + ' 自动刷新已暂停。')
        } else {
          onError(error instanceof Error ? error.message : '行情获取失败。')
        }
      }
    } finally {
      request = undefined
      if (!stopped) onLoading(false)
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== undefined) return
    const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(attempts++, 6))
    reconnectTimer = setTimeout(connect, Math.round(backoff * (0.75 + Math.random() * 0.25)))
  }

  function connect() {
    reconnectTimer = undefined
    if (stopped || socket) return
    try {
      socket = new WebSocket(marketStreamUrl(market, symbol))
    } catch {
      scheduleReconnect()
      return
    }
    connectedAt = Date.now()
    socket.onmessage = event => {
      if (stopped || typeof event.data !== 'string' || event.data.length > 16_384) return
      let body
      try { body = JSON.parse(event.data) } catch { return }
      const tick = body?.data ?? body
      if (tick?.s !== symbol) return
      if (tick.e === '24hrMiniTicker' && update('price', tick.c, tick.E)) lastPriceEvent = tick.E
      if (market === 'futures' && tick.e === 'markPriceUpdate' && update('mark', tick.p, tick.E)) lastMarkEvent = tick.E
      if (Date.now() - connectedAt > 10_000 && Date.now() - lastPriceEvent < staleAfter) attempts = 0
    }
    socket.onclose = () => {
      socket = undefined
      scheduleReconnect()
    }
  }

  function disconnect() {
    if (!socket) return
    socket.onmessage = null
    socket.onclose = null
    socket.close()
    socket = undefined
  }

  const health = setInterval(() => {
    const now = Date.now()
    const streamTime = market === 'futures' ? Math.min(lastPriceEvent, lastMarkEvent) : lastPriceEvent
    if (now - streamTime >= staleAfter) void refresh()
    if (socket && now - Math.max(connectedAt, lastPriceEvent, lastMarkEvent) >= 60_000) {
      disconnect()
      scheduleReconnect()
    }
  }, staleAfter)

  function dispose() {
    if (stopped) return
    stopped = true
    request?.abort()
    clearInterval(health)
    clearTimeout(reconnectTimer)
    clearTimeout(paintTimer)
    disconnect()
    onLoading(false)
  }

  connect()
  void refresh()
  return dispose
}
