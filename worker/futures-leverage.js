import { ApiError, binanceRequest, invalidData, isDecimal, isValidLeverage } from './trading.js'
import { decimal, getContract, units } from './futures-sizing.js'

async function publicLeverageBrackets(env, symbol) {
  const url = new URL('https://www.binance.com/bapi/futures/v1/public/future/common/brackets')
  const fetchBinance = env.fetchBinance ?? fetch
  let response
  let data
  try {
    response = await fetchBinance(url, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', clienttype: 'web' },
      body: JSON.stringify({ symbol }), redirect: 'manual', signal: AbortSignal.timeout(12_000),
    })
    if (response.ok) data = await response.json()
    else await response.body?.cancel()
  } catch {
    throw new ApiError(502, 'PUBLIC_LEVERAGE_UNAVAILABLE', '暂时无法读取币安公开杠杆档位。')
  }
  if (!response.ok || data?.code !== '000000' || data.success === false || !Array.isArray(data.data?.brackets)) {
    const error = new ApiError(response.status === 429 ? 429 : 502, 'PUBLIC_LEVERAGE_UNAVAILABLE', '暂时无法读取币安公开杠杆档位。')
    const retryAfter = response.headers.get('Retry-After')
    if (retryAfter) error.headers = { 'Retry-After': retryAfter }
    throw error
  }
  return data.data.brackets.find(row => row?.symbol === symbol)?.riskBrackets
}

export async function publicSymbolLeverage(env, base, symbol, environment) {
  // The public bracket service can return default tiers for unknown symbols.
  const [contract, brackets] = await Promise.all([
    getContract(env, base, symbol), publicLeverageBrackets(env, symbol),
  ])
  if (contract?.status !== 'TRADING' || contract.quoteAsset !== 'USDT') {
    throw new ApiError(404, 'INVALID_SYMBOL', '该交易环境暂无可交易的 ' + symbol + ' 合约。')
  }
  const firstTier = Array.isArray(brackets) && brackets.find(row => row?.bracketNotionalFloor === 0)
  if (!isValidLeverage(firstTier?.maxOpenPosLeverage)) throw invalidData()
  return { symbol, environment, symbolMaxLeverage: firstTier.maxOpenPosLeverage }
}

async function leverageTiers(env, base, user, symbol) {
  const response = await binanceRequest(env, base, '/fapi/v1/leverageBracket', { credentials: user, params: { symbol } })
  const account = (Array.isArray(response) ? response : [response]).find(row => row?.symbol === symbol)
  if (!Array.isArray(account?.brackets) || !account.brackets.length) throw invalidData()
  // This signed response already contains the account's bracket floors and
  // caps. notionalCoef describes their relationship to the default brackets.
  const tiers = account.brackets.map(row => {
    const floor = units(row.notionalFloor), cap = units(row.notionalCap)
    if (!isValidLeverage(row.initialLeverage) || cap <= floor) throw invalidData()
    return { floor, cap, leverage: row.initialLeverage }
  }).sort((a, b) => a.floor < b.floor ? -1 : a.floor > b.floor ? 1 : 0)
  if (tiers[0].floor !== 0n || tiers.slice(1).some((tier, index) =>
    tier.floor !== tiers[index].cap || tier.leverage > tiers[index].leverage)) throw invalidData()
  return tiers
}

async function grossExposure(env, base, user, symbol) {
  const positions = await binanceRequest(env, base, '/fapi/v3/positionRisk', { credentials: user, params: { symbol } })
  if (!Array.isArray(positions)) throw invalidData()
  let gross = 0n
  for (const row of positions) {
    if (row?.symbol !== symbol || !isDecimal(row.notional)) throw invalidData()
    gross += units(row.notional.replace(/^-/, ''))
  }
  return gross
}

export async function symbolLeverageInfo(env, base, user, symbol, environment) {
  const [limits, holdings, config] = await Promise.allSettled([
    leverageTiers(env, base, user, symbol), grossExposure(env, base, user, symbol),
    binanceRequest(env, base, '/fapi/v1/symbolConfig', { credentials: user, params: { symbol } }),
  ])
  if (limits.status === 'rejected') throw limits.reason
  const tiers = limits.value
  const exposure = holdings.status === 'fulfilled' ? holdings.value : null
  const current = config.status === 'fulfilled' && Array.isArray(config.value)
    ? config.value.find(row => row?.symbol === symbol)?.leverage : null
  const maxLeverage = exposure === null ? null : tiers.find(t => exposure <= t.cap)?.leverage ?? null
  return { symbol, environment, leverage: isValidLeverage(current) ? current : null,
    symbolMaxLeverage: tiers[0].leverage, maxLeverage, exposure: exposure === null ? null : decimal(exposure),
    brackets: tiers.map(t => ({ cap: decimal(t.cap), leverage: t.leverage })) }
}

export async function readCopyLeverageLimits(env, base, user, symbol) {
  try {
    const [tiers, exposure] = await Promise.all([
      leverageTiers(env, base, user, symbol), grossExposure(env, base, user, symbol),
    ])
    return { tiers, exposure }
  } catch (cause) {
    const error = new ApiError(cause.status ?? 502, 'COPY_LEVERAGE_UNAVAILABLE',
      '已跳过开仓。无法核实该交易对的账户杠杆档位。' + (cause instanceof ApiError ? cause.message : ''))
    error.headers = cause.headers
    throw error
  }
}

export function maximumCopyLeverage({ tiers, exposure }, additionalNotionalAt, requested = tiers[0].leverage) {
  // Higher leverage cannot decrease order size or increase the next position's bracket limit.
  let allowed = 0
  let upper = Math.min(requested, tiers[0].leverage)
  while (allowed < upper) {
    const candidate = allowed + Math.ceil((upper - allowed) / 2)
    const target = exposure + additionalNotionalAt(candidate)
    const maximum = tiers.find(tier => target <= tier.cap)?.leverage ?? 0
    if (candidate <= maximum) allowed = candidate
    else upper = candidate - 1
  }
  if (!allowed) throw new ApiError(409, 'COPY_LEVERAGE_LIMIT', '已跳过开仓。预计总仓位价值超过该账户最高名义价值档位。')
  return allowed
}
