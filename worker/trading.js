export { isAppLeverage as isValidLeverage } from '../shared/leverage.js'

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function jsonResponse(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function apiErrorResponse(error) {
  if (error instanceof ApiError) {
    return jsonResponse({ code: error.code, message: error.message }, error.status, error.headers)
  }
  return jsonResponse({ code: 'INTERNAL_ERROR', message: '交易服务暂时无法处理请求。' }, 500)
}

export function getTradingEnvironment(env) {
  const value = env.BINANCE_FUTURES_ENV ?? 'testnet'
  if (value !== 'testnet' && value !== 'live') {
    throw new ApiError(503, 'INVALID_ENVIRONMENT', '服务端交易环境配置有误。')
  }
  return value
}

export function quoteEnvironment(searchParams, fallback) {
  const market = searchParams.get('environment') ?? fallback
  if (market !== 'live' && market !== 'testnet') throw new ApiError(400, 'INVALID_QUOTE_ENVIRONMENT', '行情环境无效。')
  return market
}

const hasText = value => typeof value === 'string' && value.trim().length > 0

let loadedConfig
let userIndex

function configuredUsers(raw) {
  if (userIndex && loadedConfig === raw) return userIndex
  let users
  try {
    users = JSON.parse(raw)
  } catch {
    throw new ApiError(503, 'USERS_NOT_CONFIGURED', '服务端尚未配置交易账户。')
  }
  const ids = new Set()
  const byToken = new Map()
  const owners = new Map()
  if (!Array.isArray(users) || !users.length) {
    throw new ApiError(503, 'USERS_NOT_CONFIGURED', '服务端尚未配置交易账户。')
  }
  for (const user of users) {
    if (!user || !hasText(user.id) || user.id.startsWith('uid:') || !hasText(user.name) || !hasText(user.token) || /\s/.test(user.token)
      || ids.has(user.id) || byToken.has(user.token)) {
      throw new ApiError(503, 'INVALID_USERS', '服务端交易账户配置有误。')
    }
    ids.add(user.id)
    byToken.set(user.token, user)
    for (const [key, secret] of [[user.apiKey, user.apiSecret], [user.spotApiKey, user.spotApiSecret]]) {
      if (key == null && secret == null) continue
      if (!hasText(key) || !hasText(secret) || (owners.has(key) && owners.get(key) !== user.id)) {
        throw new ApiError(503, 'INVALID_USERS', '请为各账户分别配置交易密钥。')
      }
      owners.set(key, user.id)
    }
  }
  loadedConfig = raw
  userIndex = byToken
  return byToken
}

export function sessionToken(request) {
  return request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1]
}

export async function getTradingUser(request, env) {
  const token = sessionToken(request)
  if (token && /^bs_[A-Za-z0-9_-]{43}$/.test(token)) {
    const user = env.orderStore?.accounts?.resolveSession(getTradingEnvironment(env), token)
    if (user) return user
  }
  if (token && env.BINANCE_FUTURES_USERS) {
    const user = configuredUsers(env.BINANCE_FUTURES_USERS).get(token)
    if (user) return env.verifyConfiguredUser ? env.verifyConfiguredUser(user, request) : user
  }
  throw new ApiError(401, 'UNAUTHORIZED', '请重新连接币安账户。')
}

export function getTradingUserById(env, id) {
  if (env.verifyConfiguredUser) return env.orderStore.accounts.getUserById(getTradingEnvironment(env), id)
  const legacy = env.BINANCE_FUTURES_USERS
    ? [...configuredUsers(env.BINANCE_FUTURES_USERS).values()].find(user => user.id === id) : undefined
  return env.orderStore?.accounts?.getUserById(getTradingEnvironment(env), id, legacy) ?? legacy
}

// A legacy workspace can use separate keys for spot and futures. Only its
// matching market may be carried into a session authenticated by one key.
export function legacyBinding(env, apiKey, apiSecret) {
  if (!env.BINANCE_FUTURES_USERS) return null
  for (const user of configuredUsers(env.BINANCE_FUTURES_USERS).values()) {
    if (apiKey !== user.apiKey && apiKey !== user.spotApiKey) continue
    const markets = []
    if (apiKey === user.apiKey && apiSecret === user.apiSecret) markets.push('futures')
    if (apiKey === user.spotApiKey && apiSecret === user.spotApiSecret) markets.push('spot')
    // A market without a preconfigured key can be added by the same owner.
    if (markets.length && !user.spotApiKey) markets.push('spot')
    if (markets.length && !user.apiKey) markets.push('futures')
    return { id: user.id, name: user.name, markets }
  }
  return null
}

