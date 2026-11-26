import { ApiError, binanceRequest, invalidData, isValidLeverage } from './trading.js'

const marketInfo = new WeakMap()
export const scale = 10n ** 18n

// Fixed-point arithmetic avoids rounding a market order up to the next lot.
export function units(value) {
  const parts = String(value).match(/^(\d{1,20})(?:\.(\d{1,18}))?(?:e([+-]?\d{1,2}))?$/i)
  if (!parts) throw invalidData()
  const fraction = parts[2] ?? ''
  const shift = 18 + Number(parts[3] ?? 0) - fraction.length
  const digits = BigInt(parts[1] + fraction)
  return shift < 0 ? digits / 10n ** BigInt(-shift) : digits * 10n ** BigInt(shift)
}

export function decimal(value) {
  const digits = value.toString().padStart(19, '0')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '')
}

// All results use the same fixed-point scale as prices and lot sizes. Defer
// division until the final step to avoid rounding up a fractional order.
export function sizedNotional(sizingMode, amount, leverage, equity) {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new ApiError(400, 'INVALID_ORDER_SIZE', '每次开仓金额或资金比例须大于零。')
  }
  const size = units(amount)
  if (sizingMode === 'notional') return size
  if (!isValidLeverage(leverage)) throw new ApiError(400, 'INVALID_LEVERAGE', '按保证金开仓需要有效的杠杆倍数。')
  if (sizingMode === 'margin') return size * BigInt(leverage)
  if (sizingMode !== 'equityPercent' || size > 100n * scale) {
    throw new ApiError(400, 'INVALID_ORDER_SIZE', '请检查金额模式和资金比例，比例须大于 0 且不超过 100%。')
  }
  if (!Number.isFinite(equity) || equity <= 0)
    throw new ApiError(409, 'FUTURES_EQUITY_UNAVAILABLE', '合约账户总权益无效或不大于零。')
  return units(equity) * size * BigInt(leverage) / (100n * scale)
}

function commonStep(first, second) {
  if (!first || !second) return first || second
  let a = first
  let b = second
  while (b) [a, b] = [b, a % b]
  return first / a * second
}

export async function getContract(env, base, symbol) {
  let cached = marketInfo.get(env)
  if (!cached || cached.base !== base || Date.now() >= cached.expiresAt) {
    const info = binanceRequest(env, base, '/fapi/v1/exchangeInfo').then(data => {
      if (!Array.isArray(data.symbols)) throw invalidData()
      return new Map(data.symbols.map(market => [market.symbol, market]))
    })
    cached = { base, info, expiresAt: Date.now() + 60_000 }
    marketInfo.set(env, cached)
    info.catch(() => { if (marketInfo.get(env) === cached) marketInfo.delete(env) })
  }
  return (await cached.info).get(symbol)
}

function lotRules(market, type) {
  if (!Array.isArray(market.filters)) throw invalidData()
  const filters = new Map(market.filters.map(filter => [filter.filterType, filter]))
  const lot = filters.get('LOT_SIZE')
  const marketLot = type === 'MARKET' ? filters.get('MARKET_LOT_SIZE') : lot
  if (!lot || !marketLot) throw invalidData()
  const step = commonStep(units(lot.stepSize), units(marketLot.stepSize))
  if (!step) throw invalidData()
  return { step, lots: type === 'MARKET' ? [lot, marketLot] : [lot] }
}

export async function symbolRules(env, base, symbol, type = 'MARKET') {
  const market = await getContract(env, base, symbol)
  if (!market || market.status !== 'TRADING' || market.quoteAsset !== 'USDT' || !market.orderTypes?.includes(type)) {
    throw new ApiError(409, 'COPY_MARKET_UNAVAILABLE', '该 USDT 合约当前不支持所选订单类型。')
  }
  const rules = lotRules(market, type)
  return { ...rules, minNotional: units(market.filters.find(filter => filter.filterType === 'MIN_NOTIONAL')?.notional) }
}

export async function closeLotRules(env, base, symbol) {
  const market = await getContract(env, base, symbol)
  if (market?.status !== 'TRADING' || !market.orderTypes?.includes('MARKET'))
    throw new ApiError(409, 'CLOSE_MARKET_UNAVAILABLE', '此合约当前无法市价平仓。')
  if (typeof market.baseAsset !== 'string' || !market.baseAsset) throw invalidData()
  const { step, lots } = lotRules(market, 'MARKET')
  let min = 0n
  let max = 0n
  for (const lot of lots) {
    const lower = units(lot.minQty)
    const upper = units(lot.maxQty)
    if (lower > min) min = lower
    if (upper && (!max || upper < max)) max = upper
  }
  return { baseAsset: market.baseAsset, stepSize: decimal(step), minQty: decimal(min), maxQty: max ? decimal(max) : null }
}

export function sizeMarketOrder(requested, rules) {
  const qty = requested / rules.step * rules.step
  for (const filter of rules.lots) {
    const min = units(filter.minQty)
    const max = units(filter.maxQty)
    if (!qty || qty < min || (max && qty > max)) {
      throw new ApiError(400, 'COPY_LOT_SIZE', '按当前金额计算的数量不在该合约允许的下单范围内。')
    }
  }
  return qty
}
