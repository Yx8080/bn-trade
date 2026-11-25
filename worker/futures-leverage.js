import { ApiError, binanceRequest, invalidData, isDecimal, isValidLeverage } from './trading.js'
import { decimal, units } from './futures-sizing.js'

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
  if (tiers.some((tier, index) => tier.floor !== (index ? tiers[index - 1].cap : 0n))) throw invalidData()
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

export async function checkCopyLeverage(env, base, user, symbol, leverage, additionalNotional) {
  let tiers, exposure
  try {
    [tiers, exposure] = await Promise.all([
      leverageTiers(env, base, user, symbol), grossExposure(env, base, user, symbol),
    ])
  } catch (cause) {
    const error = new ApiError(cause.status ?? 502, 'COPY_LEVERAGE_UNAVAILABLE',
      '已跳过开仓。无法核实该交易对的账户杠杆档位。' + (cause instanceof ApiError ? cause.message : ''))
    error.headers = cause.headers
    throw error
  }
  const target = exposure + additionalNotional
  const maximum = tiers.find(t => target <= t.cap)?.leverage
  if (!maximum || leverage > maximum) {
    const detail = maximum ? '该档最高 ' + maximum + ' 倍，设置为 ' + leverage + ' 倍。' : '已超过该账户最高名义价值档位。'
    throw new ApiError(409, 'COPY_LEVERAGE_LIMIT', '已跳过开仓。预计总仓位价值 ' + decimal(target) + ' USDT，' + detail)
  }
}
