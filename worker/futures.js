import {
  ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, getTradingUser, isClientOrderId,
  invalidData, isDecimal, isPositiveDecimal, jsonResponse, orderLookup,
  checkTradingEnvironment, readOrderJson, requireSymbol, submitFuturesOrder,
} from './trading.js'
import { isAppLeverage } from '../shared/leverage.js'
import { publicSymbolLeverage, symbolLeverageInfo } from './futures-leverage.js'
import { lookupPlatformOrder, submitPlatformOrder } from './platform-orders.js'
import { fundedOpeningNotional, getFuturesEquity } from './futures-equity.js'
import { decimal, scale, sizeMarketOrder, symbolRules, units } from './futures-sizing.js'
import { closePosition, requireFuturesSymbol } from './futures-close.js'

export const futuresBase = 'https://fapi.binance.com'
const positionSides = ['BOTH', 'LONG', 'SHORT']
const orderFields = new Set(['environment', 'symbol', 'side', 'positionSide', 'type', 'quantity', 'price', 'reduceOnly', 'leverage', 'clientOrderId'])

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
  if (!Array.isArray(accountData.assets)) throw invalidData()
  const balances = accountData.assets.flatMap(({ asset, walletBalance, availableBalance }) => {
    if (typeof asset !== 'string' || !isDecimal(walletBalance) || !isDecimal(availableBalance)) throw invalidData()
    return asset === 'USDT' || Number(walletBalance) !== 0 || Number(availableBalance) !== 0
      ? [{ asset, walletBalance, availableBalance }] : []
  })
  return { name: user.name, environment, balances, positions: futuresPositions(risk) }
}

export async function getFuturesPositionMode(env, base, user) {
  const config = await binanceRequest(env, base, '/fapi/v1/positionSide/dual', { credentials: user })
  if (typeof config?.dualSidePosition !== 'boolean') throw invalidData()
  return config.dualSidePosition ? 'hedge' : 'oneWay'
}

export function futuresPositions(risk) {
  if (!Array.isArray(risk)) throw invalidData()
  return risk.flatMap(({ symbol, positionSide, positionAmt: quantity, entryPrice, markPrice,
    unRealizedProfit: unrealizedPnl, updateTime, marginAsset }) => {
    if (!isDecimal(quantity)) throw invalidData()
    if (Number(quantity) === 0) return []
    if (typeof symbol !== 'string' || !symbol || !positionSides.includes(positionSide)
      || ![entryPrice, markPrice, unrealizedPnl].every(isDecimal)
      || !Number.isSafeInteger(updateTime) || typeof marginAsset !== 'string' || !marginAsset) throw invalidData()
    return [{ symbol, positionSide, quantity, entryPrice, markPrice, unrealizedPnl, updateTime, marginAsset }]
  })
}

async function previewOrderSize(env, base, user, query, environment) {
  const symbol = requireSymbol(query.get('symbol'))
  const mode = query.get('mode')
  const amount = query.get('amount')
  const price = query.get('price')
  const type = query.get('type')
  const leverage = Number(query.get('leverage'))
  const side = query.get('side')
  const positionSide = query.get('positionSide')
  const order = side === null && positionSide === null ? null : { symbol, side, positionSide, price }
  if (query.get('environment') !== environment) throw new ApiError(409, 'ENVIRONMENT_CHANGED', '请重新连接当前交易环境。')
  if (!['margin', 'equityPercent'].includes(mode) || !isPositiveDecimal(amount)
    || !['MARKET', 'LIMIT'].includes(type) || !isAppLeverage(leverage) || !isPositiveDecimal(price)
    || (mode === 'equityPercent' && Number(amount) > 100)
    || (order && (!['BUY', 'SELL'].includes(side) || !positionSides.includes(positionSide)))) {
    throw new ApiError(400, 'INVALID_ORDER_SIZE', '请检查保证金、比例、杠杆和参考价格。')
  }
  const [rules, { notional, equity }] = await Promise.all([
    symbolRules(env, base, symbol, type),
    fundedOpeningNotional(env, base, user, mode, amount, leverage, order),
  ])
  const size = sizeMarketOrder(notional * scale / units(price), rules)
  if (size * units(price) < rules.minNotional * scale) {
    throw new ApiError(400, 'MIN_NOTIONAL', '按当前设置计算的订单价值低于合约最低下单金额。')
  }
  return { symbol, environment, quantity: decimal(size), margin: decimal(notional / BigInt(leverage)), equity }
}

