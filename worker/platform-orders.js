import { ApiError, orderResult, reserveOrder, unknownOrder } from './trading.js'

// Only the manual ticket paths create these intents. The copy engine has its
// own execution journal, and arbitrary account order lookups cannot create one.
export async function submitPlatformOrder(env, environment, userId, market, apiKey, params, send) {
  const id = params.newClientOrderId
  reserveOrder(env, environment, market, userId, id, {
    apiKey, symbol: params.symbol, side: params.side, type: params.type, positionSide: params.positionSide,
  })
  let data
  try {
    data = await send()
  } catch (error) {
    const definite = error.definite || (error instanceof ApiError && error.status >= 400 && error.status < 500
      && /^-\d+$/.test(error.code) && !['-4111', '-4116'].includes(error.code) && !/duplicat/i.test(error.message))
    if (definite) env.orderStore.platform?.reject(environment, userId, market, id, apiKey)
    throw error
  }
  const receipt = orderResult(data, params.symbol, id, params)
  try {
    env.orderStore.platform?.acknowledge(environment, userId, market, apiKey, receipt, data.time)
  } catch { throw unknownOrder() }
  return receipt
}

export function lookupPlatformOrder(env, environment, userId, market, apiKey, data, params) {
  const receipt = orderResult(data, params.symbol, params.origClientOrderId)
  env.orderStore?.platform?.acknowledge(environment, userId, market, apiKey, receipt, data.time, true, data.positionSide)
  return receipt
}