export const isUsdtSymbol = value =>
  typeof value === 'string' && /^[\p{Lu}\p{Lo}\p{Nd}]{1,28}USDT$/u.test(value)
export const isClientOrderId = value =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,36}$/.test(value)
export const isPositiveDecimal = value =>
  typeof value === 'string' && /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value)
export const isDecimal = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)
export const invalidData = () => new ApiError(502, 'INVALID_UPSTREAM_DATA', '币安返回的数据格式有误。')

export function requireSymbol(symbol) {
  if (!isUsdtSymbol(symbol)) throw new ApiError(400, 'INVALID_SYMBOL', '请输入有效的 USDT 交易对。')
  return symbol
}

export function orderLookup(searchParams) {
  const symbol = requireSymbol(searchParams.get('symbol'))
  const origClientOrderId = searchParams.get('clientOrderId')
  if (!isClientOrderId(origClientOrderId)) throw new ApiError(400, 'INVALID_ORDER_ID', '客户订单号无效。')
  return { symbol, origClientOrderId }
}

export async function readOrderJson(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'INVALID_CONTENT_TYPE', '订单须以 JSON 格式提交。')
  }
  if (Number(request.headers.get('Content-Length')) > 4096) {
    throw new ApiError(413, 'ORDER_TOO_LARGE', '订单内容过长。')
  }
  const text = await request.text()
  if (text.length > 4096) throw new ApiError(413, 'ORDER_TOO_LARGE', '订单内容过长。')
  try {
    const order = JSON.parse(text)
    if (order && typeof order === 'object' && !Array.isArray(order)) return order
  } catch { /* invalid JSON */ }
  throw new ApiError(400, 'INVALID_ORDER', '订单格式无效。')
}

const encoder = new TextEncoder()

async function sign(params, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(params.toString()))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function unknownOrder() {
  return new ApiError(502, 'ORDER_UNKNOWN', '订单状态待核实，请用原客户订单号查询成交结果。')
}

export function orderResult(data, symbol, clientOrderId, submitted) {
  if (data.symbol !== symbol || data.clientOrderId !== clientOrderId || typeof data.orderId !== 'string'
    || !/^\d+$/.test(data.orderId) || typeof data.status !== 'string' || !data.status
    || !['BUY', 'SELL'].includes(data.side) || !['LIMIT', 'MARKET'].includes(data.type)
    || !isDecimal(data.executedQty) || !isDecimal(data.avgPrice)
    || (submitted && (data.side !== submitted.side || data.type !== submitted.type))) {
    throw submitted ? unknownOrder() : invalidData()
  }
  return {
    symbol, clientOrderId, orderId: data.orderId, status: data.status, side: data.side,
    type: data.type, executedQty: data.executedQty, avgPrice: data.avgPrice,
  }
}

const exchangeTimeoutMs = 12_000

export async function binanceRequest(env, base, path, { method = 'GET', params = {}, credentials, order = false } = {}) {
  const url = new URL(path, base)
  const fields = new URLSearchParams(params)
  const headers = new Headers({ Accept: 'application/json' })
  if (credentials) {
    fields.set('recvWindow', '5000')
    fields.set('timestamp', String(Date.now()))
    fields.set('signature', await sign(fields, credentials.apiSecret))
    headers.set('X-MBX-APIKEY', credentials.apiKey)
  }
  if (method === 'GET') url.search = fields.toString()
  else headers.set('Content-Type', 'application/x-www-form-urlencoded')
  let response
  let payload
  try {
    const fetchBinance = env.fetchBinance ?? fetch
    response = await fetchBinance(url, {
      method, headers, body: method === 'GET' ? undefined : fields.toString(),
      signal: AbortSignal.timeout(exchangeTimeoutMs), redirect: 'manual', cache: 'no-store',
    })
    // Exchange identifiers can exceed Number.MAX_SAFE_INTEGER.
    const text = await response.text()
    try {
      payload = JSON.parse(text, (key, value, context) =>
        (key === 'orderId' || key === 'id' || key === 'uid') && typeof value === 'number' ? context.source : value)
    } catch { /* Non-JSON gateway responses retain their HTTP status below. */ }
  } catch {
    if (order) throw unknownOrder()
    throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', '暂时无法连接币安。')
  }
  if (!response.ok || Number(payload?.code) < 0) {
    const redirected = response.status >= 300 && response.status < 400
    const uncertain = response.status >= 500 || response.status === 408 || redirected
      || [-1000, -1001, -1006, -1007].includes(Number(payload?.code))
    if (order && uncertain) {
      throw unknownOrder()
    }
    const status = response.status >= 400 && response.status < 500 ? response.status : 502
    const code = Number.isInteger(payload?.code) ? String(payload.code) : 'UPSTREAM_ERROR'
    const detail = typeof payload?.msg === 'string' ? payload.msg.slice(0, 240) : `HTTP ${response.status}`
    const error = new ApiError(status, code, `币安返回：${detail}`)
    const retryAfter = response.headers.get('Retry-After')
    if (retryAfter) error.headers = { 'Retry-After': retryAfter }
    throw error
  }
  if (payload == null || typeof payload !== 'object') {
    if (order) throw unknownOrder()
    throw new ApiError(502, 'INVALID_UPSTREAM_DATA', '币安返回的数据格式有误。')
  }
  return payload
}

