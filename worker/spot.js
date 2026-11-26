import {
  ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, invalidData, isClientOrderId,
  isDecimal, isPositiveDecimal, jsonResponse, orderLookup, checkTradingEnvironment, readOrderJson, requireSymbol,
} from './trading.js'
import { lookupPlatformOrder, submitPlatformOrder } from './platform-orders.js'

export const spotBase = 'https://api.binance.com'
const orderFields = new Set(['environment', 'symbol', 'quoteOrderQty', 'clientOrderId'])

function fillAverage(quoteTotal, quantity) {
  if (![quoteTotal, quantity].every(value => isDecimal(value) && !value.startsWith('-'))) return null
  const baseUnits = BigInt(quantity.replace('.', ''))
  if (baseUnits === 0n) return '0'
  // Divide the exact filled quote total by the executed base quantity, rounded to 18 decimals.
  const scale = value => (value.split('.')[1] ?? '').length
  const numerator = BigInt(quoteTotal.replace('.', '')) * 10n ** BigInt(18 + scale(quantity))
  const denominator = baseUnits * 10n ** BigInt(scale(quoteTotal))
  const digits = ((numerator + denominator / 2n) / denominator).toString().padStart(19, '0')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '')
}

export function spotBalances(data) {
  if (!Array.isArray(data.balances)) throw invalidData()
  return data.balances.flatMap(({ asset, free, locked }) => {
    if (typeof asset !== 'string' || !isDecimal(free) || !isDecimal(locked)) throw invalidData()
    return Number(free) || Number(locked) ? [{ asset, free, locked }] : []
  })
}

async function route(request, env) {
  const { pathname, searchParams } = new URL(request.url)
  const environment = getTradingEnvironment(env)
  checkTradingEnvironment(request.headers.get('X-Trading-Environment'), searchParams)
  const base = spotBase
  const methods = {
    '/api/spot/quote': ['GET'], '/api/spot/account': ['GET'], '/api/spot/orders': ['GET', 'POST'],
  }[pathname]
  if (!methods) throw new ApiError(404, 'NOT_FOUND', '接口不存在。')
  if (!methods.includes(request.method)) {
    return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: '请求方法无效。' }, 405, { Allow: methods.join(', ') })
  }
  if (pathname === '/api/spot/quote') {
    const symbol = requireSymbol(searchParams.get('symbol'))
    const ticker = await binanceRequest(env, base, '/api/v3/ticker/price', { params: { symbol } })
    if (ticker.symbol !== symbol || !isPositiveDecimal(ticker.price)) throw invalidData()
    return jsonResponse({ symbol, lastPrice: ticker.price, environment, time: Date.now() })
  }
  const user = await getTradingUser(request, env)
  if (!user.spotApiKey || !user.spotApiSecret) throw new ApiError(503, 'SPOT_NOT_CONFIGURED', '此账户尚未配置现货密钥。')
  const credentials = { apiKey: user.spotApiKey, apiSecret: user.spotApiSecret }
  if (pathname === '/api/spot/account') {
    const data = await binanceRequest(env, base, '/api/v3/account', { credentials, params: { omitZeroBalances: 'true' } })
    return jsonResponse({ name: user.name, environment, balances: spotBalances(data) })
  }
  const path = '/api/v3/order'
  if (request.method === 'GET') {
    const params = orderLookup(searchParams)
    const data = await binanceRequest(env, base, path, { credentials, params })
    data.avgPrice = fillAverage(data.cummulativeQuoteQty, data.executedQty)
    return jsonResponse(lookupPlatformOrder(env, environment, user.id, 'spot', credentials.apiKey, data, params))
  }
  const input = await readOrderJson(request)
  if (input.environment !== environment) {
    throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更，请重新连接账户并确认订单。')
  }
  const symbol = requireSymbol(input.symbol)
  if (Object.keys(input).some(key => !orderFields.has(key)) || !isClientOrderId(input.clientOrderId)
    || !isPositiveDecimal(input.quoteOrderQty)) throw new ApiError(400, 'INVALID_ORDER', '请检查买入金额与客户订单号。')
  const params = {
    symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: input.quoteOrderQty,
    newClientOrderId: input.clientOrderId, newOrderRespType: 'RESULT',
  }
  const receipt = await submitPlatformOrder(env, environment, user.id, 'spot', credentials.apiKey, params, async () => {
    const data = await binanceRequest(env, base, path, { method: 'POST', credentials, params, order: true })
    data.avgPrice = fillAverage(data.cummulativeQuoteQty, data.executedQty)
    return data
  })
  return jsonResponse(receipt, 201)
}

export async function handleSpot(request, env = {}) {
  try {
    return await route(request, env)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
