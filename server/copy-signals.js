import { createHash } from 'node:crypto'
import { invalidData, isUsdtSymbol } from '../worker/trading.js'

export const copySignalHistory = 29 * 86_400_000
export const copySignalOverlap = 10_000

export function normalizeCopySignal(portfolioId, row) {
  const timestamp = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  const time = timestamp(row?.orderUpdateTime)
  const orderTime = timestamp(row?.orderTime)
  if (!Number.isSafeInteger(time)) throw invalidData()
  if (!isUsdtSymbol(row.symbol) || !['LONG', 'SHORT'].includes(row.positionSide) || !['BUY', 'SELL'].includes(row.side)
    || (row.status != null && row.status !== 'FILLED')) return
  if (!Number.isSafeInteger(orderTime)) throw invalidData()
  for (const value of [row.executedQty, row.avgPrice]) {
    if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(Number(value))) throw invalidData()
    if (Number(value) <= 0) return
  }
  // An update to quantity, price or fill time is still the same lead order.
  const key = row.orderId == null
    ? [portfolioId, row.symbol, row.positionSide, row.side, row.type, orderTime]
    : [portfolioId, row.symbol, String(row.orderId)]
  const id = createHash('sha256').update(JSON.stringify(key)).digest('hex')
  const opens = row.positionSide === 'LONG' ? row.side === 'BUY' : row.side === 'SELL'
  return { id, symbol: row.symbol, direction: row.positionSide, kind: opens ? 'open' : 'close', time }
}

export function createCopySignals(db) {
  const status = db.prepare(`SELECT start_time AS start, end_time AS end, recovered_at AS recoveredAt, error
    FROM copy_signal_samples WHERE portfolio_id = ?`)
  const fail = db.prepare(`INSERT INTO copy_signal_samples (portfolio_id, error) VALUES (?, ?)
    ON CONFLICT(portfolio_id) DO UPDATE SET error = excluded.error`)
  const completed = db.prepare(`INSERT INTO copy_signal_samples (portfolio_id, start_time, end_time, recovered_at, error)
    VALUES (?, ?, ?, ?, '') ON CONFLICT(portfolio_id) DO UPDATE SET start_time = excluded.start_time,
    end_time = excluded.end_time, recovered_at = excluded.recovered_at, error = ''`)
  const save = db.prepare(`INSERT INTO copy_signals (portfolio_id, id, time, symbol, direction, kind) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id, id) DO NOTHING`)
  const select = db.prepare(`SELECT id, time, symbol, direction, kind FROM copy_signals
    WHERE portfolio_id = ? AND time > ? AND time <= ? ORDER BY time, id`)
  const prune = db.prepare('DELETE FROM copy_signals WHERE time < ?')

  return {
    status: id => status.get(id),
    fail: (id, message) => fail.run(id, message),
    publish(id, start, end, signals, now) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const previous = status.get(id)
        const contiguous = previous?.end != null && start <= previous.end && end >= previous.start
        completed.run(id, contiguous ? Math.min(start, previous.start) : start,
          contiguous ? Math.max(end, previous.end) : end, previous?.error ? now : previous?.recoveredAt ?? 0)
        let changed = Boolean(previous?.error)
        for (const signal of signals) {
          if (save.run(id, signal.id, signal.time, signal.symbol, signal.direction, signal.kind).changes) changed = true
        }
        prune.run(now - copySignalHistory)
        db.exec('COMMIT')
        return changed
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    read(id, start, end) {
      db.exec('BEGIN')
      try {
        const sample = status.get(id)
        if (sample?.error || sample?.end == null || sample.start > start) return null
        const through = Math.min(sample.end, end)
        return through < start ? null : {
          through, recoveredAt: sample.recoveredAt, signals: select.all(id, start, through),
        }
      } finally {
        db.exec('COMMIT')
      }
    },
  }
}
