import { futuresBase, futuresPositions } from '../worker/futures.js'
import { decimal, scale, units } from '../worker/futures-sizing.js'
import { ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, invalidData,
  isDecimal, isPositiveDecimal, isValidLeverage, jsonResponse } from '../worker/trading.js'
import { ledgerIdentity } from './platform-store.js'

const day = 86_400_000
const week = 7 * day
const limit = 1000
const positionSides = ['BOTH', 'LONG', 'SHORT']
const fillId = /^\d{1,20}$/
const tradingSymbol = /^[\p{L}\p{Nd}][\p{L}\p{Nd}_-]{0,79}$/u
const settlementSuffix = /(USDT|USDC|BUSD|FDUSD)(?:_[A-Z0-9]+)?$/u
const assetCode = /^[A-Z0-9]{2,20}$/
const inFlight = new WeakMap()
const abs = value => value < 0n ? -value : value
const signedUnits = value => value.startsWith('-') ? -units(value.slice(1)) : units(value)
const signedDecimal = value => (value < 0n ? '-' : '') + decimal(abs(value))
const positionKey = ({ symbol, positionSide }) => symbol + '/' + positionSide

function historyChanged() {
  return new ApiError(409, 'POSITION_HISTORY_CHANGED', '查询期间合约仓位发生变化，请重新读取仓位历史。')
}

async function readRange(read, path, startTime, endTime, params = {}) {
  const rows = await read(path, { ...params, startTime, endTime, limit })
  if (!Array.isArray(rows) || rows.length > limit) throw invalidData()
  if (rows.length < limit) return rows
  if (startTime === endTime) {
    throw new ApiError(503, 'POSITION_HISTORY_INCOMPLETE', '币安返回的历史明细达到单次上限，暂时无法核实完整仓位历史。')
  }
  const midpoint = Math.floor((startTime + endTime) / 2)
  const older = await readRange(read, path, startTime, midpoint, params)
  return older.concat(await readRange(read, path, midpoint + 1, endTime, params))
}

function normalizeFills(rows, symbol, start, end) {
  const seen = new Set()
  const fills = []
  for (const row of rows) {
    if (row?.symbol !== symbol || !positionSides.includes(row.positionSide) || !['BUY', 'SELL'].includes(row.side)
      || typeof row.id !== 'string' || !fillId.test(row.id) || !Number.isSafeInteger(row.time)
      || row.time < start || row.time > end || !isPositiveDecimal(row.qty) || !isPositiveDecimal(row.price)
      || !isDecimal(row.realizedPnl) || seen.has(row.id)) throw invalidData()
    seen.add(row.id)
    fills.push({ ...row, sequence: BigInt(row.id) })
  }
  return fills.sort((a, b) => b.time - a.time || (b.sequence > a.sequence ? 1 : -1))
}

// Work backwards from the authenticated current quantity. A flat boundary or
// a one-way reversal proves a full close and separates successive positions.
function replayPositions(symbol, positions, cutoff) {
  const balances = new Map(positions.map(row => [row.positionSide, signedUnits(row.quantity)]))
  const tracing = new Map()
  const rows = []

  function finish(cycle) {
    const { entryValue, exitValue, quantity, pnl, ...position } = cycle
    rows.push({ ...position, closedQuantity: decimal(quantity),
      avgEntryPrice: decimal(entryValue / quantity), avgClosePrice: decimal(exitValue / quantity),
      realizedPnl: signedDecimal(pnl), entryNotional: Number(entryValue) / Number(scale * scale) })
  }

  return {
    consume(fills) {
      for (const fill of fills) {
        const { positionSide, side, time } = fill
        const quantity = units(fill.qty), price = units(fill.price)
        const after = balances.get(positionSide) ?? 0n
        const before = after - (side === 'BUY' ? quantity : -quantity)
        if ((positionSide === 'LONG' && (after < 0n || before < 0n))
          || (positionSide === 'SHORT' && (after > 0n || before > 0n))) throw historyChanged()
        balances.set(positionSide, before)

        const reduces = side === 'BUY' ? before < 0n : before > 0n
        const previousQuantity = abs(before)
        const closed = reduces ? (previousQuantity < quantity ? previousQuantity : quantity) : 0n
        const opened = quantity - closed
        const pnl = signedUnits(fill.realizedPnl)
        if (!closed && pnl !== 0n) throw historyChanged()
        let cycle = tracing.get(positionSide)
        if (opened && cycle) {
          cycle.entryValue += opened * price
          cycle.openedAt = time
          if (!before || closed) {
            finish(cycle)
            tracing.delete(positionSide)
            cycle = undefined
          }
        }
        if (!closed) continue
        if ((!after || opened) && time >= cutoff) {
          cycle = { id: symbol + '/' + fill.id, symbol, positionSide, direction: before > 0n ? 'LONG' : 'SHORT',
            openedAt: null, closedAt: time, asset: typeof fill.marginAsset === 'string' && assetCode.test(fill.marginAsset) ? fill.marginAsset
              : settlementSuffix.exec(symbol)?.[1] ?? null,
            quantity: 0n, entryValue: 0n, exitValue: 0n, pnl: 0n }
          tracing.set(positionSide, cycle)
        }
        if (!cycle) continue
        cycle.quantity += closed
        cycle.exitValue += closed * price
        cycle.pnl += pnl
      }
    },
    needsEarlierFills: () => tracing.size > 0,
    result() {
      // Keep the confirmed closing time visible when the opening falls beyond
      // Binance's available trade history. Quantities, prices and PnL may be partial.
      for (const { id, symbol, positionSide, direction, closedAt, asset } of tracing.values()) {
        rows.push({ id, symbol, positionSide, direction, closedAt, asset, openedAt: null, closedQuantity: null,
          avgEntryPrice: null, avgClosePrice: null, realizedPnl: null })
      }
      return rows
    },
  }
}

