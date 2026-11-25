import { ApiError, binanceRequest, getTradingEnvironment, getTradingUserById, invalidData, isDecimal, orderResult } from '../worker/trading.js'
import { ledgerIdentity, terminalOrder } from './platform-store.js'
import { units } from '../worker/futures-sizing.js'

const endpoints = {
  spot: { live: 'https://api.binance.com', testnet: 'https://testnet.binance.vision', order: '/api/v3/order', trades: '/api/v3/myTrades' },
  futures: { live: 'https://fapi.binance.com', testnet: 'https://demo-fapi.binance.com', order: '/fapi/v1/order', trades: '/fapi/v1/userTrades' },
}

function number(value, positive = false) {
  if (!isDecimal(value) || !Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) throw invalidData()
  return Number(value)
}

function normalizedFills(trades, row, fromId) {
  if (!Array.isArray(trades) || trades.length > 1000) throw invalidData()
  const seen = new Set()
  return trades.map(trade => {
    const futures = row.market === 'futures'
    const id = typeof trade?.id === 'string' ? trade.id : Number.isSafeInteger(trade?.id) ? String(trade.id) : ''
    if (!/^\d{1,20}$/.test(id) || seen.has(id) || BigInt(id) < BigInt(fromId)
      || trade.symbol !== row.symbol || trade.orderId !== row.orderId || !Number.isSafeInteger(trade.time) || trade.time <= 0
      || typeof trade.commissionAsset !== 'string' || !trade.commissionAsset
      || (futures ? (trade.side !== row.side || trade.positionSide !== row.positionSide) : trade.isBuyer !== true)) throw invalidData()
    seen.add(id)
    const realizedAsset = futures ? trade.marginAsset ?? 'USDT' : 'USDT'
    if (typeof realizedAsset !== 'string' || !realizedAsset) throw invalidData()
    if (!isDecimal(trade.qty) || trade.qty.startsWith('-') || units(trade.qty) <= 0n) throw invalidData()
    return { id, time: trade.time, quantity: trade.qty, quote: number(trade.quoteQty, true), price: number(trade.price, true),
      realized: futures ? number(trade.realizedPnl) : 0, realizedAsset, fee: number(trade.commission), feeAsset: trade.commissionAsset }
  })
}

async function reconcile(env, db, row) {
  const user = getTradingUserById(env, row.userId)
  const credentials = row.market === 'spot'
    ? { apiKey: user?.spotApiKey, apiSecret: user?.spotApiSecret }
    : { apiKey: user?.apiKey, apiSecret: user?.apiSecret }
  if (!credentials.apiKey || !credentials.apiSecret || ledgerIdentity(user.id, credentials.apiKey) !== row.keyIdentity) {
    db.retry(row, Date.now() + 3_600_000)
    return
  }
  const paths = endpoints[row.market]
  const base = paths[row.environment]
  if (!terminalOrder(row.status)) {
    const params = row.orderId ? { symbol: row.symbol, orderId: row.orderId } : { symbol: row.symbol, origClientOrderId: row.clientOrderId }
    const data = await binanceRequest(env, base, paths.order, { credentials, params })
    // Spot query-order responses omit avgPrice. Fill-level accounting uses the
    // trade list for both markets, including each fill's execution price.
    const receipt = orderResult(row.market === 'spot' ? { ...data, avgPrice: '0' } : data, row.symbol, row.clientOrderId)
    if (!db.acknowledge(row.environment, row.userId, row.market, credentials.apiKey, receipt, data.time, true, data.positionSide)) {
      throw invalidData()
    }
    row = db.latest(row)
  }
  const progress = db.fillProgress(row)
  let fills = []
  if (progress.units < units(row.executedQty)) {
    const fromId = progress.fromId
    const params = { symbol: row.symbol, orderId: row.orderId, fromId, limit: 1000 }
    const data = await binanceRequest(env, base, paths.trades, { credentials, params })
    fills = normalizedFills(data, row, fromId)
  }
  db.saveFills(row, fills, Date.now())
}

export function createPlatformSettlement(env) {
  let active
  let stopped = false
  let resumeAt = 0
  async function run() {
    const environment = getTradingEnvironment(env)
    if (!env.BINANCE_FUTURES_USERS && !env.orderStore.accounts.hasAccounts(environment)) return
    const db = env.orderStore.platform
    const owners = env.verifyConfiguredUser || !env.BINANCE_FUTURES_USERS ? {
      spot: env.orderStore.accounts.connectedOwners(environment, 'spot'),
      futures: env.orderStore.accounts.connectedOwners(environment, 'futures'),
    } : undefined
    for (const row of db.due(environment, Date.now(), owners)) {
      if (stopped) break
      try {
        await reconcile(env, db, row)
      } catch (error) {
        let deadline = Date.now() + Math.min(1_800_000, 15_000 * 2 ** Math.min(row.failures, 7))
        if (error instanceof ApiError && (error.status === 418 || error.status === 429)) {
          const header = error.headers?.['Retry-After']
          const requested = /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header)
          resumeAt = Math.max(Date.now() + 60_000, Number.isSafeInteger(requested) ? requested : 0)
          deadline = Math.max(resumeAt, deadline)
        }
        db.retry(row, deadline)
        if (resumeAt > Date.now()) break
      }
    }
  }
  function poll() {
    if (!active && !stopped && Date.now() >= resumeAt) {
      active = run().catch(error => console.warn('平台成交核对暂不可用', error?.code ?? error?.name))
        .finally(() => { active = undefined })
    }
    return active
  }
  const timer = setInterval(poll, 5000)
  timer.unref()
  return { poll, async close() { stopped = true; clearInterval(timer); await active } }
}
