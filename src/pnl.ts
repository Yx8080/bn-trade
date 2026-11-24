import type { Trade } from './trades'

type PositionSide = 'LONG' | 'SHORT'

/** Gross price PnL for a linear contract, using an unsigned quantity in base units. */
export function linearPnl(side: PositionSide, entryPrice: number, markPrice: number, quantity: number): number | null {
  if ((side !== 'LONG' && side !== 'SHORT')
    || ![entryPrice, markPrice, quantity].every(value => Number.isFinite(value) && value > 0)) return null
  const change = side === 'LONG' ? markPrice - entryPrice : entryPrice - markPrice
  const pnl = change * quantity
  return Number.isFinite(pnl) ? pnl : null
}

export function reportedPnl(trade: Trade): number | null {
  const closing = (trade.positionSide === 'LONG' && trade.side === 'SELL')
    || (trade.positionSide === 'SHORT' && trade.side === 'BUY')
  if (!closing || !(trade.executedQty != null && trade.executedQty > 0)) return null
  return trade.totalPnl != null && Number.isFinite(trade.totalPnl) ? trade.totalPnl : null
}

export function summarizeReportedPnl(trades: readonly Trade[]) {
  const totals = new Map<string, { asset: string; pnl: number; count: number }>()
  for (const trade of trades) {
    const asset = trade.quoteAsset?.trim()
    const pnl = reportedPnl(trade)
    if (!asset || pnl === null) continue
    const entry = totals.get(asset) ?? { asset, pnl: 0, count: 0 }
    entry.pnl += pnl
    entry.count++
    totals.set(asset, entry)
  }
  return [...totals.values()].sort((a, b) => a.asset.localeCompare(b.asset))
}
