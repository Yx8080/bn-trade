import { ledgerIdentity } from './platform-store.js'
import { futuresBase, futuresPositions } from '../worker/futures.js'
import { spotBalances, spotBase } from '../worker/spot.js'
import { ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, invalidData,
  isPositiveDecimal, jsonResponse } from '../worker/trading.js'

const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * tolerance

// Reconstruct each platform position's weighted entry from actually settled fills.
// A reduction keeps the entry basis, and a reversal opens a new basis at the fill price.
export function manualPositionBasis(fills) {
  const positions = new Map()
  for (const fill of fills) {
    const key = fill.symbol + '/' + fill.positionSide
    const prior = positions.get(key)
    const before = prior?.quantity ?? 0
    const delta = (fill.side === 'BUY' ? 1 : -1) * fill.quantity
    const after = before + delta
    if (near(before, -delta) || (fill.positionSide === 'LONG' && after < 0)
      || (fill.positionSide === 'SHORT' && after > 0)) {
      positions.delete(key)
      continue
    }
    let entryPrice = fill.price
    if (prior && Math.sign(before) === Math.sign(delta)) entryPrice = (before * prior.entryPrice + delta * fill.price) / after
    else if (prior && Math.sign(before) === Math.sign(after)) entryPrice = prior.entryPrice
    const firstTradeId = prior && Math.sign(before) === Math.sign(after) ? prior.firstTradeId : fill.tradeId
    positions.set(key, { symbol: fill.symbol, positionSide: fill.positionSide, quantity: after, entryPrice, firstTradeId, unrealized: null })
  }
  return [...positions.values()]
}

async function valueFutures(env, user, fills, positions, copySymbols) {
  if (!positions.length) return
  const risk = await binanceRequest(env, futuresBase, '/fapi/v3/positionRisk', { credentials: user })
  const live = futuresPositions(risk)
  const ownTrades = new Set(fills.map(f => f.symbol + '/' + f.tradeId))
  for (const p of positions) {
    if (copySymbols.has(p.symbol)) continue
    const match = live.find(row => row.symbol === p.symbol && row.positionSide === p.positionSide)
    if (match?.marginAsset !== 'USDT' || !near(Number(match.quantity), p.quantity) || !near(Number(match.entryPrice), p.entryPrice, 1e-6)) continue
    // An external close and reopen can leave exactly the same quantity and entry price.
    // Verify the fills on this leg since the platform first opened the current position.
    const trades = await binanceRequest(env, futuresBase, '/fapi/v1/userTrades', {
      credentials: user, params: { symbol: p.symbol, fromId: p.firstTradeId, limit: 1000 } })
    if (!Array.isArray(trades) || trades.some(t => t.symbol !== p.symbol || !['BOTH', 'LONG', 'SHORT'].includes(t.positionSide))) throw invalidData()
    if (trades.length >= 1000 || !trades.some(t => t.id === p.firstTradeId)
      || trades.some(t => t.positionSide === p.positionSide && !ownTrades.has(p.symbol + '/' + t.id))) continue
    p.unrealized = Number(match.unrealizedPnl)
  }
}

async function valueSpot(env, user, rows) {
  if (!rows.length) return
  const credentials = { apiKey: user.spotApiKey, apiSecret: user.spotApiSecret }
  const base = spotBase
  const balances = spotBalances(await binanceRequest(env, base, '/api/v3/account', { credentials, params: { omitZeroBalances: 'true' } }))
  for (const row of rows) {
    const balance = balances.find(item => item.asset === row.symbol.slice(0, -4))
    if (!balance || !near(Number(balance.free) + Number(balance.locked), row.quantity)) continue
    // Spot balances are fungible. A disposal outside the platform (or a history
    // window too short to rule it out) makes attribution of the original lot uncertain.
    const trades = await binanceRequest(env, base, '/api/v3/myTrades', { credentials, params: { symbol: row.symbol, limit: 1000 } })
    if (!Array.isArray(trades) || trades.some(t => t.symbol !== row.symbol || !Number.isSafeInteger(t.time) || typeof t.isBuyer !== 'boolean')) throw invalidData()
    if (!trades.length || trades.some(t => !t.isBuyer && t.time >= row.firstBuyTime)
      || (trades.length >= 1000 && Math.min(...trades.map(t => t.time)) >= row.firstBuyTime)) continue
    const ticker = await binanceRequest(env, base, '/api/v3/ticker/price', { params: { symbol: row.symbol } })
    if (ticker.symbol !== row.symbol || !isPositiveDecimal(ticker.price)) throw invalidData()
    row.value = row.quantity * Number(ticker.price)
    row.unrealized = row.value - row.cost
  }
}

export async function platformPnl(request, env) {
  try {
    if (request.method !== 'GET') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET' })
    const user = await getTradingUser(request, env)
    const environment = getTradingEnvironment(env)
    const url = new URL(request.url)
    const page = Number(url.searchParams.get('page') ?? 1)
    if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / 20))
      throw new ApiError(400, 'INVALID_PAGE', '页码无效。')
    const keys = { spot: ledgerIdentity(user.id, user.spotApiKey), futures: ledgerIdentity(user.id, user.apiKey) }
    const db = env.orderStore
    const { spot: inventory, ...ledger } = db.platform.report(environment, user.id, page, keys)
    if (url.pathname === '/api/platform/pnl') return jsonResponse(ledger)
    const spot = inventory.map(({ symbol, quantity, cost, firstBuyTime }) => ({ symbol, quantity, cost, firstBuyTime, value: null, unrealized: null }))
    const fills = db.platform.futuresFills(environment, user.id, keys)
    const manualPositions = manualPositionBasis(fills)
    const strategy = db.copy.read(environment, user.id)?.state
    const copySymbols = new Set(strategy?.keyIdentity === keys.futures ? strategy.positions.map(p => p.symbol) : [])
    const checks = await Promise.allSettled([valueSpot(env, user, spot), valueFutures(env, user, fills, manualPositions, copySymbols)])
    const hasUnknown = [...spot, ...manualPositions].some(p => p.unrealized == null)
    const valuationError = checks.some(result => result.status === 'rejected') ? '部分持仓行情或交易所记录暂时无法核对。'
      : hasUnknown ? '部分持仓无法与平台成交单独匹配，未计入浮动盈亏。' : ''
    return jsonResponse({ spot, manualPositions, valuationTime: Date.now(), valuationError })
  } catch (error) { return apiErrorResponse(error) }
}