export function reserveOrder(env, environment, market, userId, clientOrderId, intent) {
  let reserved
  try {
    reserved = env.orderStore?.reserve(environment, market, userId, clientOrderId, intent)
  } catch {
    throw new ApiError(503, 'ORDER_DB_UNAVAILABLE', '订单防重数据库暂不可用。')
  }
  if (reserved === undefined) throw new ApiError(503, 'ORDER_DB_NOT_CONFIGURED', '服务端尚未配置订单防重数据库。')
  if (!reserved) {
    throw new ApiError(409, 'ORDER_UNKNOWN', '此客户订单号已提交过，请查询原订单。')
  }
}

// Binance sets leverage for the whole account's symbol. Two requests must not
// change that setting between another request's acknowledgement and order.
const sendingFuturesOrders = new Set()

export async function setFuturesLeverage(env, base, user, symbol, leverage) {
  try {
    const result = await binanceRequest(env, base, '/fapi/v1/leverage', {
      method: 'POST', credentials: user, params: { symbol, leverage },
    })
    if (result.symbol !== symbol || result.leverage !== leverage) throw invalidData()
  } catch (cause) {
    const error = new ApiError(cause.status ?? 502, 'LEVERAGE_NOT_CONFIRMED',
      '未能确认 ' + symbol + ' 的 ' + leverage + ' 倍杠杆，订单未提交。' + (cause instanceof ApiError ? cause.message : ''))
    error.headers = cause.headers
    error.definite = true
    throw error
  }
}

export async function submitFuturesOrder(env, base, user, params, leverage, checkExposure) {
  const identity = [getTradingEnvironment(env), user.id, params.symbol]
  const owner = params.newClientOrderId
  const key = JSON.stringify(identity)
  const busy = () => {
    const error = new ApiError(409, 'FUTURES_SYMBOL_BUSY', params.symbol + ' 正在处理另一笔订单，请稍后重试。')
    error.definite = true
    return error
  }
  if (sendingFuturesOrders.has(key)) throw busy()
  const now = Date.now()
  const expiresAt = now + 60_000
  const store = env.orderStore
  let acquired
  try {
    acquired = store.claimFuturesSymbol?.(...identity, owner, expiresAt, now) ?? true
  } catch {
    const error = new ApiError(503, 'ORDER_DB_UNAVAILABLE', '订单防重数据库暂不可用。')
    error.definite = true
    throw error
  }
  if (!acquired) throw busy()
  sendingFuturesOrders.add(key)
  try {
    if (checkExposure) {
      try { await checkExposure() } catch (error) { error.definite = true; throw error }
      if (Date.now() + 2 * exchangeTimeoutMs >= expiresAt) throw busy()
    }
    if (leverage !== undefined) await setFuturesLeverage(env, base, user, params.symbol, leverage)
    // A suspended process must not send its order after another owner can
    // acquire the symbol. Leave time for the entire exchange request.
    if (Date.now() + exchangeTimeoutMs >= expiresAt) throw busy()
    return await binanceRequest(env, base, '/fapi/v1/order', { method: 'POST', params, credentials: user, order: true })
  } finally {
    sendingFuturesOrders.delete(key)
    try { store.releaseFuturesSymbol?.(...identity, owner) } catch { /* The lease expires independently of the order result. */ }
  }
}
