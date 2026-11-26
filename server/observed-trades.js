import { createHash } from 'node:crypto'
import { ApiError } from '../worker/trading.js'

const portfolioIdValid = id => typeof id === 'string' && /^\d{1,30}$/.test(id)
const validTime = time => Number.isSafeInteger(time) && time >= 0
const validWindow = (start, end) => validTime(start) && validTime(end) && start <= end
const badQuery = () => new ApiError(400, 'INVALID_OBSERVED_QUERY', '请输入有效的组合、日期范围和每页条数。')
const badCursor = () => new ApiError(400, 'INVALID_OBSERVED_CURSOR', '本地成交记录的分页游标无效，请重新查询。')
const badPage = () => new ApiError(502, 'INVALID_OBSERVED_SAMPLE', '币安返回的公开成交记录格式有误。')
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const weightFields = ['executedQty', 'avgPrice', 'quoteQuantity', 'totalPnl']

function normalize(row, updatedAt) {
  if (typeof row.symbol !== 'string' || !row.symbol.length || typeof row.side !== 'string') throw badPage()
  const data = { symbol: row.symbol, side: row.side }
  // Keep only fields published in the public leader order feed.
  for (const field of ['baseAsset', 'quoteAsset', 'type', 'positionSide', 'status']) {
    if (typeof row[field] === 'string') data[field] = row[field]
  }
  for (const field of ['orderId', 'positionId']) {
    const id = row[field]
    if (id == null || id === '') continue
    if (typeof id !== 'string' && !Number.isSafeInteger(id)) throw badPage()
    data[field] = String(id)
  }
  for (const field of weightFields) {
    const value = row[field]
    if (value == null || value === '') { data[field] = null; continue }
    if (typeof value !== 'number' && (typeof value !== 'string' || !decimal.test(value.trim()))) throw badPage()
    data[field] = Number(value)
    if (!Number.isFinite(data[field])) throw badPage()
  }
  data.orderTime = row.orderTime == null || row.orderTime === '' ? null : timeOf(row.orderTime)
  data.orderUpdateTime = updatedAt
  return data
}

function timeOf(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  if (!validTime(value)) throw badPage()
  return value
}

// Price strings can carry more significant digits than a JavaScript number.
// Canonicalize the source digits for identity, including equivalent exponents.
function exactAmount(value) {
  if (value == null || value === '') return null
  const [coefficient, exponent = '0'] = String(value).trim().toLowerCase().split('e')
  const [integer, fraction = ''] = coefficient.replace(/^[+-]/, '').split('.')
  const digits = (integer + fraction).replace(/^0+/, '')
  if (!digits) return '0'
  const significant = digits.replace(/0+$/, '')
  const power = Number(exponent) - fraction.length + digits.length - significant.length
  return (coefficient.startsWith('-') ? '-' : '') + significant + 'e' + power
}

function decodeCursor(value, portfolioId, startTime, endTime, latest) {
  if (typeof value !== 'string' || !value.length || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw badCursor()
  let decoded
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) }
  catch { throw badCursor() }
  if (!Array.isArray(decoded) || decoded.length !== 6) throw badCursor()
  const [id, start, end, snapshot, time, revision] = decoded
  if (id !== portfolioId || start !== startTime || end !== endTime || !validTime(snapshot) || snapshot > latest
    || !validTime(time) || time < start || time > end || !Number.isSafeInteger(revision) || revision < 1 || revision > snapshot) throw badCursor()
  return { snapshot, time, revision }
}

