import {
  ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, isClientOrderId,
  invalidData, isDecimal, isPositiveDecimal, jsonResponse, orderLookup,
  orderResult, quoteEnvironment, readOrderJson, requireSymbol, reserveOrder,
} from './trading.js'

const bases = { testnet: 'https://demo-fapi.binance.com', live: 'https://fapi.binance.com' }
const positionSides = ['BOTH', 'LONG', 'SHORT']
const orderFields = new Set(['environment', 'symbol', 'side', 'positionSide', 'type', 'quantity', 'price', 'reduceOnly', 'clientOrderId'])

async function quote(env, base, searchParams, environment) {
  const symbol = requireSymbol(searchParams.get('symbol'))
  const options = { params: { symbol } }
  const [ticker, mark] = await Promise.all([
    binanceRequest(env, base, '/fapi/v2/ticker/price', options),
    binanceRequest(env, base, '/fapi/v1/premiumIndex', options),
  ])
  if (ticker.symbol !== symbol || mark.symbol !== symbol || !isPositiveDecimal(ticker.price)
    || !isPositiveDecimal(mark.markPrice) || !Number.isSafeInteger(ticker.time) || ticker.time <= 0
    || !Number.isSafeInteger(mark.time) || mark.time <= 0) throw invalidData()
  return { symbol, lastPrice: ticker.price, lastTime: ticker.time, markPrice: mark.markPrice, time: mark.time, environment }
}

async function account(env, base, user, environment) {
  const options = { credentials: user }
  const [accountData, risk] = await Promise.all([
    binanceRequest(env, base, '/fapi/v3/account', options),
    binanceRequest(env, base, '/fapi/v3/positionRisk', options),
  ])
  if (!Array.isArray(accountData.assets) || !Array.isArray(risk)) throw invalidData()
  const balances = accountData.assets.flatMap(({ asset, walletBalance, availableBalance }) => {
    if (typeof asset !== 'string' || !isDecimal(walletBalance) || !isDecimal(availableBalance)) throw invalidData()
    return asset === 'USDT' || Number(walletBalance) !== 0 || Number(availableBalance) !== 0
      ? [{ asset, walletBalance, availableBalance }] : []
  })
  const positions = risk.flatMap(({ symbol, positionSide, positionAmt: quantity, entryPrice, markPrice,
    unRealizedProfit: unrealizedPnl, updateTime, marginAsset }) => {
    if (!isDecimal(quantity)) throw invalidData()
    if (Number(quantity) === 0) return []
    if (typeof symbol !== 'string' || !symbol || !positionSides.includes(positionSide)
      || ![entryPrice, markPrice, unrealizedPnl].every(isDecimal)
      || !Number.isSafeInteger(updateTime) || typeof marginAsset !== 'string' || !marginAsset) throw invalidData()
    return [{ symbol, positionSide, quantity, entryPrice, markPrice, unrealizedPnl, updateTime, marginAsset }]
  })
  return { name: user.name, environment, balances, positions }
}

function orderParams(input, environment) {
  if (input.environment !== environment) {
    throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更，请重新连接账户并确认订单。')
  }
  const { symbol, side, positionSide, type, quantity, price, reduceOnly, clientOrderId } = input
  requireSymbol(symbol)
  if (!isClientOrderId(clientOrderId) || !['BUY', 'SELL'].includes(side) || !positionSides.includes(positionSide)
    || !['MARKET', 'LIMIT'].includes(type) || !isPositiveDecimal(quantity)
    || Object.keys(input).some(key => !orderFields.has(key))) {
    throw new ApiError(400, 'INVALID_ORDER', '请检查订单方向、类型、数量和客户订单号。')
  }
  if (type === 'LIMIT' ? !isPositiveDecimal(price) : price !== undefined) {
    throw new ApiError(400, 'INVALID_PRICE', '限价单需要正数价格，市价单请留空价格。')
  }
  if (reduceOnly !== undefined && (typeof reduceOnly !== 'boolean' || (reduceOnly && positionSide !== 'BOTH'))) {
    throw new ApiError(400, 'INVALID_REDUCE_ONLY', '仅减仓参数仅适用于单向持仓。')
  }
  const params = { symbol, side, positionSide, type, quantity, newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' }
  if (type === 'LIMIT') Object.assign(params, { price, timeInForce: 'GTC' })
  if (reduceOnly) params.reduceOnly = 'true'
  return params
}

async function route(request, env) {
  const { pathname, searchParams } = new URL(request.url)
  const environment = getTradingEnvironment(env)
  const base = bases[environment]
  const methods = {
    '/api/futures/quote': ['GET'], '/api/futures/session': ['GET'],
    '/api/futures/account': ['GET'], '/api/futures/orders': ['GET', 'POST'],
  }[pathname]
  if (!methods) throw new ApiError(404, 'NOT_FOUND', '接口不存在。')
  if (!methods.includes(request.method)) {
    return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: '请求方法无效。' }, 405, { Allow: methods.join(', ') })
  }
  if (pathname === '/api/futures/quote') {
    const market = quoteEnvironment(searchParams, environment)
    return jsonResponse(await quote(env, bases[market], searchParams, market))
  }
  const user = getTradingUser(request, env)
  if (pathname === '/api/futures/session') {
    return jsonResponse({ id: user.id, name: user.name, environment })
  }
  if (!user.apiKey || !user.apiSecret) throw new ApiError(503, 'FUTURES_NOT_CONFIGURED', '此账户尚未配置合约密钥。')
  if (pathname === '/api/futures/account') return jsonResponse(await account(env, base, user, environment))
  const path = '/fapi/v1/order'
  if (request.method === 'GET') {
    const params = orderLookup(searchParams)
    const data = await binanceRequest(env, base, path, { credentials: user, params })
    return jsonResponse(orderResult(data, params.symbol, params.origClientOrderId))
  }
  const input = await readOrderJson(request)
  const params = orderParams(input, environment)
  reserveOrder(env, environment, 'futures', user.id, input.clientOrderId)
  const data = await binanceRequest(env, base, path, { method: 'POST', params, credentials: user, order: true })
  return jsonResponse(orderResult(data, input.symbol, input.clientOrderId, input), 201)
}

export async function handleFutures(request, env = {}) {
  try {
    return await route(request, env)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
