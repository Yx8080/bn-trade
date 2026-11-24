import { createHash } from 'node:crypto'
import timers from 'node:timers/promises'
import worker from '../worker/index.js'
import {
  ApiError, binanceRequest, getTradingEnvironment, invalidData, isClientOrderId, isDecimal,
  isPositiveDecimal, isUsdtSymbol, orderResult, requireSymbol, reserveOrder,
} from '../worker/trading.js'

const futuresBases = { live: 'https://fapi.binance.com', testnet: 'https://demo-fapi.binance.com' }
const marketInfo = new WeakMap()
const confirmedModes = new WeakMap()
const scale = 10n ** 18n
const maxSignalPages = 4

// Fixed-point arithmetic avoids rounding a market order up to the next lot.
function units(value) {
  const parts = String(value).match(/^(\d{1,20})(?:\.(\d{1,18}))?(?:e([+-]?\d{1,2}))?$/i)
  if (!parts) throw invalidData()
  const fraction = parts[2] ?? ''
  const shift = 18 + Number(parts[3] ?? 0) - fraction.length
  const digits = BigInt(parts[1] + fraction)
  return shift < 0 ? digits / 10n ** BigInt(-shift) : digits * 10n ** BigInt(shift)
}

function decimal(value) {
  const digits = value.toString().padStart(19, '0')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '')
}

function commonStep(first, second) {
  if (!first || !second) return first || second
  let a = first
  let b = second
  while (b) [a, b] = [b, a % b]
  return first / a * second
}

async function symbolRules(env, base, symbol) {
  let cached = marketInfo.get(env)
  if (!cached || cached.base !== base || Date.now() >= cached.expiresAt) {
    const info = binanceRequest(env, base, '/fapi/v1/exchangeInfo').then(data => {
      if (!Array.isArray(data.symbols)) throw invalidData()
      return new Map(data.symbols.map(market => [market.symbol, market]))
    })
    cached = { base, info, expiresAt: Date.now() + 60_000 }
    marketInfo.set(env, cached)
    info.catch(() => { if (marketInfo.get(env) === cached) marketInfo.delete(env) })
  }
  const market = (await cached.info).get(symbol)
  if (!market || market.status !== 'TRADING' || market.quoteAsset !== 'USDT' || !market.orderTypes?.includes('MARKET')) {
    throw new ApiError(409, 'COPY_MARKET_UNAVAILABLE', '该 USDT 合约当前无法使用市价单。')
  }
  if (!Array.isArray(market.filters)) throw invalidData()
  const filters = new Map(market.filters.map(filter => [filter.filterType, filter]))
  const lot = filters.get('LOT_SIZE')
  const marketLot = filters.get('MARKET_LOT_SIZE')
  if (!lot || !marketLot) throw invalidData()
  const step = commonStep(units(lot.stepSize), units(marketLot.stepSize))
  if (!step) throw invalidData()
  return { step, lots: [lot, marketLot], minNotional: units(filters.get('MIN_NOTIONAL')?.notional) }
}

function sizeMarketOrder(requested, rules) {
  const qty = requested / rules.step * rules.step
  for (const filter of rules.lots) {
    const min = units(filter.minQty)
    const max = units(filter.maxQty)
    if (!qty || qty < min || (max && qty > max)) {
      throw new ApiError(400, 'COPY_LOT_SIZE', '跟单数量不在该合约允许的市价单数量范围内。')
    }
  }
  return qty
}

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
  const base = futuresBases[environment]

  async function positions() {
    const credentials = { credentials: user }
    if (!confirmedModes.has(env)) confirmedModes.set(env, new WeakMap())
    const accounts = confirmedModes.get(env)
    const confirmed = accounts.get(user)
    const hedgeMode = () => new ApiError(409, 'COPY_ONE_WAY_REQUIRED', '请将币安合约账户切换为单向持仓后再启动跟单。')
    if (confirmed?.base !== base || confirmed.until <= Date.now()) {
      const mode = await binanceRequest(env, base, '/fapi/v1/positionSide/dual', credentials)
      if (mode.dualSidePosition === true) throw hedgeMode()
      if (mode.dualSidePosition !== false) throw invalidData()
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
        entryPrice, markPrice, unrealizedPnl: finiteField(row.unRealizedProfit) }]
    })
  }

  async function submit(symbol, direction, amount, clientOrderId, closing) {
    let params
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
      } else {
        const options = { params: { symbol } }
        const [ticker, mark] = await Promise.all([
          binanceRequest(env, base, '/fapi/v2/ticker/price', options),
          binanceRequest(env, base, '/fapi/v1/premiumIndex', options),
        ])
        if (ticker.symbol !== symbol || mark.symbol !== symbol || !isPositiveDecimal(ticker.price) || !isPositiveDecimal(mark.markPrice)) throw invalidData()
        quantity = sizeMarketOrder(units(amount) * scale / units(ticker.price), rules)
        if (quantity * units(mark.markPrice) < rules.minNotional * scale) {
          throw new ApiError(400, 'COPY_MIN_NOTIONAL', '跟单金额低于该合约的最低市价单名义价值。')
        }
      }
      const side = (direction === 'LONG') !== closing ? 'BUY' : 'SELL'
      params = { symbol, positionSide: 'BOTH', side, type: 'MARKET', quantity: decimal(quantity),
        newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' }
      if (!isPositiveDecimal(params.quantity)) throw invalidData()
      if (closing) params.reduceOnly = 'true'
      reserveOrder(env, environment, 'futures', user.id, clientOrderId)
    } catch (error) {
      if (error.code !== 'ORDER_UNKNOWN') error.definite = true
      throw error
    }
    try {
      const result = await binanceRequest(env, base, '/fapi/v1/order', { method: 'POST', credentials: user, params, order: true })
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
    open: (symbol, direction, amountUSDT, id) => submit(symbol, direction, amountUSDT, id, false),
    close: (symbol, direction, quantity, id) => submit(symbol, direction, quantity, id, true),
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
