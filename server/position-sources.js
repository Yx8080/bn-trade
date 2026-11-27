import { futuresBase, futuresPositions } from '../worker/futures.js'
import { units } from '../worker/futures-sizing.js'
import { ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, invalidData, jsonResponse } from '../worker/trading.js'
import { classifyFuturesFills } from './other-trades.js'
import { manualPositionBasis } from './platform-pnl.js'
import { ledgerIdentity } from './platform-store.js'

const magnitude = value => value < 0n ? -value : value
const smaller = (a, b) => a < b ? a : b
const unmatched = () => ({ sources: [], complete: false, manualOnly: false })
const fillKinds = { manual: 'manual', copy: 'copy', untracked: 'external', unverified: 'unknown' }

// A net position has no lot IDs. Reductions can consume any contributor. Keep
// lower and upper bounds so a source is named only when some of its units must remain.
export function tracePosition(position, fills) {
  const short = String(position.quantity).startsWith('-')
  const direction = short ? 'SHORT' : 'LONG'
  let exposure = units(String(position.quantity).replace(/^-/, ''))
  const leg = fills.filter(fill => fill.symbol === position.symbol && fill.positionSide === position.positionSide)
  if (!exposure || !leg.length || !Number.isSafeInteger(position.updateTime) || leg[0].time !== position.updateTime
    || (position.positionSide === 'SHORT' && !short) || (position.positionSide === 'LONG' && short)) return unmatched()

  // Work backwards from the observed quantity to the last flat position or reversal.
  const changes = []
  for (const fill of leg) {
    const grows = (fill.side === 'BUY') !== short
    const quantity = units(fill.quantity)
    if (!quantity) return unmatched()
    if (grows && quantity > exposure && position.positionSide !== 'BOTH') return unmatched()
    const delta = grows ? smaller(quantity, exposure) : -quantity
    changes.push({ delta, fill })
    exposure -= delta
    if (!exposure) break
  }

  const lots = new Map()
  const add = (kind, portfolioId, amount, verifiedCopyOpen = false) => {
    const key = kind + '/' + (portfolioId ?? '')
    const lot = lots.get(key) ?? { source: portfolioId ? { kind, portfolioId } : { kind }, min: 0n, max: 0n, copyMin: 0n }
    lot.min += amount
    lot.max += amount
    if (verifiedCopyOpen) lot.copyMin += amount
    lots.set(key, lot)
  }
  const anchored = exposure === 0n
  if (!anchored) add('unknown', null, exposure)
  let basis = 0
  for (const { delta, fill } of changes.reverse()) {
    const after = exposure + delta
    if (delta > 0n) {
      let kind = fillKinds[fill.source] ?? 'unknown'
      const verifiedCopyOpen = kind === 'copy' && fill.portfolioId &&
        fill.copyKind === 'open' && fill.copyDirection === direction
      if (kind === 'copy' && (!fill.portfolioId || (fill.copyKind && !verifiedCopyOpen))) kind = 'unknown'
      add(kind, kind === 'copy' ? fill.portfolioId : null, delta, verifiedCopyOpen)
      if (anchored) basis += (Number(fill.price) - basis) * (Number(delta) / Number(after))
    } else {
      // Only a journaled close can target a portfolio's verified copy quantity.
      const copyLot = fill.source === 'copy' && fill.portfolioId && fill.copyKind === 'close' &&
        fill.copyDirection === direction ? lots.get('copy/' + fill.portfolioId) : null
      const targeted = copyLot && copyLot.copyMin >= -delta
      for (const lot of lots.values()) {
        if (!targeted || lot === copyLot) {
          lot.min = lot.min + delta > 0n ? lot.min + delta : 0n
          lot.copyMin = lot.copyMin + delta > 0n ? lot.copyMin + delta : 0n
        }
        if (targeted && lot === copyLot) lot.max += delta
        lot.max = smaller(lot.max, after)
      }
    }
    exposure = after
  }
  // The reconstructed entry must also agree. A missing fill or an exchange-side
  // adjustment can otherwise yield the same net quantity with a different basis.
  const entry = Number(position.entryPrice)
  const tolerance = Math.max(entry * 1e-10, Math.min(5e-9, entry * 1e-6))
  if (anchored && (!Number.isFinite(entry) || !Number.isFinite(basis) || entry <= 0 || Math.abs(basis - entry) > tolerance)) return unmatched()

  const active = [...lots.values()].filter(lot => lot.max > 0n)
  const complete = anchored && active.every(lot => lot.min > 0n && lot.source.kind !== 'unknown')
  return { sources: active.filter(lot => lot.min > 0n).map(lot => lot.source), complete,
    manualOnly: complete && active.length === 1 && active[0].source.kind === 'manual' }
}

