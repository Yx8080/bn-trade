import { futuresBases, futuresPositions } from '../worker/futures.js'
import { spotBalances, spotBases } from '../worker/spot.js'
import { ApiError, binanceRequest, invalidData, isDecimal, isPositiveDecimal } from '../worker/trading.js'
import { ledgerIdentity } from './platform-store.js'

const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value)
const limit = 100

function normalizeFill(row, symbol, spot) {
  if (!row || row.symbol !== symbol || !id(row.id) || !id(row.orderId)
    || !Number.isSafeInteger(row.time) || row.time <= 0 || !isPositiveDecimal(row.qty) || !isPositiveDecimal(row.price)
    || !isDecimal(row.commission) || typeof row.commissionAsset !== 'string' || !row.commissionAsset) throw invalidData()
  if (spot ? typeof row.isBuyer !== 'boolean' : !['BUY', 'SELL'].includes(row.side)
    || !['BOTH', 'LONG', 'SHORT'].includes(row.positionSide) || !isDecimal(row.realizedPnl)) throw invalidData()
  return { id: row.id, orderId: row.orderId, symbol, time: row.time,
    side: spot ? (row.isBuyer ? 'BUY' : 'SELL') : row.side, positionSide: spot ? null : row.positionSide,
    quantity: row.qty, price: row.price, commission: row.commission, commissionAsset: row.commissionAsset,
    realizedPnl: spot ? null : row.realizedPnl, marginAsset: spot ? null : row.marginAsset ?? null }
}

function marketAccess(env, user, environment, market, symbol) {
  if (market !== 'spot' && market !== 'futures') throw new ApiError(400, 'INVALID_MARKET', '请选择现货或合约市场。')
  if (typeof symbol !== 'string' || !/^[\p{Lu}\p{Lo}\p{Nd}]{2,32}$/u.test(symbol)) {
    throw new ApiError(400, 'INVALID_SYMBOL', '请输入完整的交易对。')
  }
  const spot = market === 'spot'
  const credentials = spot ? { apiKey: user.spotApiKey, apiSecret: user.spotApiSecret } : user
  if (!credentials.apiKey || !credentials.apiSecret) throw new ApiError(503,
    spot ? 'SPOT_NOT_CONFIGURED' : 'FUTURES_NOT_CONFIGURED', '当前账户尚未配置此市场的交易所密钥。')
  const base = (spot ? spotBases : futuresBases)[environment]
  return { db: env.orderStore, environment, market, symbol, spot, userId: user.id, key: ledgerIdentity(user.id, credentials.apiKey),
    signed: (path, params) => binanceRequest(env, base, path, { credentials, params }) }
}

async function classifyFills(access, fills, scope) {
  if (!Array.isArray(fills)) throw invalidData()
  const includeAll = scope !== 'other'
  const { db, environment, market, symbol, spot, userId, key, signed } = access
  const byId = new Map()
  for (const fill of fills) {
    const row = normalizeFill(fill, symbol, spot)
    const previous = byId.get(row.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw invalidData()
    byId.set(row.id, row)
  }
  const ids = [...new Set([...byId.values()].map(row => row.orderId))]
  const known = new Map()
  for (const orderId of db.platform.orderIds(environment, userId, key, market, symbol, ids)) {
    known.set(orderId, { source: 'manual', portfolioId: null })
  }
  if (!spot) {
    for (const { orderId, portfolioId, copyKind, copyDirection } of db.copy.orderPortfolios(environment, userId, key, symbol, ids)) {
      known.set(orderId, portfolioId && !known.has(orderId)
        ? { source: 'copy', portfolioId, copyKind, copyDirection } : { source: 'unverified', portfolioId: null })
    }
  }
  const provenExternal = new Set()
  // Legacy requests and acknowledgements in flight may only have a client ID
  // in SQLite. Cross-check the exchange order before labeling its fill.
  const crossCheck = ids.some(value => !known.has(value)) && db.hasUnlinkedRequests(environment, market, userId, key, symbol)
  if (crossCheck) {
    let orders
    try {
      orders = await signed(spot ? '/api/v3/allOrders' : '/fapi/v1/allOrders', { symbol, limit })
      if (!Array.isArray(orders) || orders.some(row => row?.symbol !== symbol || !id(row.orderId)
        || typeof row.clientOrderId !== 'string' || !row.clientOrderId)
        || new Set(orders.map(row => row.orderId)).size !== orders.length) throw invalidData()
    } catch (error) {
      if (!includeAll) throw error
      // Executions are already authenticated. Unavailable extra order evidence
      // leaves the unmatched fills unattributed.
      orders = []
    }
    const reserved = db.reservedOrderSources(environment, market, userId, key, symbol, orders)
    for (const row of orders) {
      if (known.has(row.orderId)) continue
      if (reserved.has(row.orderId)) known.set(row.orderId, reserved.get(row.orderId))
      else provenExternal.add(row.orderId)
    }
  }
  const trades = []
  for (const row of byId.values()) {
    const origin = known.get(row.orderId)
    if (origin && !includeAll) continue
    const source = origin?.source ?? (crossCheck && !provenExternal.has(row.orderId) ? 'unverified' : 'untracked')
    const trade = { ...row, source }
    if (includeAll) trade.portfolioId = origin?.portfolioId ?? null
    if (scope === 'position') {
      trade.copyKind = origin?.copyKind ?? null
      trade.copyDirection = origin?.copyDirection ?? null
    }
    trades.push(trade)
  }
  return trades.sort((a, b) => b.time - a.time || b.id.length - a.id.length || b.id.localeCompare(a.id))
}

export function classifyFuturesFills(env, user, environment, symbol, fills) {
  return classifyFills(marketAccess(env, user, environment, 'futures', symbol), fills, 'position')
}

export async function otherTrades(env, user, environment, market, symbol, scope = 'other') {
  const access = marketAccess(env, user, environment, market, symbol)
  const { signed, spot } = access
  if (scope !== 'other' && (scope !== 'all' || spot)) throw new ApiError(400, 'INVALID_SCOPE', '请选择有效的合约成交查询范围。')
  const includeAll = scope === 'all'
  const [inventory, fills] = await Promise.all([
    includeAll ? null : spot ? signed('/api/v3/account', { omitZeroBalances: 'true' }) : signed('/fapi/v3/positionRisk'),
    signed(spot ? '/api/v3/myTrades' : '/fapi/v1/userTrades', { symbol, limit }),
  ])
  if (!Array.isArray(fills) || fills.length > limit) throw invalidData()
  const trades = await classifyFills(access, fills, scope)
  if (includeAll) return { market, symbol, trades, limit, windowDays: 7, atLimit: fills.length === limit }
  return { market, symbol, balances: spot ? spotBalances(inventory) : [], positions: spot ? [] : futuresPositions(inventory), trades }
}
