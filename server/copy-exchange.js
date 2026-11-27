import { isPlatformManualPosition } from './position-sources.js'
import { futuresBase, getFuturesPositionMode } from '../worker/futures.js'
import { prepareOpeningNotional } from '../worker/futures-equity.js'
import { maximumCopyLeverage, readCopyLeverageLimits } from '../worker/futures-leverage.js'
import { decimal, scale, sizedNotional, sizeMarketOrder, symbolRules, units } from '../worker/futures-sizing.js'
import {
  ApiError, binanceRequest, getTradingEnvironment, invalidData, isClientOrderId, isDecimal,
  isPositiveDecimal, orderResult, requireSymbol, reserveOrder, submitFuturesOrder, unknownOrder,
} from '../worker/trading.js'

const confirmedModes = new WeakMap()

function finiteField(value) {
  if (!isDecimal(value) || !Number.isFinite(Number(value))) throw invalidData()
  return Number(value)
}

const sideMatchesMode = (side, mode) => mode === 'oneWay' ? side === 'BOTH' : ['LONG', 'SHORT'].includes(side)

function positionRows(risk, mode, symbol) {
  if (!Array.isArray(risk)) throw invalidData()
  const seen = new Set()
  for (const row of risk) {
    if (typeof row?.symbol !== 'string' || !row.symbol || (symbol && row.symbol !== symbol)
      || !sideMatchesMode(row.positionSide, mode)) throw invalidData()
    const key = row.symbol + '/' + row.positionSide
    const amount = finiteField(row.positionAmt)
    if (seen.has(key) || (row.positionSide === 'LONG' && amount < 0) || (row.positionSide === 'SHORT' && amount > 0)) throw invalidData()
    seen.add(key)
  }
  return risk
}

