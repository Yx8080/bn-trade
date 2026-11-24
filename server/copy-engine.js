import { randomUUID } from 'node:crypto'
import { isUsdtSymbol } from '../worker/trading.js'

const freshnessMs = 30_000
const overlapMs = 10_000
const historyMs = 29 * 86_400_000
const catchupSpanMs = 3_600_000
const running = new WeakSet()
const terminal = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH'])
const active = new Set(['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL'])
const closeEnough = (a, b, fraction = 1e-10) => Math.abs(a - b) <= Math.max(a, b) * fraction
const rounded = value => Number(value.toPrecision(15))
const describe = error => error instanceof Error ? error.message.slice(0, 250) : '请求失败。'

export async function runCopyTick(state, exchange, save, now = Date.now()) {
  if (running.has(state)) return
  running.add(state)
  try {
    await tick(state, exchange, save, now)
  } finally {
    running.delete(state)
  }
}

async function tick(state, exchange, save, now) {
  if (state.retryAt > now) return
  state.retryAt = 0
  const wallStart = Date.now()
  const currentTime = () => now + Math.max(0, Date.now() - wallStart)
  const errors = []
  state.openedAfter ??= state.since
  state.feedFloor ??= state.since
  state.exitBarriers ??= {}
  state.lastCheck = now
  const checked = new Set()
  const owned = symbol => state.positions.find(position => position.symbol === symbol)
  const persist = execution => save(structuredClone(state), execution)

  function invalidatePnl() {
    const flat = !state.pending && !state.positions.length
    state.unrealized = flat ? 0 : null
    state.unrealizedAt = flat ? currentTime() : null
  }

  function log(message) {
    state.events.unshift({ time: currentTime(), message })
    state.events.length = Math.min(state.events.length, 80)
  }

  function problem(message) {
    if (!errors.includes(message)) errors.push(message)
    if (!state.error?.includes(message)) log(message)
    state.error = errors.join(' ')
  }

  function exchangeProblem(prefix, error) {
    let message = prefix + describe(error)
    if (error?.status === 418 || error?.status === 429) {
      const header = error.headers?.get?.('Retry-After') ?? error.headers?.['Retry-After'] ?? error.headers?.['retry-after']
      const current = currentTime()
      const deadline = /^\d+$/.test(header) ? current + Number(header) * 1000 : Date.parse(header)
      state.retryAt = Number.isSafeInteger(deadline) && deadline > current ? deadline : current + 60_000
      state.recoveringFeed = true
      message += ' 币安限流，将在 ' + Math.ceil((state.retryAt - current) / 1000) + ' 秒后恢复巡检。'
    }
    problem(message)
  }

  function blockEntriesThrough(symbol, time) {
    state.exitBarriers[symbol] = Math.max(state.exitBarriers[symbol] ?? 0, time)
  }

  // A cumulative acknowledgement is applied against the immutable pre-order snapshot.
  // A crash before/after saving a partial fill can therefore replay the same lookup.
  function applyAck(pending, ack) {
    const buying = (pending.kind === 'open') === (pending.direction === 'LONG')
    const qty = Number(ack?.executedQty)
    const price = Number(ack?.avgPrice)
    if (!ack || ack.symbol !== pending.symbol || ack.clientOrderId !== pending.clientOrderId
      || ack.side !== (buying ? 'BUY' : 'SELL') || ack.type !== 'MARKET'
      || typeof ack.orderId !== 'string' || !/^\d+$/.test(ack.orderId)
      || (pending.orderId && ack.orderId !== pending.orderId)
      || typeof ack.executedQty !== 'string' || !/^\d+(\.\d+)?$/.test(ack.executedQty)
      || !Number.isFinite(qty) || qty < (pending.applied ?? 0)
      || (!terminal.has(ack.status) && !active.has(ack.status)) || (ack.status === 'FILLED' && !qty)
      || (qty > 0 && !(Number.isFinite(price) && price > 0))
      || (pending.kind === 'close' && qty > pending.baseQuantity && !closeEnough(qty, pending.baseQuantity))) {
      problem(pending.symbol + ' 订单回执待核实，将按原订单号查询。')
      return
    }
    let position = owned(pending.symbol)
    if (qty > 0 && pending.kind === 'open') {
      if (!position) {
        position = { symbol: pending.symbol, direction: pending.direction, signalTime: pending.signalTime }
        state.positions.push(position)
      }
      position.quantity = rounded(pending.baseQuantity + qty)
      position.entryPrice = pending.baseQuantity
        ? (pending.baseQuantity * pending.baseEntryPrice + qty * price) / position.quantity : price
      position.entries = pending.baseEntries + 1
      if (pending.exit) position.exit = pending.exit
      if (pending.historyGap) position.historyGap = true
    }
    if (qty > 0 && pending.kind === 'close' && position) {
      if (closeEnough(pending.baseQuantity, qty)) {
        state.positions.splice(state.positions.indexOf(position), 1)
      } else {
        position.quantity = rounded(pending.baseQuantity - qty)
      }
    }
    if (pending.applied !== qty || pending.status !== ack.status) {
      log(pending.symbol + ' ' + (pending.kind === 'open' ? '开仓' : '仅减仓平仓')
        + ' ' + ack.status + '，累计成交 ' + ack.executedQty + '。')
    }
    pending.applied = qty
    pending.status = ack.status
    pending.orderId = ack.orderId
    if (terminal.has(ack.status)) state.pending = null
    invalidatePnl()
    if (qty > 0) return {
      clientOrderId: pending.clientOrderId, orderId: ack.orderId, symbol: pending.symbol, direction: pending.direction,
      kind: pending.kind, portfolioId: state.config.portfolioId, time: pending.time ?? now, quantity: qty, price,
    }
  }

  async function submit(kind, symbol, direction, signalTime) {
    const position = owned(symbol)
    const pending = {
      kind, symbol, direction, clientOrderId: randomUUID(), baseQuantity: position?.quantity ?? 0,
      baseEntryPrice: position?.entryPrice ?? 0, baseEntries: position?.entries ?? 0,
      signalTime: position?.signalTime ?? signalTime, time: currentTime(),
    }
    state.pending = pending
    invalidatePnl()
    persist()
    let ack
    try {
      ack = kind === 'open'
        ? await exchange.open(symbol, direction, state.config.amount, pending.clientOrderId)
        : await exchange.close(symbol, direction, pending.baseQuantity, pending.clientOrderId)
    } catch (error) {
      if (error?.definite === true) state.pending = null
      invalidatePnl()
      exchangeProblem(symbol + (state.pending ? ' 订单待核对。' : ' '), error)
      persist()
      return
    }
    persist(applyAck(pending, ack))
  }

  if (state.pending) {
    const pending = state.pending
    let ack
    try {
      ack = await exchange.lookup(pending.symbol, pending.clientOrderId)
    } catch (error) {
      exchangeProblem(pending.symbol + ' 原订单仍待核实。', error)
    }
    persist(ack && applyAck(pending, ack))
    if (state.retryAt) return
  }

  let account
  let accountFailed = false
  async function readAccount() {
    try {
      const positions = await exchange.positions()
      if (!Array.isArray(positions) || positions.some(p => !p || typeof p.symbol !== 'string'
        || !['LONG', 'SHORT'].includes(p.direction) || !Number.isFinite(p.quantity) || p.quantity <= 0
        || !Number.isFinite(p.entryPrice) || p.entryPrice <= 0 || !Number.isFinite(p.unrealizedPnl))
        || new Set(positions.map(p => p.symbol)).size !== positions.length) throw Error('账户持仓数据无效。')
      account = new Map(positions.map(p => [p.symbol, p]))
    } catch (error) {
      account = undefined
      accountFailed = true
      state.recoveringFeed = true
      invalidatePnl()
      exchangeProblem('无法核对账户持仓。', error)
    }
  }

  function matches(position, actual) {
    return actual?.direction === position.direction && closeEnough(actual.quantity, position.quantity)
      && closeEnough(actual.entryPrice, position.entryPrice, 1e-5)
  }

  if (state.positions.length || state.pending) await readAccount()
  if (state.retryAt) { persist(); return }
  if (account && !state.pending && state.positions.every(p => matches(p, account.get(p.symbol)))) {
    state.unrealized = state.positions.reduce((total, p) => total + account.get(p.symbol).unrealizedPnl, 0)
    state.unrealizedAt = currentTime()
  } else {
    invalidatePnl()
  }

  function requestExit(position, time, reason) {
    blockEntriesThrough(position.symbol, time)
    if (!position.exit) {
      position.exit = reason
      log(position.symbol + ' ' + reason + '，将仅减仓平掉跟单数量。')
    }
    if (state.pending) problem('原订单尚待核实，已记录平仓请求。若需立即退出，请在币安核对并处理仓位。')
  }

  function releasePosition(position) {
    state.positions.splice(state.positions.indexOf(position), 1)
    blockEntriesThrough(position.symbol, currentTime())
    log(position.symbol + ' 账户仓位与跟单成交不符，已停止接管该仓位。')
    state.unrealized = null
    state.unrealizedAt = null
    persist()
  }

  async function exitIfPossible(position, refresh = false) {
    if (state.pending || state.retryAt || accountFailed || checked.has(position)) return
    checked.add(position)
    if (refresh) await readAccount()
    if (!account) return
    if (!matches(position, account.get(position.symbol))) return releasePosition(position)
    await submit('close', position.symbol, position.direction)
  }

  for (const position of [...state.positions]) {
    if (!account) continue
    const actual = account.get(position.symbol)
    const verifying = state.pending?.symbol === position.symbol
    if (!matches(position, actual)) {
      if (verifying) continue
      releasePosition(position)
      continue
    }
    if (state.config.stopLoss > 0 && actual.unrealizedPnl <= -state.config.stopLoss) {
      requestExit(position, now, '单仓浮亏已达 ' + state.config.stopLoss + ' USDT 止损线')
      if (verifying && state.pending.kind === 'open') state.pending.exit = position.exit
    }
    if (position.exit) await exitIfPossible(position)
  }

  if (state.retryAt) { persist(); return }
  const managing = Boolean(state.positions.length || state.pending)
  const earliest = now - (managing ? historyMs : freshnessMs)
  if (managing && state.since < earliest) {
    for (const p of state.positions) p.historyGap = true
    if (state.pending?.kind === 'open') state.pending.historyGap = true
  }
  if (state.positions.some(p => p.historyGap) || state.pending?.historyGap) {
    problem('中断时间超出可核对的公开成交窗口，部分平仓信号可能缺失。请在币安核对现有仓位。')
  }
  const start = Math.max(state.feedFloor, state.since - (state.catchupSpan ? 0 : overlapMs), earliest)
  const until = managing ? Math.min(now, Math.max(state.since, earliest) + (state.catchupSpan ?? catchupSpanMs)) : now
  const missed = now - state.since > freshnessMs
  let signals
  try {
    signals = await exchange.signals(state.config.portfolioId, start, until)
    if (!Array.isArray(signals) || signals.some(s => !s || typeof s.id !== 'string' || !s.id
      || !Number.isSafeInteger(s.time) || typeof s.symbol !== 'string'
      || !['open', 'close'].includes(s.kind) || !['LONG', 'SHORT'].includes(s.direction))) {
      throw Error('带单成交格式无效。')
    }
  } catch (error) {
    state.recoveringFeed = true
    if (managing && error?.code === 'INCOMPLETE_COPY_SIGNALS') {
      state.catchupSpan = Math.max(1000, Math.floor((until - Math.max(state.since, earliest)) / 2))
    }
    exchangeProblem(managing ? '尚未核实带单员是否平仓，将继续核对。' : '无法取得带单成交。', error)
    persist()
    return
  }

  if (missed || state.recoveringFeed) {
    if (!accountFailed && state.enabled && until === now) log('巡检中断后恢复，从本次检查起等待新的开仓信号。')
    state.openedAfter = Math.max(state.openedAfter, now)
    state.recoveringFeed = accountFailed
  }
  const seen = new Set(state.seen)
  // At an ambiguous millisecond prefer an exit over adding exposure.
  signals = signals.filter(s => s.time >= start && s.time > state.feedFloor && s.time <= until && isUsdtSymbol(s.symbol))
    .sort((a, b) => a.time - b.time || Number(a.kind === 'open') - Number(b.kind === 'open'))
  for (const signal of signals) {
    if (seen.has(signal.id)) continue
    seen.add(signal.id)
    state.seen.push(signal.id)
    const { symbol, direction, time } = signal
    const position = owned(symbol)
    if (signal.kind === 'close') {
      blockEntriesThrough(symbol, time)
      if (state.pending?.symbol === symbol && state.pending.kind === 'open' && state.pending.direction === direction
        && time >= (state.pending.signalTime ?? 0)) {
        requestExit(state.pending, time, '带单员已平仓')
      }
      if (position?.direction === direction && time >= (position.signalTime ?? 0)) {
        requestExit(position, time, '带单员已平仓')
        await exitIfPossible(position, true)
      }
      continue
    }
    if (time <= Math.max(state.openedAfter, state.exitBarriers[symbol] ?? 0) || currentTime() - time > freshnessMs
      || !state.enabled || state.pending || state.retryAt || accountFailed || position?.exit || position?.historyGap) continue
    if (position) {
      if (position.direction !== direction || state.config.repeat !== 'fixed' || position.entries >= state.config.maxEntries) continue
    } else if (state.positions.length >= state.config.maxPositions) {
      continue
    }
    await readAccount()
    if (!account || currentTime() - time > freshnessMs) continue
    if (position && !matches(position, account.get(symbol))) {
      releasePosition(position)
      continue
    }
    if (position && state.config.stopLoss > 0 && account.get(symbol).unrealizedPnl <= -state.config.stopLoss) {
      requestExit(position, currentTime(), '单仓浮亏已达 ' + state.config.stopLoss + ' USDT 止损线')
      await exitIfPossible(position)
      continue
    }
    if (!position && account.has(symbol)) continue
    await submit('open', symbol, direction, time)
  }
  state.since = Math.max(state.since, until)
  if (until === now) delete state.catchupSpan
  if (state.seen.length > 512) {
    state.feedFloor = until
    state.seen = state.seen.slice(-512)
  }
  for (const [symbol, time] of Object.entries(state.exitBarriers)) {
    if (time < start) delete state.exitBarriers[symbol]
  }
  state.error = errors.join(' ')
  persist()
}