async function readTrades(env, user, symbol, params) {
  const rows = await binanceRequest(env, futuresBase, '/fapi/v1/userTrades', {
    credentials: user, params: { symbol, limit: 1000, ...params },
  })
  if (!Array.isArray(rows) || rows.length > 1000) throw invalidData()
  return rows
}

function manualAnchorReader(env, user, environment) {
  let basis
  return (symbol, legs) => {
    const store = env.orderStore.platform
    if (typeof store?.futuresFills !== 'function') return null
    basis ??= manualPositionBasis(store.futuresFills(environment, user.id, { futures: ledgerIdentity(user.id, user.apiKey), spot: null }))
    const sides = new Set(legs.map(leg => leg.positionSide))
    const ids = basis.filter(p => p.symbol === symbol && sides.has(p.positionSide)).map(p => BigInt(p.firstTradeId))
    return ids.length ? String(ids.reduce(smaller)) : null
  }
}

async function resolveLegs(env, user, environment, legs, manualAnchor) {
  const symbol = legs[0].symbol
  const updatedAt = Math.max(...legs.map(p => p.updateTime))
  const params = updatedAt > 0 && Date.now() - updatedAt >= 7 * 86_400_000 ? { endTime: updatedAt } : {}
  const recent = await classifyFuturesFills(env, user, environment, symbol, await readTrades(env, user, symbol, params))
  const results = legs.map(p => tracePosition(p, recent))
  if (results.every(r => r.complete)) return results

  // A manual base can predate the recent exchange window. Its recorded first
  // fill is a cursor, never proof of ownership. Replay the authenticated fills
  // from there only if they span the position snapshot without a gap.
  const first = manualAnchor(symbol, legs.filter((_, i) => !results[i].complete))
  if (!first || (recent.length && BigInt(first) >= BigInt(recent.at(-1).id))) return results
  let cursor = BigInt(first)
  const history = []
  for (let page = 0; page < 3; page++) {
    const rows = await readTrades(env, user, symbol, { fromId: String(cursor) })
    if (rows.some(row => !/^\d{1,20}$/.test(row?.id) || BigInt(row.id) < cursor)) throw invalidData()
    history.push(...rows)
    if (rows.length < 1000 || (recent.length && rows.some(row => row.id === recent[0].id))) {
      if (!history.some(row => row.id === first) || (recent.length && !history.some(row => row.id === recent[0].id))) return results
      const verified = await classifyFuturesFills(env, user, environment, symbol, history)
      return legs.map((p, i) => results[i].complete ? results[i] : tracePosition(p, verified))
    }
    cursor = rows.reduce((max, row) => BigInt(row.id) > max ? BigInt(row.id) : max, cursor) + 1n
  }
  return results
}

export async function isPlatformManualPosition(env, user, environment, actual) {
  if (!actual || !['LONG', 'SHORT'].includes(actual.direction) || !(actual.quantity > 0) || !(actual.updateTime > 0)) return false
  const amount = String(actual.quantityText ?? actual.quantity).replace(/^-/, '')
  const position = { symbol: actual.symbol, positionSide: actual.positionSide ?? 'BOTH', quantity: actual.direction === 'SHORT' ? '-' + amount : amount,
    entryPrice: actual.entryPriceText ?? actual.entryPrice, updateTime: actual.updateTime }
  const [result] = await resolveLegs(env, user, environment, [position], manualAnchorReader(env, user, environment))
  return result.manualOnly
}

export async function positionSources(request, env) {
  try {
    if (request.method !== 'GET') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET' })
    const user = await getTradingUser(request, env)
    if (!user.apiKey || !user.apiSecret) throw new ApiError(503, 'FUTURES_NOT_CONFIGURED', '当前账户尚未配置合约密钥。')
    const environment = getTradingEnvironment(env)
    const risk = await binanceRequest(env, futuresBase, '/fapi/v3/positionRisk', { credentials: user })
    const positions = futuresPositions(risk).map(({ symbol, positionSide, quantity, entryPrice, updateTime }) =>
      ({ symbol, positionSide, quantity, entryPrice, updateTime, sources: [], complete: false }))
    const symbols = [...new Set(positions.map(p => p.symbol))]
    const manualAnchor = manualAnchorReader(env, user, environment)
    let next = 0
    let limited = false
    async function load() {
      while (!limited && next < symbols.length) {
        const symbol = symbols[next++]
        try {
          const legs = positions.filter(p => p.symbol === symbol)
          const matches = await resolveLegs(env, user, environment, legs, manualAnchor)
          legs.forEach((row, i) => Object.assign(row, { sources: matches[i].sources, complete: matches[i].complete }))
        } catch (error) {
          if (error.status === 429 || error.status === 418) limited = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, load))
    return jsonResponse({ environment, positions })
  } catch (error) { return apiErrorResponse(error) }
}