async function loadHistory(env, user, environment, asOf = Date.now()) {
  const cutoff = asOf - week
  // Binance exposes three months via userTrades. Stay inside its calendar window.
  const earliest = asOf - 89 * day
  const read = (path, params) => binanceRequest(env, futuresBase, path, { credentials: user, params })
  const positions = async () => futuresPositions(await read('/fapi/v3/positionRisk')).filter(row => settlementSuffix.test(row.symbol))
  const [current, orders, income] = await Promise.all([
    positions(),
    readRange(read, '/fapi/v1/allOrders', cutoff, asOf - 1),
    readRange(read, '/fapi/v1/income', cutoff, asOf),
  ])
  if (current.some(row => row.updateTime > asOf)) throw historyChanged()
  const bySymbol = new Map()
  for (const row of current) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, [])
    bySymbol.get(row.symbol).push(row)
  }
  const symbols = new Set(bySymbol.keys())
  for (const row of orders) {
    if (!tradingSymbol.test(row?.symbol ?? '') || !isDecimal(row.executedQty)) throw invalidData()
    if (settlementSuffix.test(row.symbol) && signedUnits(row.executedQty) > 0n) symbols.add(row.symbol)
  }
  // Account orders find filled symbols, including break-even trades. The
  // income ledger also catches executions on orders created before the window.
  for (const row of income) {
    if (typeof row?.symbol !== 'string' || (row.symbol && !tradingSymbol.test(row.symbol))) throw invalidData()
    if (settlementSuffix.test(row.symbol) && ['COMMISSION', 'REALIZED_PNL'].includes(row.incomeType)) symbols.add(row.symbol)
  }

  const pending = [...symbols].values()
  const rows = []
  let failure
  async function collect() {
    try {
      for (const symbol of pending) {
        if (failure) return
        const replay = replayPositions(symbol, bySymbol.get(symbol) ?? [], cutoff)
        let end = asOf
        let start = cutoff
        for (;;) {
          const trades = await readRange(read, '/fapi/v1/userTrades', start, end, { symbol })
          replay.consume(normalizeFills(trades, symbol, start, end))
          if (!replay.needsEarlierFills() || start === earliest || failure) break
          end = start - 1
          start = Math.max(earliest, end - week + 1)
        }
        rows.push(...replay.result())
      }
    } catch (error) {
      failure ??= error
    }
  }
  await Promise.all(Array.from({ length: Math.min(symbols.size, 4) }, collect))
  if (failure) throw failure
  const snapshot = data => JSON.stringify(data.map(p => [positionKey(p), p.quantity, p.updateTime]).sort())
  const [latest, config] = await Promise.all([
    positions(),
    rows.some(row => row.openedAt !== null) ? read('/fapi/v1/symbolConfig').catch(() => []) : [],
  ])
  if (snapshot(current) !== snapshot(latest)) throw historyChanged()
  const leverageBySymbol = new Map()
  if (Array.isArray(config)) {
    for (const row of config) {
      if (symbols.has(row?.symbol) && isValidLeverage(row.leverage)) leverageBySymbol.set(row.symbol, row.leverage)
    }
  }
  rows.sort((a, b) => b.closedAt - a.closedAt || a.id.localeCompare(b.id))
  return { environment, asOf, rows: rows.map(({ entryNotional, ...row }) => {
    // The venue exposes current leverage, while userTrades omits the leverage at entry.
    const leverage = leverageBySymbol.get(row.symbol)
    const rate = entryNotional > 0 && leverage ? Number(row.realizedPnl) * leverage / entryNotional : null
    const roi = rate !== null && Number.isFinite(rate * 100) ? rate : null
    return { ...row, roi, roiLeverage: roi === null ? null : leverage }
  }) }
}

export async function futuresPositionHistory(request, env) {
  try {
    if (request.method !== 'GET') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET' })
    const user = await getTradingUser(request, env)
    if (!user.apiKey || !user.apiSecret || (user.markets && !user.markets.includes('futures'))) {
      throw new ApiError(403, 'FUTURES_NOT_CONFIGURED', '请绑定具有合约读取权限的币安密钥。')
    }
    const environment = getTradingEnvironment(env)
    const key = ledgerIdentity(user.id, user.apiKey)
    if (!inFlight.has(env)) inFlight.set(env, new Map())
    const requests = inFlight.get(env)
    if (!requests.has(key)) requests.set(key, loadHistory(env, user, environment).finally(() => requests.delete(key)))
    return jsonResponse(await requests.get(key))
  } catch (error) { return apiErrorResponse(error) }
}
