import {
  ApiError, binanceRequest, invalidData, isClientOrderId, isDecimal, isPositiveDecimal,
  jsonResponse, readOrderJson, submitFuturesOrder,
} from './trading.js'
import { closeLotRules, units } from './futures-sizing.js'
import { submitPlatformOrder } from './platform-orders.js'

const closeFields = new Set(['environment', 'symbol', 'positionSide', 'direction', 'quantity',
  'expectedQuantity', 'expectedUpdateTime', 'clientOrderId'])

// Positions can include USDC and dated contracts outside the opening ticket's USDT pairs.
export function requireFuturesSymbol(symbol) {
  if (typeof symbol !== 'string' || !/^[\p{L}\p{Nd}][\p{L}\p{Nd}_-]{0,79}$/u.test(symbol))
    throw new ApiError(400, 'INVALID_SYMBOL', '请检查合约交易对。')
  return symbol
}

function validateClose(input, environment) {
  if (input.environment !== environment)
    throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更，请重新核对仓位。')
  requireFuturesSymbol(input.symbol)
  const { positionSide, direction, quantity, expectedQuantity, expectedUpdateTime, clientOrderId } = input
  if (!['LONG', 'SHORT'].includes(direction) || (positionSide !== 'BOTH' && positionSide !== direction)
    || !isClientOrderId(clientOrderId) || !isPositiveDecimal(quantity) || !isPositiveDecimal(expectedQuantity)
    || units(quantity) > units(expectedQuantity) || !Number.isSafeInteger(expectedUpdateTime) || expectedUpdateTime < 0
    || Object.keys(input).some(field => !closeFields.has(field))) {
    throw new ApiError(400, 'INVALID_CLOSE', '请核对所选持仓、平仓方向及数量。')
  }
}

async function checkClose(env, base, user, input) {
  const { symbol, positionSide, direction, quantity, expectedQuantity, expectedUpdateTime } = input
  try {
    const [risk, rules] = await Promise.all([
      binanceRequest(env, base, '/fapi/v3/positionRisk', { credentials: user, params: { symbol } }),
      closeLotRules(env, base, symbol),
    ])
    if (!Array.isArray(risk)) throw invalidData()
    const rows = risk.filter(row => row?.symbol === symbol && row.positionSide === positionSide)
    if (rows.length > 1) throw invalidData()
    const row = rows[0]
    if (row && (!isDecimal(row.positionAmt) || !Number.isSafeInteger(row.updateTime))) throw invalidData()
    if (!row || row.updateTime !== expectedUpdateTime || row.positionAmt.startsWith('-') !== (direction === 'SHORT')
      || units(row.positionAmt.replace(/^-/, '')) !== units(expectedQuantity)) {
      throw new ApiError(409, 'POSITION_CHANGED', '该仓位已变化，请刷新持仓并重新确认平仓数量。')
    }
    const size = units(quantity)
    if (size % units(rules.stepSize) || size < units(rules.minQty) || (rules.maxQty && size > units(rules.maxQty))) {
      throw new ApiError(400, 'INVALID_CLOSE_QUANTITY', '平仓数量不符合该合约的市价下单步长或单笔数量范围。')
    }
  } catch (cause) {
    if (cause instanceof ApiError && cause.status < 500 && cause.status !== 408) throw cause
    throw new ApiError(502, 'CLOSE_CHECK_UNAVAILABLE', '暂时无法核实当前仓位或下单规则，请刷新后重试。')
  }
}

export async function closePosition(request, env, base, user, environment) {
  if (request.method === 'GET') {
    const symbol = requireFuturesSymbol(new URL(request.url).searchParams.get('symbol'))
    return jsonResponse({ symbol, environment, ...await closeLotRules(env, base, symbol) })
  }
  const input = await readOrderJson(request)
  validateClose(input, environment)
  const params = {
    symbol: input.symbol, positionSide: input.positionSide, side: input.direction === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET', quantity: input.quantity, newClientOrderId: input.clientOrderId, newOrderRespType: 'RESULT',
  }
  if (params.positionSide === 'BOTH') params.reduceOnly = 'true'
  const receipt = await submitPlatformOrder(env, environment, user.id, 'futures', user.apiKey, params,
    () => submitFuturesOrder(env, base, user, params, undefined, () => checkClose(env, base, user, input)))
  return jsonResponse(receipt, 201)
}