function orderParams(input, environment) {
  if (input.environment !== environment) {
    throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更，请重新连接账户并确认订单。')
  }
  const { symbol, side, positionSide, type, quantity, price, reduceOnly, leverage, clientOrderId } = input
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
  if (leverage !== undefined) {
    if (!isAppLeverage(leverage)) throw new ApiError(400, 'INVALID_LEVERAGE', '手动杠杆倍数须为正整数。')
    if (reduceOnly || (positionSide === 'LONG' && side === 'SELL') || (positionSide === 'SHORT' && side === 'BUY')) {
      throw new ApiError(400, 'INVALID_LEVERAGE', '平仓单沿用当前杠杆，请移除杠杆设置。')
    }
  }
  const params = { symbol, side, positionSide, type, quantity, newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' }
  if (type === 'LIMIT') Object.assign(params, { price, timeInForce: 'GTC' })
  if (reduceOnly) params.reduceOnly = 'true'
  return params
}

async function route(request, env) {
  const { pathname, searchParams } = new URL(request.url)
  const environment = getTradingEnvironment(env)
  checkTradingEnvironment(request.headers.get('X-Trading-Environment'), searchParams)
  const base = futuresBase
  const methods = {
    '/api/futures/quote': ['GET'], '/api/futures/session': ['GET'],
    '/api/futures/account': ['GET'], '/api/futures/equity': ['GET'],
    '/api/futures/position-mode': ['GET'], '/api/futures/order-size': ['GET'],
    '/api/futures/close-position': ['GET', 'POST'],
    '/api/futures/leverage': ['GET'], '/api/futures/leverage-limit': ['GET'],
    '/api/futures/orders': ['GET', 'POST'],
  }[pathname]
  if (!methods) throw new ApiError(404, 'NOT_FOUND', '接口不存在。')
  if (!methods.includes(request.method)) {
    return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: '请求方法无效。' }, 405, { Allow: methods.join(', ') })
  }
  if (pathname === '/api/futures/quote') {
    return jsonResponse(await quote(env, base, searchParams, environment))
  }
  if (pathname === '/api/futures/leverage-limit') {
    const symbol = requireSymbol(searchParams.get('symbol'))
    return jsonResponse(await publicSymbolLeverage(env, base, symbol, environment))
  }
  const user = await getTradingUser(request, env)
  if (pathname === '/api/futures/session') {
    return jsonResponse({ id: user.id, name: user.name, environment, ...(user.uid && { uid: user.uid }), ...(user.markets && { markets: user.markets }) })
  }
  if (!user.apiKey || !user.apiSecret) throw new ApiError(503, 'FUTURES_NOT_CONFIGURED', '此账户尚未配置合约密钥。')
  if (pathname === '/api/futures/close-position') return closePosition(request, env, base, user, environment)
  if (pathname === '/api/futures/account') return jsonResponse(await account(env, base, user, environment))
  if (pathname === '/api/futures/position-mode') {
    return jsonResponse({ environment, mode: await getFuturesPositionMode(env, base, user) })
  }
  if (pathname === '/api/futures/equity') return jsonResponse(await getFuturesEquity(env, base, user))
  if (pathname === '/api/futures/order-size') return jsonResponse(await previewOrderSize(env, base, user, searchParams, environment))
  if (pathname === '/api/futures/leverage') {
    const symbol = requireSymbol(searchParams.get('symbol'))
    return jsonResponse(await symbolLeverageInfo(env, base, user, symbol, environment))
  }
  const path = '/fapi/v1/order'
  if (request.method === 'GET') {
    const params = orderLookup(searchParams, requireFuturesSymbol)
    const data = await binanceRequest(env, base, path, { credentials: user, params })
    return jsonResponse(lookupPlatformOrder(env, environment, user.id, 'futures', user.apiKey, data, params))
  }
  const input = await readOrderJson(request)
  const params = orderParams(input, environment)
  const receipt = await submitPlatformOrder(env, environment, user.id, 'futures', user.apiKey, params,
    () => submitFuturesOrder(env, base, user, params, input.leverage))
  return jsonResponse(receipt, 201)
}

export async function handleFutures(request, env = {}) {
  try {
    return await route(request, env)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
