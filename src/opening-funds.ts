import type { FuturesAccount } from './futures'

export interface OpeningFunds {
  state: 'disconnected' | 'loading' | 'ready' | 'error'
  available: number | null
  updatedAt: number
}

export function availableUsdt(balances: FuturesAccount['balances']): number | null {
  const raw = balances.find(row => row.asset === 'USDT')?.availableBalance
  if (typeof raw !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(raw)) return null
  const available = Number(raw)
  return Number.isFinite(available) ? available : null
}

// Binance USDT balances and both amount fields support eight decimal places.
export function amountFromBalance(available: number, percent: number): number {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return 0
  let units = Math.round(available * 1e8)
  if (!Number.isSafeInteger(units) || units <= 0) return 0
  if (units / 1e8 > available) units--
  return Number(BigInt(units) * BigInt(percent) / 100n) / 1e8
}