export function createObservedTrades(db) {
  const latest = db.prepare('SELECT coalesce(max(revision),0) AS snapshot FROM observed_trades')
  const find = db.prepare(`SELECT revision, updated_at AS time, payload FROM observed_trades
    WHERE portfolio_id=? AND trade_key=? AND superseded_at_revision IS NULL`)
  const insert = db.prepare('INSERT INTO observed_trades(portfolio_id, trade_key, updated_at, payload) VALUES (?,?,?,?)')
  const supersede = db.prepare('UPDATE observed_trades SET superseded_at_revision=? WHERE revision=?')
  const scope = `FROM observed_trades WHERE portfolio_id=:portfolioId AND updated_at BETWEEN :startTime AND :endTime
    AND revision<=:snapshot AND (superseded_at_revision IS NULL OR superseded_at_revision>:snapshot)`
  const count = db.prepare('SELECT count(*) AS total ' + scope)
  const fields = 'SELECT trade_key AS observedId, revision, updated_at AS time, payload '
  const order = ' ORDER BY updated_at DESC, revision DESC LIMIT :limit'
  const firstPage = db.prepare(fields + scope + order)
  const nextPage = db.prepare(fields + scope + ' AND (updated_at,revision)<(:time,:revision)' + order)
  return {
    record(portfolioId, { startTime, endTime, rows }) {
      if (!portfolioIdValid(portfolioId) || !validWindow(startTime, endTime) || !Array.isArray(rows)) throw badQuery()
      const occurrences = new Map()
      const changed = new Map()
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) {
          const time = timeOf(row?.orderUpdateTime)
          if (time < startTime || time > endTime) continue
          let data = normalize(row, time)
          if (!(data.executedQty > 0) || !['BUY', 'SELL'].includes(data.side)
            || !['LONG', 'SHORT'].includes(data.positionSide)) continue
          let identity
          if (data.orderId != null) {
            identity = ['order', data.symbol, data.orderId]
          } else {
            // Without an exchange order ID, a timestamp alone collapses real
            // fills. Preserve every distinct tuple and its within-sample count.
            const parts = [data.symbol, data.side, data.positionSide, data.type, data.orderTime,
              time, ...weightFields.map(field => exactAmount(row[field]))]
            if (data.positionId != null) parts.push(data.positionId)
            const tuple = JSON.stringify(parts)
            const occurrence = occurrences.get(tuple) ?? 0
            occurrences.set(tuple, occurrence + 1)
            identity = ['row', tuple, occurrence]
          }
          const key = createHash('sha256').update(JSON.stringify([portfolioId, ...identity])).digest('hex')
          const prior = find.get(portfolioId, key)
          if (prior?.time > time) continue
          if (prior && data.orderId != null) {
            const previous = JSON.parse(prior.payload)
            if (prior.time === time && previous.executedQty > data.executedQty) continue
            const merged = { ...previous, ...data }
            merged.orderTime ??= previous.orderTime
            // Amounts on the older snapshot apply to its cumulative fill size.
            if (previous.executedQty === data.executedQty) {
              for (const field of weightFields) merged[field] ??= previous[field]
            }
            data = merged
          }
          const payload = JSON.stringify(data)
          if (prior?.payload === payload) continue
          const { lastInsertRowid } = insert.run(portfolioId, key, time, payload)
          if (prior) supersede.run(lastInsertRowid, prior.revision)
          changed.set(key, { ...data, observedId: key })
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return [...changed.values()]
    },

    page({ portfolioId, startTime, endTime, pageSize = 10, cursor }) {
      if (!portfolioIdValid(portfolioId) || !validWindow(startTime, endTime)
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw badQuery()
      const { snapshot: current } = latest.get()
      const boundary = cursor == null ? null : decodeCursor(cursor, portfolioId, startTime, endTime, current)
      const snapshot = boundary?.snapshot ?? current
      const query = { portfolioId, startTime, endTime, snapshot }
      const { total } = count.get(query)
      const limit = pageSize + 1
      const rows = boundary ? nextPage.all({ ...query, ...boundary, limit }) : firstPage.all({ ...query, limit })
      const more = rows.length > pageSize
      if (more) rows.pop()
      const list = rows.map(row => ({ ...JSON.parse(row.payload), observedId: row.observedId }))
      if (!more) return { list, total }
      const last = rows.at(-1)
      const next = JSON.stringify([portfolioId, startTime, endTime, snapshot, last.time, last.revision])
      return { list, total, cursor: Buffer.from(next).toString('base64url') }
    },
  }
}
