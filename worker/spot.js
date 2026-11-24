import {
  ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, invalidData, isClientOrderId,
  isDecimal, isPositiveDecimal, jsonResponse, orderLookup, orderResult, quoteEnvironment, readOrderJson, requireSymbol, reserveOrder,
} from './trading.js'

const bases = { testnet: 'https://testnet.binance.vision', live: 'https://api.binance.com' }
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

async function route(request, env) {
  const { pathname, searchParams } = new URL(request.url)
  const environment = getTradingEnvironment(env)
  const base = bases[environment]
  const methods = {
    '/api/spot/quote': ['GET'], '/api/spot/account': ['GET'], '/api/spot/orders': ['GET', 'POST'],
  }[pathname]
  if (!methods) throw new ApiError(404, 'NOT_FOUND', '接口不存在。')
  if (!methods.includes(request.method)) {
    return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: '请求方法无效。' }, 405, { Allow: methods.join(', ') })
  }
  if (pathname === '/api/spot/quote') {
    const market = quoteEnvironment(searchParams, environment)
    const symbol = requireSymbol(searchParams.get('symbol'))
    const ticker = await binanceRequest(env, bases[market], '/api/v3/ticker/price', { params: { symbol } })
    if (ticker.symbol !== symbol || !isPositiveDecimal(ticker.price)) throw invalidData()
    return jsonResponse({ symbol, lastPrice: ticker.price, environment: market, time: Date.now() })
  }
  const user = getTradingUser(request, env)
  if (!user.spotApiKey || !user.spotApiSecret) throw new ApiError(503, 'SPOT_NOT_CONFIGURED', '此账户尚未配置现货密钥。')
  const credentials = { apiKey: user.spotApiKey, apiSecret: user.spotApiSecret }
  if (pathname === '/api/spot/account') {
    const data = await binanceRequest(env, base, '/api/v3/account', { credentials, params: { omitZeroBalances: 'true' } })
    if (!Array.isArray(data.balances)) throw invalidData()
    const balances = data.balances.flatMap(({ asset, free, locked }) => {
      if (typeof asset !== 'string' || !isDecimal(free) || !isDecimal(locked)) throw invalidData()
      return Number(free) || Number(locked) ? [{ asset, free, locked }] : []
    })
    return jsonResponse({ name: user.name, environment, balances })
  }
  const path = '/api/v3/order'
  if (request.method === 'GET') {
    const params = orderLookup(searchParams)
    const data = await binanceRequest(env, base, path, { credentials, params })
    data.avgPrice = fillAverage(data.cummulativeQuoteQty, data.executedQty)
    return jsonResponse(orderResult(data, params.symbol, params.origClientOrderId))
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
  reserveOrder(env, environment, 'spot', user.id, input.clientOrderId)
  const data = await binanceRequest(env, base, path, { method: 'POST', credentials, params, order: true })
  data.avgPrice = fillAverage(data.cummulativeQuoteQty, data.executedQty)
  return jsonResponse(orderResult(data, symbol, input.clientOrderId, params), 201)
}

export async function handleSpot(request, env = {}) {
  try {
    return await route(request, env)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
