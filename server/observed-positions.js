import { ApiError } from '../worker/trading.js'
import { exactAmount } from './observed-trades.js'

// The shortest decimal representation of any finite Number fits this scale.
const scale = 324

function units(value) {
  if (value === 0) return 0n
  const [digits, exponent] = exactAmount(value).split('e')
  return BigInt(digits) * 10n ** BigInt(scale + Number(exponent))
}

function amount(value) {
  return Number(value.toString() + 'e-' + scale)
}

function sum(total, value) {
  return total == null || value == null ? null : total + value
}

function* closedPositions(trades) {
  const open = new Map()
  for (const { payload, observedId } of trades) {
    const trade = JSON.parse(payload)
    const { symbol, positionSide, positionId, orderUpdateTime, executedQty, avgPrice, quoteQuantity, totalPnl } = trade
    const key = symbol + ':' + positionSide
    const isOpening = positionSide === 'LONG' ? trade.side === 'BUY' : trade.side === 'SELL'
    const quantity = units(executedQty)
    const notional = avgPrice > 0 ? avgPrice * executedQty : quoteQuantity
    let cycle = open.get(key)
    if (cycle?.positionId && positionId && cycle.positionId !== positionId) {
      open.delete(key)
      cycle = undefined
    }
    if (isOpening) {
      cycle ??= { opened: orderUpdateTime, positionId, asset: '', remaining: 0n, volume: 0n,
        entryValue: 0, exitValue: 0, pnl: 0n }
      cycle.positionId ??= positionId
      cycle.asset ||= trade.quoteAsset || ''
      cycle.remaining += quantity
      cycle.volume += quantity
      cycle.entryValue = sum(cycle.entryValue, notional)
      open.set(key, cycle)
      continue
    }
    if (!cycle) continue
    cycle.positionId ??= positionId
    cycle.remaining -= quantity
    cycle.exitValue = sum(cycle.exitValue, notional)
    cycle.pnl = sum(cycle.pnl, totalPnl == null ? null : units(totalPnl))
    if (cycle.remaining > 0n) continue
    open.delete(key)
    // An excess close indicates a missing entry in the local trade history.
    if (cycle.remaining < 0n) continue
    const closedVolume = amount(cycle.volume)
    yield {
      positionId: observedId,
      symbol,
      side: positionSide === 'LONG' ? 'Long' : 'Short',
      asset: trade.quoteAsset || cycle.asset || symbol.match(/(USDT|USDC)$/)?.[1] || '',
      opened: cycle.opened,
      closed: orderUpdateTime,
      avgCost: cycle.entryValue == null ? null : cycle.entryValue / closedVolume,
      avgClosePrice: cycle.exitValue == null ? null : cycle.exitValue / closedVolume,
      closedVolume,
      closingPnl: cycle.pnl == null ? null : amount(cycle.pnl),
      roi: null,
    }
  }
}

export function createObservedPositions(db) {
  const trades = db.prepare(`
    SELECT trade_key AS observedId, payload FROM observed_trades
    WHERE portfolio_id=? AND superseded_at_revision IS NULL
    ORDER BY updated_at, coalesce(payload ->> '$.orderTime', updated_at), revision
  `)
  return {
    page(portfolioId, pageNumber, pageSize) {
      if (typeof portfolioId !== 'string' || !/^\d{1,30}$/.test(portfolioId)
        || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isSafeInteger(pageSize)
        || pageSize < 1 || pageSize > 50 || !Number.isSafeInteger((pageNumber - 1) * pageSize)) {
        throw new ApiError(400, 'INVALID_POSITION_QUERY', '组合或分页参数无效。')
      }
      const positions = [...closedPositions(trades.iterate(portfolioId))].reverse()
      const offset = (pageNumber - 1) * pageSize
      return { rows: positions.slice(offset, offset + pageSize), total: positions.length, pageSize }
    },
  }
}
