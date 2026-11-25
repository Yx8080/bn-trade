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

function initializeFeeds(state) {
  if (state.feeds) return
  const ids = state.config.portfolioIds ?? [state.config.portfolioId]
  state.feeds = Object.fromEntries(ids.map(portfolioId => [portfolioId, {
    since: state.since, floor: state.feedFloor ?? state.since, seen: [...(state.seen ?? [])],
    openedAfter: state.openedAfter ?? state.since, catchupSpan: state.catchupSpan,
    recovering: state.recoveringFeed ?? false, exitBarriers: {},
  }]))
  delete state.feedFloor
  delete state.seen
  delete state.catchupSpan
  delete state.recoveringFeed
}

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
  initializeFeeds(state)
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
      for (const feed of Object.values(state.feeds)) feed.recovering = true
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
        position = { symbol: pending.symbol, portfolioId: pending.portfolioId, direction: pending.direction, signalTime: pending.signalTime }
        state.positions.push(position)
      }
      position.quantity = rounded(pending.baseQuantity + qty)
      position.entryPrice = pending.baseQuantity
        ? (pending.baseQuantity * pending.baseEntryPrice + qty * price) / position.quantity : price
      position.entries = pending.baseEntries + 1
      if (pending.shared) {
        // A cumulative fill always uses the combined basis from before submission,
        // including on recovery after a partial acknowledgement.
        const before = pending.shared.manualQuantity + pending.baseQuantity
        position.shared = {
          manualQuantity: pending.shared.manualQuantity,
          accountEntryPrice: (before * pending.shared.accountEntryPrice + qty * price) / (before + qty),
          lastOrderId: ack.orderId,
        }
      }
      if (pending.exit) position.exit = pending.exit
      if (pending.historyGap) position.historyGap = true
    }
    if (qty > 0 && pending.kind === 'close' && position) {
      if (closeEnough(pending.baseQuantity, qty)) {
        state.positions.splice(state.positions.indexOf(position), 1)
      } else {
        position.quantity = rounded(pending.baseQuantity - qty)
        if (position.shared) position.shared.lastOrderId = ack.orderId
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
      kind: pending.kind, portfolioId: pending.portfolioId, time: pending.time ?? now, quantity: qty, price,
    }
  }

  async function submit(kind, symbol, direction, portfolioId, signalTime, manualBase) {
    const position = owned(symbol)
    const shared = position?.shared ?? manualBase
    const guard = shared ? { actual: account.get(symbol), lastOrderId: shared.lastOrderId } : undefined
    const pending = {
      kind, symbol, direction, portfolioId, clientOrderId: randomUUID(), baseQuantity: position?.quantity ?? 0,
      baseEntryPrice: position?.entryPrice ?? 0, baseEntries: position?.entries ?? 0,
      signalTime: position?.signalTime ?? signalTime, time: currentTime(),
      ...(shared && { shared: { ...shared } }),
    }
    state.pending = pending
    invalidatePnl()
    persist()
    let ack
    try {
      ack = kind === 'open'
        ? await exchange.open(symbol, direction, state.config.amount, pending.clientOrderId,
          state.config.leverage ?? undefined, state.config.sizingMode ?? 'notional', guard ?? (!position ? { flat: true } : undefined))
        : await exchange.close(symbol, direction, pending.baseQuantity, pending.clientOrderId, guard)
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
      for (const feed of Object.values(state.feeds)) feed.recovering = true
      invalidatePnl()
      exchangeProblem('无法核对账户持仓。', error)
    }
  }

  function matches(position, actual) {
    const combined = position.quantity + (position.shared?.manualQuantity ?? 0)
    return actual?.direction === position.direction && closeEnough(actual.quantity, combined)
      && closeEnough(actual.entryPrice, position.shared?.accountEntryPrice ?? position.entryPrice, 1e-5)
  }

  function strategyPnl(position) {
    const actual = account.get(position.symbol)
    if (!position.shared) return actual.unrealizedPnl
    const sign = position.direction === 'LONG' ? 1 : -1
    return sign * (actual.markPrice - position.entryPrice) * position.quantity
  }

  if (state.positions.length || state.pending) await readAccount()
  if (state.retryAt) { persist(); return }
  if (account && !state.pending && state.positions.every(p => matches(p, account.get(p.symbol)))) {
    state.unrealized = state.positions.reduce((total, p) => total + strategyPnl(p), 0)
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
    if (!account || state.retryAt) return
    if (!matches(position, account.get(position.symbol))) return releasePosition(position)
    await submit('close', position.symbol, position.direction, position.portfolioId)
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
    if (state.config.stopLoss > 0 && strategyPnl(position) <= -state.config.stopLoss) {
      requestExit(position, now, '单仓浮亏已达 ' + state.config.stopLoss + ' USDT 止损线')
      if (verifying && state.pending.kind === 'open') state.pending.exit = position.exit
    }
    if (position.exit) await exitIfPossible(position)
  }

  if (state.retryAt) { persist(); return }
  async function readFeed(portfolioId, feed) {
    const positions = state.positions.filter(p => p.portfolioId === portfolioId)
    const pending = state.pending?.portfolioId === portfolioId ? state.pending : null
    const managing = Boolean(positions.length || pending)
    if (!state.enabled && !managing) return
    const earliest = now - (managing ? historyMs : freshnessMs)
    if (managing && feed.since < earliest) {
      for (const position of positions) position.historyGap = true
      if (pending?.kind === 'open') pending.historyGap = true
    }
    if (positions.some(p => p.historyGap) || pending?.historyGap) {
      problem('组合 ' + portfolioId + ' 超出可核对的公开成交窗口，部分平仓信号可能缺失。请在币安核对现有仓位。')
    }
    const start = Math.max(feed.floor, feed.since - (feed.catchupSpan ? 0 : overlapMs), earliest)
    const until = managing ? Math.min(now, Math.max(feed.since, earliest) + (feed.catchupSpan ?? catchupSpanMs)) : now
    try {
      const signals = await exchange.signals(portfolioId, start, until)
      if (!Array.isArray(signals) || signals.some(s => !s || typeof s.id !== 'string' || !s.id
        || !Number.isSafeInteger(s.time) || typeof s.symbol !== 'string'
        || !['open', 'close'].includes(s.kind) || !['LONG', 'SHORT'].includes(s.direction))) {
        throw Error('带单成交格式无效。')
      }
      if (now - feed.since > freshnessMs || feed.recovering) {
        if (!accountFailed && state.enabled && until === now) log('组合 ' + portfolioId + ' 巡检恢复，等待新的开仓信号。')
        feed.openedAfter = Math.max(feed.openedAfter, now)
        feed.recovering = accountFailed
      }
      return { feed, start, until, signals: signals
        .filter(s => s.time >= start && s.time > feed.floor && s.time <= until && isUsdtSymbol(s.symbol))
        .map(s => ({ ...s, portfolioId })) }
    } catch (error) {
      feed.recovering = true
      if (managing && error?.code === 'INCOMPLETE_COPY_SIGNALS') {
        feed.catchupSpan = Math.max(1000, Math.floor((until - Math.max(feed.since, earliest)) / 2))
      }
      exchangeProblem('组合 ' + portfolioId + (managing ? ' 尚未核实带单员是否平仓。' : ' 无法取得带单成交。'), error)
    }
  }

  async function applyBatches(batches) {
    // At an ambiguous millisecond prefer an exit over adding exposure.
    const signals = batches.flatMap(batch => batch.signals)
      .sort((a, b) => a.time - b.time || Number(a.kind === 'open') - Number(b.kind === 'open'))
    const seenByFeed = new Map(batches.map(({ feed }) => [feed, new Set(feed.seen)]))
    for (const signal of signals) {
      const { portfolioId, symbol, direction, time } = signal
      const feed = state.feeds[portfolioId]
      const seen = seenByFeed.get(feed)
      if (seen.has(signal.id)) continue
      seen.add(signal.id)
      feed.seen.push(signal.id)
      const position = owned(symbol)
      if (signal.kind === 'close') {
        feed.exitBarriers[symbol] = Math.max(feed.exitBarriers[symbol] ?? 0, time)
        if (state.pending?.portfolioId === portfolioId && state.pending.symbol === symbol
          && state.pending.kind === 'open' && state.pending.direction === direction
          && time >= (state.pending.signalTime ?? 0)) {
          requestExit(state.pending, time, '带单员已平仓')
        }
        if (position?.portfolioId === portfolioId && position.direction === direction && time >= (position.signalTime ?? 0)) {
          requestExit(position, time, '带单员已平仓')
          await exitIfPossible(position, true)
        }
        continue
      }
      if (time <= Math.max(state.openedAfter, feed.openedAfter, feed.exitBarriers[symbol] ?? 0, state.exitBarriers[symbol] ?? 0)
        || currentTime() - time > freshnessMs
        || !state.enabled || state.pending || state.retryAt || accountFailed || position?.exit || position?.historyGap) continue
      if (position) {
        if (position.portfolioId !== portfolioId) {
          log(symbol + ' 已由组合 ' + position.portfolioId + ' 持仓，跳过组合 ' + portfolioId + ' 的开仓。')
          continue
        }
        if (position.direction !== direction || state.config.repeat !== 'fixed' || position.entries >= state.config.maxEntries) continue
      } else if (state.positions.length >= state.config.maxPositions) {
        continue
      }
      await readAccount()
      if (!account || state.retryAt || currentTime() - time > freshnessMs) continue
      if (position && !matches(position, account.get(symbol))) {
        releasePosition(position)
        continue
      }
      if (position && state.config.stopLoss > 0 && strategyPnl(position) <= -state.config.stopLoss) {
        requestExit(position, currentTime(), '单仓浮亏已达 ' + state.config.stopLoss + ' USDT 止损线')
        await exitIfPossible(position)
        continue
      }
      let manualBase
      const existing = account.get(symbol)
      if (!position && existing) {
        if (state.config.manualPositionPolicy !== 'add' || existing.direction !== direction) {
          log(symbol + ' 已有' + (existing.direction === direction ? '同向' : '反向') + '仓位，跳过本次跟单。')
          continue
        }
        try {
          if (!await exchange.isPlatformManualPosition(existing)) {
            log(symbol + ' 未能确认现有仓位全部来自平台手动下单，跳过本次跟单。')
            continue
          }
        } catch (error) {
          exchangeProblem(symbol + ' 无法核对手动仓位来源，跳过本次跟单。', error)
          continue
        }
        if (currentTime() - time > freshnessMs) continue
        manualBase = { manualQuantity: existing.quantity, accountEntryPrice: existing.entryPrice }
      }
      await submit('open', symbol, direction, portfolioId, time, manualBase)
    }
    for (const { feed, start, until } of batches) {
      feed.since = Math.max(feed.since, until)
      if (until === now) delete feed.catchupSpan
      if (feed.seen.length > 512) {
        feed.floor = until
        feed.seen = feed.seen.slice(-512)
      }
      for (const [symbol, time] of Object.entries(feed.exitBarriers)) {
        if (time < start) delete feed.exitBarriers[symbol]
      }
    }
  }

  // A slow paginated feed must not hold up an exit already returned by another
  // leader. Merge the available batches by signal time and serialize all effects.
  const feeds = Object.entries(state.feeds)
  const reading = new Set()
  const ready = []
  let nextFeed = 0
  while (nextFeed < feeds.length || reading.size || ready.length) {
    while (!state.retryAt && nextFeed < feeds.length && reading.size < 4) {
      const [id, feed] = feeds[nextFeed++]
      const request = readFeed(id, feed).then(batch => {
        if (batch) ready.push(batch)
      }).finally(() => reading.delete(request))
      reading.add(request)
    }
    if (!ready.length && reading.size) await Promise.race(reading)
    if (state.retryAt) {
      await Promise.all(reading)
      for (const feed of Object.values(state.feeds)) feed.recovering = true
      break
    }
    if (ready.length) await applyBatches(ready.splice(0))
  }
  state.since = Math.min(...Object.values(state.feeds).map(feed => feed.since))
  for (const [symbol, time] of Object.entries(state.exitBarriers)) {
    if (time < now - freshnessMs) delete state.exitBarriers[symbol]
  }
  state.error = errors.join(' ')
  persist()
}
