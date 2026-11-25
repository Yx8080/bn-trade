import type { BoundSession, Environment } from '../futures'

export interface PendingOrder {
  symbol: string
  clientOrderId: string
}

const memory = new Map<string, PendingOrder>()

export const pendingOrderKey = (owner: string | undefined, environment: Environment, market: 'futures' | 'spot' | 'futures-close') =>
  'bn-trade:pending:' + JSON.stringify([owner, environment, market])

export function restorePreviousPending(session: BoundSession) {
  if (!session.previousWorkspaceId || session.environment !== 'live') return
  const scopes = [...session.markets, ...(session.markets.includes('futures') ? ['futures-close' as const] : [])]
  for (const market of scopes) {
    const key = pendingOrderKey(session.id, session.environment, market)
    const previousKey = pendingOrderKey(session.previousWorkspaceId, session.environment, market)
    const previous = readPending(previousKey)
    if (!previous || readPending(key)) continue
    try {
      sessionStorage.setItem(key, JSON.stringify(previous))
      writePending(previousKey, null)
    } catch { /* Keep the original pending order if storage is full. */ }
    memory.set(key, previous)
  }
}

export function readPending(key: string): PendingOrder | null {
  if (memory.has(key)) return memory.get(key)!
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null')
    return value && typeof value.symbol === 'string' && typeof value.clientOrderId === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

export function writePending(key: string, value: PendingOrder | null) {
  if (value) memory.set(key, value)
  else memory.delete(key)
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {
    /* The in-memory copy survives view changes within this page. */
  }
}
