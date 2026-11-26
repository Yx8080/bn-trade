import { createHash } from 'node:crypto'
import timers from 'node:timers/promises'
import worker from '../worker/index.js'
import { isPlatformManualPosition } from './position-sources.js'
import { futuresBase, getFuturesPositionMode } from '../worker/futures.js'
import { prepareOpeningNotional } from '../worker/futures-equity.js'
import { maximumCopyLeverage, readCopyLeverageLimits } from '../worker/futures-leverage.js'
import { decimal, scale, sizedNotional, sizeMarketOrder, symbolRules, units } from '../worker/futures-sizing.js'
import {
  ApiError, binanceRequest, getTradingEnvironment, invalidData, isClientOrderId, isDecimal,
  isPositiveDecimal, isUsdtSymbol, orderResult, requireSymbol, reserveOrder, submitFuturesOrder,
} from '../worker/trading.js'

const confirmedModes = new WeakMap()
const maxSignalPages = 4

function normalizeSignal(portfolioId, row, since, until) {
  if (!row || !Number.isSafeInteger(row.orderUpdateTime) || !Number.isSafeInteger(row.orderTime)) throw invalidData()
  if (row.orderUpdateTime <= since || row.orderUpdateTime > until || !isUsdtSymbol(row.symbol)
    || !['LONG', 'SHORT'].includes(row.positionSide) || !['BUY', 'SELL'].includes(row.side)) return
  if (row.status != null && row.status !== 'FILLED') return
  for (const value of [row.executedQty, row.avgPrice]) {
    if ((typeof value !== 'number' && !isDecimal(value)) || !Number.isFinite(Number(value))) throw invalidData()
    if (Number(value) <= 0) return
  }
  // The public feed generally omits order IDs. Fill quantity, average price and
  // update time can change on later snapshots of the same source order.
  const identity = row.orderId == null
    ? [portfolioId, row.symbol, row.positionSide, row.side, row.type, row.orderTime]
    : [portfolioId, row.symbol, String(row.orderId)]
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const opens = row.positionSide === 'LONG' ? row.side === 'BUY' : row.side === 'SELL'
  return { id, symbol: row.symbol, direction: row.positionSide, kind: opens ? 'open' : 'close', time: row.orderUpdateTime }
}

async function readSignals(env, portfolioId, since, until) {
  if (typeof portfolioId !== 'string' || !/^\d+$/.test(portfolioId)
    || !Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || until < since) {
    throw new ApiError(400, 'INVALID_SIGNAL_QUERY', '跟单记录的组合或查询时段无效。')
  }
  const rows = new Map()
  const cursors = new Set()
  // Binance rejects starts near the current minute. Filter the wider response at the requested watermark.
  const startTime = Math.max(0, Math.min(since, until - 300_000))
  let indexValue
  let total
  for (let page = 0; page < maxSignalPages; page++) {
    const request = new Request('http://localhost/api/binance/latest-records', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolioId, startTime, endTime: until, pageSize: 50, indexValue }) })
    const response = await worker.fetch(request, env)
    const result = JSON.parse(await response.text(), (key, value, context) =>
      key === 'orderId' && typeof value === 'number' ? context.source : value)
    if (!response.ok || result?.code !== '000000' || result.success === false) {
      const error = new ApiError(response.ok ? 502 : response.status, 'COPY_SIGNALS_UNAVAILABLE',
        result?.message || '币安暂时无法提供带单成交记录。')
      const retryAfter = response.headers.get('Retry-After')
      if (retryAfter) error.headers = { 'Retry-After': retryAfter }
      throw error
    }
    const data = result.data
    if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.total) || data.total < 0) throw invalidData()
    if (total !== undefined && total !== data.total) break
    total = data.total
    // Cursor pages may repeat a boundary row; count distinct raw rows before filtering unsupported fills.
    for (const row of data.list) {
      const key = JSON.stringify([row?.orderId, row?.symbol, row?.positionSide, row?.side, row?.type, row?.orderTime,
        row?.orderUpdateTime, row?.executedQty, row?.avgPrice, row?.totalPnl])
      if (!rows.has(key)) rows.set(key, normalizeSignal(portfolioId, row, since, until))
    }
    if (rows.size === total) {
      const signals = new Map()
      for (const signal of rows.values()) {
        if (signal && !signals.has(signal.id)) signals.set(signal.id, signal)
      }
      return [...signals.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    }
    indexValue = data.indexValue
    if (rows.size > total || typeof indexValue !== 'string' || !indexValue || indexValue === '-1' || cursors.has(indexValue)) break
    cursors.add(indexValue)
    if (page + 1 < maxSignalPages) await timers.setTimeout(5_000)
  }
  throw new ApiError(503, 'INCOMPLETE_COPY_SIGNALS', '本轮带单记录不完整，暂缓执行该批信号。')
}

function finiteField(value) {
  if (!isDecimal(value) || !Number.isFinite(Number(value))) throw invalidData()
  return Number(value)
}