export function createCopyExchange(env, user, environment) {
  if (environment !== getTradingEnvironment(env)) throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更。')
  if (!user?.id || !user.apiKey || !user.apiSecret) {
    throw new ApiError(503, 'FUTURES_NOT_CONFIGURED', '此账户尚未配置合约密钥。')
  }
  const base = futuresBase
  const readMode = () => getFuturesPositionMode(env, base, user)

  async function confirmMode(mode) {
    if (await readMode() !== mode) {
      confirmedModes.get(env)?.delete(user)
      throw new ApiError(409, 'COPY_POSITION_MODE_CHANGED', '币安合约账户的持仓模式已变化，已跳过本次跟单。')
    }
  }

  async function positions() {
    const credentials = { credentials: user }
    if (!confirmedModes.has(env)) confirmedModes.set(env, new WeakMap())
    const accounts = confirmedModes.get(env)
    const confirmed = accounts.get(user)
    const risk = await binanceRequest(env, base, '/fapi/v3/positionRisk', credentials)
    let mode = confirmed?.mode
    if (!(confirmed?.until > Date.now()) || !Array.isArray(risk) || risk.some(row => !sideMatchesMode(row?.positionSide, mode))) {
      mode = await readMode()
      accounts.set(user, { mode, until: Date.now() + 30_000 })
    }
    const positions = positionRows(risk, mode).flatMap(row => {
      const amount = Number(row.positionAmt)
      if (amount === 0) return []
      const entryPrice = finiteField(row.entryPrice)
      const markPrice = finiteField(row.markPrice)
      if (entryPrice <= 0 || markPrice <= 0) throw invalidData()
      return [{ symbol: row.symbol, direction: amount > 0 ? 'LONG' : 'SHORT', quantity: Math.abs(amount),
        entryPrice, markPrice, unrealizedPnl: finiteField(row.unRealizedProfit), updateTime: row.updateTime,
        quantityText: row.positionAmt, entryPriceText: row.entryPrice, positionSide: row.positionSide }]
    })
    return { mode, positions }
  }

  // Recheck inside the same symbol lease used by manual orders. An intervening
  // fill can invalidate ownership even when the new net quantity looks identical.
  async function checkPosition(symbol, positionSide, guard) {
    const params = { symbol }
    const mode = positionSide === 'BOTH' ? 'oneWay' : 'hedge'
    const [risk, recent] = await Promise.all([
      binanceRequest(env, base, '/fapi/v3/positionRisk', { credentials: user, params }),
      guard.lastOrderId && binanceRequest(env, base, '/fapi/v1/userTrades', {
        credentials: user, params: { ...params, limit: mode === 'hedge' ? 100 : 1 },
      }),
      guard.flat && confirmMode(mode),
    ])
    const row = positionRows(risk, mode, symbol).find(p => p.positionSide === positionSide)
    if (guard.flat) {
      // V3 may omit a symbol when it has neither a position nor an open order.
      if (row && Number(row.positionAmt) !== 0) {
        throw new ApiError(409, 'COPY_POSITION_NOT_FLAT', symbol + ' 已有仓位，跳过本次首次跟单。')
      }
      return
    }
    const expected = guard.actual
    let latest
    if (guard.lastOrderId && Array.isArray(recent)) {
      if (mode === 'oneWay' && recent.length === 1) latest = recent[0]
      if (mode === 'hedge') {
        for (const fill of recent) {
          if (fill?.symbol !== symbol || !['LONG', 'SHORT'].includes(fill.positionSide) || !/^\d{1,20}$/.test(fill.id)) throw invalidData()
          if (fill.positionSide === positionSide && (!latest || BigInt(fill.id) > BigInt(latest.id))) latest = fill
        }
      }
    }
    if (!row || !Number.isSafeInteger(expected.updateTime) || expected.updateTime <= 0 || row.updateTime !== expected.updateTime
      || row.positionAmt !== expected.quantityText || row.entryPrice !== expected.entryPriceText
      || (guard.lastOrderId && (latest?.symbol !== symbol || latest.orderId !== guard.lastOrderId || latest.positionSide !== positionSide))) {
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
    const positionSide = guard?.positionSide ?? 'BOTH'
    let params
    let prepareOpening
    try {
      requireSymbol(symbol)
      if (!['LONG', 'SHORT'].includes(direction) || (positionSide !== 'BOTH' && positionSide !== direction) || !isClientOrderId(clientOrderId)
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
      params = { symbol, positionSide, side, type: 'MARKET',
        newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' }
      if (quantity !== undefined) {
        params.quantity = decimal(quantity)
        if (!isPositiveDecimal(params.quantity)) throw invalidData()
      }
      if (closing && positionSide === 'BOTH') params.reduceOnly = 'true'
      reserveOrder(env, environment, 'futures', user.id, clientOrderId)
    } catch (error) {
      if (error.code !== 'ORDER_UNKNOWN') error.definite = true
      throw error
    }
    try {
      const preflight = guard || prepareOpening ? async () => {
        const prepared = await prepareOpening?.()
        if (guard) await checkPosition(symbol, positionSide, guard)
        return prepared
      } : undefined
      const result = await submitFuturesOrder(env, base, user, params, undefined, preflight)
      if ((positionSide !== 'BOTH' || result.positionSide != null) && result.positionSide !== positionSide) throw unknownOrder()
      return { ...orderResult(result, symbol, clientOrderId, params), positionSide }
    } catch (error) {
      // A duplicate can refer to an accepted earlier submission. Unknown status and unrecognized gateway errors require lookup.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && /^-\d+$/.test(error.code)
        && !['-4111', '-4116'].includes(error.code) && !/duplicat/i.test(error.message)) error.definite = true
      throw error
    }
  }

  return {
    positions,
    isPlatformManualPosition: actual => isPlatformManualPosition(env, user, environment, actual),
    open: (symbol, direction, amount, id, leverage, sizingMode = 'notional', guard) =>
      submit(symbol, direction, amount, id, false, leverage, sizingMode, guard),
    close: (symbol, direction, quantity, id, guard) => submit(symbol, direction, quantity, id, true, undefined, undefined, guard),
    async lookup(symbol, clientOrderId) {
      requireSymbol(symbol)
      if (!isClientOrderId(clientOrderId)) throw new ApiError(400, 'INVALID_ORDER_ID', '客户订单号无效。')
      const result = await binanceRequest(env, base, '/fapi/v1/order', { credentials: user, params: { symbol, origClientOrderId: clientOrderId } })
      return { ...orderResult(result, symbol, clientOrderId), positionSide: result.positionSide }
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
