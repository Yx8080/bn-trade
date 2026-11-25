import worker from '../worker/index.js'
import { ApiError } from '../worker/trading.js'

function numberOrNull(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const disclosureFields = ['asset', 'opened', 'avgCost', 'avgClosePrice', 'closedVolume', 'closingPnl', 'roi']
const missing = value => value == null || (typeof value === 'string' && !value.trim())
const sameMarket = (position, trade) => position.symbol === trade.symbol && position.side.toUpperCase() === trade.positionSide

export function createObservedPositions(db) {
  const byId = db.prepare('SELECT payload FROM observed_positions WHERE portfolio_id=? AND position_id=?')
  const byTime = db.prepare('SELECT payload FROM observed_positions WHERE portfolio_id=? AND closed_at=?')
  const insert = db.prepare('INSERT INTO observed_positions(portfolio_id,position_id,closed_at,payload) VALUES (?,?,?,?)')
  const update = db.prepare('UPDATE observed_positions SET payload=? WHERE portfolio_id=? AND position_id=?')
  const count = db.prepare('SELECT count(*) AS total FROM observed_positions WHERE portfolio_id=?')
  const page = db.prepare(`SELECT payload FROM observed_positions WHERE portfolio_id=?
    ORDER BY closed_at DESC,position_id DESC LIMIT ? OFFSET ?`)
  return {
    pending(portfolioId, trades) {
      const pending = []
      for (const trade of trades) {
        const candidates = trade.positionId ? [byId.get(portfolioId, trade.positionId)].filter(Boolean)
          : byTime.all(portfolioId, trade.orderUpdateTime)
        const matches = candidates.map(row => JSON.parse(row.payload)).filter(row => sameMarket(row, trade))
        if (matches.length > 1) continue
        const archived = matches[0]
        if (!archived || disclosureFields.some(field => missing(archived[field]))) pending.push({ trade, archived })
      }
      return pending
    },
    record(portfolioId, positions) {
      if (!positions.length) return 0
      let changes = 0
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of positions) {
          const prior = byId.get(portfolioId, row.positionId)
          if (!prior) {
            insert.run(portfolioId, row.positionId, row.closed, JSON.stringify(row))
            changes++
            continue
          }
          const archived = JSON.parse(prior.payload)
          if (archived.closed !== row.closed || archived.symbol !== row.symbol
            || archived.side.toUpperCase() !== row.side.toUpperCase()) continue
          const fields = disclosureFields.filter(field => missing(archived[field]) && !missing(row[field]))
          if (!fields.length) continue
          for (const field of fields) archived[field] = row[field]
          update.run(JSON.stringify(archived), portfolioId, row.positionId)
          changes++
        }
        db.exec('COMMIT')
        return changes
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    page(portfolioId, pageNumber, pageSize) {
      if (typeof portfolioId !== 'string' || !/^\d{1,30}$/.test(portfolioId)
        || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isSafeInteger(pageSize)
        || pageSize < 1 || pageSize > 50 || !Number.isSafeInteger((pageNumber - 1) * pageSize)) {
        throw new ApiError(400, 'INVALID_POSITION_QUERY', '组合或分页参数无效。')
      }
      return { rows: page.all(portfolioId, pageSize, (pageNumber - 1) * pageSize).map(row => JSON.parse(row.payload)),
        total: count.get(portfolioId).total, pageSize }
    },
  }
}

// One latest snapshot in response to a newly observed close. A partial close
// may have no completed position. No other pages or later retries are needed.
export async function observeClosedPositions(env, getStore, portfolioId, { startTime, endTime, isCurrent, signal, rows }) {
  if (!isCurrent() || signal?.aborted) return 0
  const currentTrades = rows.filter(row => Number.isSafeInteger(row.orderUpdateTime)
    && row.orderUpdateTime >= startTime && row.orderUpdateTime <= endTime)
  if (!currentTrades.length) return 0
  const store = getStore()
  const pending = store.pending(portfolioId, currentTrades)
  if (!pending.length) return 0
  const request = new Request('http://localhost/api/binance/position-history', { method: 'POST', signal,
    body: JSON.stringify({ portfolioId, pageNumber: 1, pageSize: 50 }) })
  const response = await worker.fetch(request, env)
  if (!isCurrent() || signal?.aborted) return 0
  if (!response.ok) {
    const failure = new ApiError(response.status, 'POSITION_DISCLOSURE_UNAVAILABLE', '暂时无法读取最新平仓披露。')
    const retry = response.headers.get('Retry-After')
    if (retry) failure.headers = { 'Retry-After': retry }
    throw failure
  }
  const payload = JSON.parse(await response.text(), (key, value, context) =>
    key === 'positionId' && typeof value === 'number' ? context.source : value)
  if (payload?.code !== '000000' || payload.success === false || !Array.isArray(payload.data?.list)) {
    throw new ApiError(502, 'INVALID_POSITION_DISCLOSURE', '币安暂未返回完整的平仓披露。')
  }
  const disclosures = []
  for (const row of payload.data.list) {
    const closed = numberOrNull(row?.closed)
    if (row?.status !== 'All Closed' || typeof row.positionId !== 'string' || !row.positionId
      || !Number.isSafeInteger(closed) || closed < 0 || closed > endTime
      || typeof row.symbol !== 'string' || typeof row.side !== 'string') continue
    const asset = typeof row.marginAsset === 'string' ? row.marginAsset : row.type === 'UM' ? row.symbol.match(/(USDT|USDC)$/)?.[1] : ''
    disclosures.push({ positionId: row.positionId, symbol: row.symbol, side: row.side, asset: asset ?? '', closed,
      opened: numberOrNull(row.opened), avgCost: numberOrNull(row.avgCost), avgClosePrice: numberOrNull(row.avgClosePrice),
      closedVolume: numberOrNull(row.closedVolume), closingPnl: numberOrNull(row.closingPnl), roi: numberOrNull(row.roi) })
  }
  const positions = new Map()
  for (const { trade, archived } of pending) {
    const matches = disclosures.filter(row => sameMarket(row, trade) && (trade.positionId
      ? row.positionId === trade.positionId && (row.closed >= startTime || archived?.closed === row.closed)
      : row.closed === trade.orderUpdateTime))
    if (!matches.length || matches.some(row => row.positionId !== matches[0].positionId)) continue
    // A timestamp match must also agree with any already archived identity.
    if (archived && archived.positionId !== matches[0].positionId) continue
    positions.set(matches[0].positionId, matches[0])
  }
  if (!isCurrent() || signal?.aborted) return 0
  return store.record(portfolioId, [...positions.values()])
}
