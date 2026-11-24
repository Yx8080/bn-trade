export interface PendingOrder {
  symbol: string
  clientOrderId: string
}

const memory = new Map<string, PendingOrder>()

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
