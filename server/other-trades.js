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

export async function otherTrades(env, user, environment, market, symbol) {
  if (market !== 'spot' && market !== 'futures') throw new ApiError(400, 'INVALID_MARKET', '请选择现货或合约市场。')
  if (typeof symbol !== 'string' || !/^[\p{Lu}\p{Lo}\p{Nd}]{2,32}$/u.test(symbol)) {
    throw new ApiError(400, 'INVALID_SYMBOL', '请输入完整的交易对。')
  }
  const spot = market === 'spot'
  const credentials = spot ? { apiKey: user.spotApiKey, apiSecret: user.spotApiSecret } : user
  if (!credentials.apiKey || !credentials.apiSecret) throw new ApiError(503,
    spot ? 'SPOT_NOT_CONFIGURED' : 'FUTURES_NOT_CONFIGURED', '当前账户尚未配置此市场的交易所密钥。')
  const base = (spot ? spotBases : futuresBases)[environment]
  const signed = (path, params) => binanceRequest(env, base, path, { credentials, params })
  const [inventory, fills] = await Promise.all([
    spot ? signed('/api/v3/account', { omitZeroBalances: 'true' }) : signed('/fapi/v3/positionRisk'),
    signed(spot ? '/api/v3/myTrades' : '/fapi/v1/userTrades', { symbol, limit }),
  ])
  if (!Array.isArray(fills) || fills.length > limit) throw invalidData()
  const rows = fills.map(fill => normalizeFill(fill, symbol, spot))
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw invalidData()
  const db = env.orderStore
  const key = ledgerIdentity(user.id, credentials.apiKey)
  const ids = [...new Set(rows.map(row => row.orderId))]
  const known = db.platform.orderIds(environment, user.id, key, market, symbol, ids)
  if (!spot) {
    for (const value of db.copy.orderIds(environment, user.id, key, symbol, ids)) known.add(value)
  }
  const provenExternal = new Set()
  // Legacy requests and acknowledgements in flight may only have a client ID
  // in SQLite. Cross-check the exchange order before labeling its fill.
  const crossCheck = ids.some(value => !known.has(value)) && db.hasUnlinkedRequests(environment, market, user.id, key, symbol)
  if (crossCheck) {
    const orders = await signed(spot ? '/api/v3/allOrders' : '/fapi/v1/allOrders', { symbol, limit })
    if (!Array.isArray(orders) || orders.some(row => row?.symbol !== symbol || !id(row.orderId)
      || typeof row.clientOrderId !== 'string' || !row.clientOrderId)) throw invalidData()
    const reserved = db.reservedOrderIds(environment, market, user.id, key, symbol, orders)
    for (const row of orders) {
      if (reserved.has(row.orderId)) known.add(row.orderId)
      else provenExternal.add(row.orderId)
    }
  }
  const trades = rows.filter(row => !known.has(row.orderId)).map(row => ({ ...row,
    source: crossCheck && !provenExternal.has(row.orderId) ? 'unverified' : 'untracked' }))
  trades.sort((a, b) => b.time - a.time || b.id.length - a.id.length || b.id.localeCompare(a.id))
  return { market, symbol, balances: spot ? spotBalances(inventory) : [],
    positions: spot ? [] : futuresPositions(inventory), trades }
}