export function createCopyExchange(env, user, environment) {
  if (environment !== getTradingEnvironment(env)) throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更。')
  if (!user?.id || !user.apiKey || !user.apiSecret) {
    throw new ApiError(503, 'FUTURES_NOT_CONFIGURED', '此账户尚未配置合约密钥。')
  }
  const base = futuresBase
  const hedgeMode = () => new ApiError(409, 'COPY_ONE_WAY_REQUIRED', '请将币安合约账户切换为单向持仓后再启动跟单。')

  async function confirmOneWayMode() {
    if (await getFuturesPositionMode(env, base, user) === 'hedge') throw hedgeMode()
  }

  async function positions() {
    const credentials = { credentials: user }
    if (!confirmedModes.has(env)) confirmedModes.set(env, new WeakMap())
    const accounts = confirmedModes.get(env)
    const confirmed = accounts.get(user)
    if (confirmed?.base !== base || confirmed.until <= Date.now()) {
      await confirmOneWayMode()
      accounts.set(user, { base, until: Date.now() + 30_000 })
    }
    const risk = await binanceRequest(env, base, '/fapi/v3/positionRisk', credentials)
    if (!Array.isArray(risk)) throw invalidData()
    return risk.flatMap(row => {
      if (['LONG', 'SHORT'].includes(row?.positionSide)) {
        accounts.delete(user)
        throw hedgeMode()
      }
      if (row?.positionSide !== 'BOTH' || typeof row.symbol !== 'string' || !row.symbol) throw invalidData()
      const amount = finiteField(row.positionAmt)
      if (amount === 0) return []
      const entryPrice = finiteField(row.entryPrice)
      const markPrice = finiteField(row.markPrice)
      if (entryPrice <= 0 || markPrice <= 0) throw invalidData()
      return [{ symbol: row.symbol, direction: amount > 0 ? 'LONG' : 'SHORT', quantity: Math.abs(amount),
        entryPrice, markPrice, unrealizedPnl: finiteField(row.unRealizedProfit), updateTime: row.updateTime,
        quantityText: row.positionAmt, entryPriceText: row.entryPrice }]
    })
  }

  // Recheck inside the same symbol lease used by manual orders. An intervening
  // fill can invalidate ownership even when the new net quantity looks identical.
  async function checkPosition(symbol, guard) {
    const params = { symbol }
    const [risk, recent] = await Promise.all([
      binanceRequest(env, base, '/fapi/v3/positionRisk', { credentials: user, params }),
      guard.lastOrderId && binanceRequest(env, base, '/fapi/v1/userTrades', { credentials: user, params: { ...params, limit: 1 } }),
      guard.flat && confirmOneWayMode(),
    ])
    if (guard.flat) {
      // V3 may omit a symbol when it has neither a position nor an open order.
      if (!Array.isArray(risk) || risk.length > 1) throw invalidData()
      if (!risk.length) return
      const [row] = risk
      if (row?.symbol !== symbol || row.positionSide !== 'BOTH' || !isDecimal(row.positionAmt)) throw invalidData()
      if (!/^-?0+(?:\.0+)?$/.test(row.positionAmt)) {
        throw new ApiError(409, 'COPY_POSITION_NOT_FLAT', symbol + ' 已有仓位，跳过本次首次跟单。')
      }
      return
    }
    const expected = guard.actual
    const row = Array.isArray(risk) && risk.find(p => p.symbol === symbol && p.positionSide === 'BOTH')
    if (!row || !Number.isSafeInteger(expected.updateTime) || expected.updateTime <= 0 || row.updateTime !== expected.updateTime
      || row.positionAmt !== expected.quantityText || row.entryPrice !== expected.entryPriceText
      || (guard.lastOrderId && (!Array.isArray(recent) || recent.length !== 1 || recent[0].symbol !== symbol
        || recent[0].orderId !== guard.lastOrderId || recent[0].positionSide !== 'BOTH'))) {
      throw new ApiError(409, 'SHARED_POSITION_CHANGED', symbol + ' 的账户仓位或最近成交已变化，无法确认跟单数量，本次未下单。')
    }
  }

  async function openingPrices(symbol) {
    const options = { params: { symbol } }
    const [ticker, mark] = await Promise.all([
      binanceRequest(env, base, '/fapi/v2/ticker/price', options),
      binanceRequest(env, base, '/fapi/v1/premiumIndex', options),
    ])
    if (ticker.symbol !== symbol || mark.symbol !== symbol || !isPositiveDecimal(ticker.price) || !isPositiveDecimal(mark.markPrice)) throw invalidData()
    return { price: units(ticker.price), mark: units(mark.markPrice) }
  }

  function openingQuantity(notional, rules, { price, mark }) {
    const quantity = sizeMarketOrder(notional * scale / price, rules)
    if (quantity * mark < rules.minNotional * scale) {
      throw new ApiError(400, 'COPY_MIN_NOTIONAL', '跟单金额低于该合约的最低市价单名义价值。')
    }
    return quantity
  }

  async function prepareLeveragedOpening(symbol, sizingMode, amount, leverage, rules) {
    const [prices, sizing, limits] = await Promise.all([
      openingPrices(symbol), prepareOpeningNotional(env, base, user, sizingMode, amount),
      readCopyLeverageLimits(env, base, user, symbol),
    ])
    const requested = typeof leverage === 'object' ? leverage[limits.tiers[0].leverage]
      : typeof leverage === 'number' ? leverage : undefined
    const selected = maximumCopyLeverage(limits, candidate => {
      const lots = sizing.notionalAt(candidate) * scale / prices.price / rules.step
      return (lots * rules.step * prices.mark + scale - 1n) / scale
    }, requested)
    const quantity = openingQuantity(sizing.fundedNotional(selected), rules, prices)
    return { leverage: selected, quantity: decimal(quantity) }
  }

  async function submit(symbol, direction, amount, clientOrderId, closing, leverage, sizingMode, guard) {
    let params
    let prepareOpening
    try {
      requireSymbol(symbol)
      if (!['LONG', 'SHORT'].includes(direction) || !isClientOrderId(clientOrderId)
        || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        throw new ApiError(400, 'INVALID_COPY_ORDER', '跟单方向、金额或订单号无效。')
      }
      const rules = await symbolRules(env, base, symbol)
      let quantity
      if (closing) {
        quantity = sizeMarketOrder(units(amount), rules)
      } else if (leverage != null) {
        prepareOpening = () => prepareLeveragedOpening(symbol, sizingMode, amount, leverage, rules)
      } else {
        const notional = sizedNotional(sizingMode, amount)
        quantity = openingQuantity(notional, rules, await openingPrices(symbol))
      }
      const side = (direction === 'LONG') !== closing ? 'BUY' : 'SELL'
      params = { symbol, positionSide: 'BOTH', side, type: 'MARKET',
        newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' }
      if (quantity !== undefined) {
        params.quantity = decimal(quantity)
        if (!isPositiveDecimal(params.quantity)) throw invalidData()
      }
      if (closing) params.reduceOnly = 'true'
      reserveOrder(env, environment, 'futures', user.id, clientOrderId)
    } catch (error) {
      if (error.code !== 'ORDER_UNKNOWN') error.definite = true
      throw error
    }
    try {
      const preflight = guard || prepareOpening ? async () => {
        const prepared = await prepareOpening?.()
        if (guard) await checkPosition(symbol, guard)
        return prepared
      } : undefined
      const result = await submitFuturesOrder(env, base, user, params, undefined, preflight)
      return orderResult(result, symbol, clientOrderId, params)
    } catch (error) {
      // A duplicate can refer to an accepted earlier submission. Unknown status and unrecognized gateway errors require lookup.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && /^-\d+$/.test(error.code)
        && !['-4111', '-4116'].includes(error.code) && !/duplicat/i.test(error.message)) error.definite = true
      throw error
    }
  }

  return {
    signals: (portfolioId, since, until) => readSignals(env, portfolioId, since, until),
    positions,
    isPlatformManualPosition: actual => isPlatformManualPosition(env, user, environment, actual),
    open: (symbol, direction, amount, id, leverage, sizingMode = 'notional', guard) =>
      submit(symbol, direction, amount, id, false, leverage, sizingMode, guard),
    close: (symbol, direction, quantity, id, guard) => submit(symbol, direction, quantity, id, true, undefined, undefined, guard),
    async lookup(symbol, clientOrderId) {
      requireSymbol(symbol)
      if (!isClientOrderId(clientOrderId)) throw new ApiError(400, 'INVALID_ORDER_ID', '客户订单号无效。')
      const result = await binanceRequest(env, base, '/fapi/v1/order', { credentials: user, params: { symbol, origClientOrderId: clientOrderId } })
      return orderResult(result, symbol, clientOrderId)
    },
    async fills(symbol, orderId) {
      requireSymbol(symbol)
      if (typeof orderId !== 'string' || !/^\d{1,20}$/.test(orderId)) throw new ApiError(400, 'INVALID_ORDER_ID', '币安订单号无效。')
      const limit = 1000
      const rows = await binanceRequest(env, base, '/fapi/v1/userTrades', { credentials: user, params: { symbol, orderId, limit } })
      if (!Array.isArray(rows)) throw invalidData()
      if (rows.length >= limit) throw new ApiError(503, 'INCOMPLETE_COPY_FILLS', '单笔订单的成交流水已达查询上限，暂缓结算。')
      const seen = new Set()
      return rows.map(row => {
        if (row?.symbol !== symbol || row.orderId !== orderId || !row.commissionAsset || typeof row.commissionAsset !== 'string'
          || !(typeof row.id === 'string' ? /^\d+$/.test(row.id) : Number.isSafeInteger(row.id) && row.id >= 0)) throw invalidData()
        const id = String(row.id)
        if (seen.has(id)) throw invalidData()
        seen.add(id)
        const quantity = finiteField(row.qty)
        const price = finiteField(row.price)
        if (quantity <= 0 || price <= 0) throw invalidData()
        return { quantity, price, realized: finiteField(row.realizedPnl), commission: finiteField(row.commission),
          commissionAsset: row.commissionAsset }
      })
    },
  }
}
