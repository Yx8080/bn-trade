import { isUsdtSymbol } from '../worker/trading.js'

const url = 'wss://fstream.binance.com/market/stream'

// Mark updates only wake the account risk check. The account snapshot and engine decide whether to close.
export function createMarkWatch(connectSocket, onThreshold) {
  let positions = new Map()
  const subscribed = new Set()
  const lastEvent = new Map()
  const lastWake = new Map()
  const deferred = new Map()
  let socket
  let connecting = false
  let generation = 0
  let retry
  let watchdog
  let attempts = 0
  let connectedAt = 0
  let heardAt = 0
  let messageId = 0
  let stopped = false

  function disconnect() {
    generation++
    connecting = false
    clearTimeout(retry)
    retry = undefined
    clearInterval(watchdog)
    for (const timer of deferred.values()) clearTimeout(timer)
    deferred.clear()
    subscribed.clear()
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
      socket = undefined
    }
  }

  function reconnect() {
    disconnect()
    if (stopped || !positions.size) return
    const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(attempts++, 6))
    retry = setTimeout(() => { retry = undefined; void connect() }, backoff * (0.75 + Math.random() * 0.25))
    retry.unref()
  }

  function sync() {
    if (socket?.readyState !== 1) return
    const wanted = new Set([...positions.keys()].sort().slice(0, 1024))
    function send(method, symbols) {
      if (symbols.length) socket.send(JSON.stringify({ method, params: symbols.map(s => s.toLowerCase() + '@markPrice@1s'), id: ++messageId }))
    }
    try {
      send('UNSUBSCRIBE', [...subscribed].filter(symbol => !wanted.has(symbol)))
      send('SUBSCRIBE', [...wanted].filter(symbol => !subscribed.has(symbol)))
      subscribed.clear()
      for (const symbol of wanted) subscribed.add(symbol)
    } catch { reconnect() }
  }

  function receive(event) {
    if (typeof event.data !== 'string' || event.data.length > 16_384) return
    let body
    try { body = JSON.parse(event.data) } catch { return }
    if (body?.code != null) { reconnect(); return }
    inspect(body?.data ?? body)
  }

  function inspect(tick) {
    const now = Date.now()
    if (tick?.e !== 'markPriceUpdate' || !subscribed.has(tick.s)
      || (tick.st != null && Number(tick.st) !== 1) || !Number.isSafeInteger(tick.E)
      || tick.E > now + 250 || now - tick.E > 5000 || tick.E <= (lastEvent.get(tick.s) ?? 0)
      || typeof tick.p !== 'string' || !/^\d+(?:\.\d+)?$/.test(tick.p)) return
    const mark = Number(tick.p)
    if (!Number.isFinite(mark) || mark <= 0) return
    if (tick.E > now) {
      // The exchange clock can lead the local clock by milliseconds. Only evaluate after event time.
      clearTimeout(deferred.get(tick.s))
      const timer = setTimeout(() => { deferred.delete(tick.s); inspect(tick) }, tick.E - now + 1)
      timer.unref()
      deferred.set(tick.s, timer)
      return
    }
    lastEvent.set(tick.s, tick.E)
    heardAt = now
    if (now - connectedAt > 10_000) attempts = 0
    for (const position of positions.get(tick.s)?.values() ?? []) {
      const difference = position.direction === 'LONG' ? position.entryPrice - mark : mark - position.entryPrice
      if (difference * position.quantity < position.stopLoss) { position.triggered = false; continue }
      if (position.triggered || now - (lastWake.get(position.userId) ?? 0) < 3_000) continue
      position.triggered = true
      lastWake.set(position.userId, now)
      void Promise.resolve().then(() => {
        if (!stopped) return onThreshold(position.userId)
      }).catch(error => console.warn('行情触发风险复核失败', error?.code ?? error?.name))
    }
  }

  async function connect() {
    if (stopped || !positions.size || connecting || socket || retry) return
    const ticket = ++generation
    connecting = true
    try {
      const candidate = await connectSocket(url)
      if (generation !== ticket) { candidate.close(); return }
      socket = candidate
      connecting = false
      connectedAt = heardAt = Date.now()
      socket.onopen = sync
      socket.onmessage = receive
      socket.onerror = socket.onclose = reconnect
      watchdog = setInterval(() => { if (Date.now() - heardAt > 30_000) reconnect() }, 15_000)
      watchdog.unref()
      sync()
    } catch {
      if (ticket === generation) reconnect()
    }
  }

  return {
    update(rows) {
      if (stopped) return
      const next = new Map()
      const users = new Set()
      for (const item of rows) {
        if (!item?.userId || !isUsdtSymbol(item.symbol) || !['LONG', 'SHORT'].includes(item.direction)
          || ![item.quantity, item.entryPrice, item.stopLoss].every(value => Number.isFinite(value) && value > 0)) continue
        const previous = positions.get(item.symbol)?.get(item.userId)
        const triggered = previous?.triggered && ['direction', 'quantity', 'entryPrice', 'stopLoss'].every(key => previous[key] === item[key])
        if (!next.has(item.symbol)) next.set(item.symbol, new Map())
        next.get(item.symbol).set(item.userId, { ...item, triggered })
        users.add(item.userId)
      }
      positions = next
      for (const symbol of lastEvent.keys()) if (!next.has(symbol)) lastEvent.delete(symbol)
      for (const user of lastWake.keys()) if (!users.has(user)) lastWake.delete(user)
      if (!next.size) {
        disconnect()
        attempts = 0
      } else if (socket) sync()
      else void connect()
    },
    close() {
      stopped = true
      positions.clear()
      lastEvent.clear()
      lastWake.clear()
      disconnect()
    },
  }
}
