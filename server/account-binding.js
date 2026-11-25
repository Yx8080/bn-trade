import { futuresBases } from '../worker/futures.js'
import { spotBases } from '../worker/spot.js'
import { ApiError, apiErrorResponse, binanceRequest, getTradingEnvironment, jsonResponse, legacyBinding,
  readOrderJson, sessionToken } from '../worker/trading.js'

const futuresProbe = { path: '/fapi/v3/account', field: 'assets' }
const spotProbe = { path: '/api/v3/account', field: 'balances', params: { omitZeroBalances: 'true' } }
const marketNames = ['futures', 'spot']
const bindingPolicy = { credentialStorage: 'memory', identity: 'binance-uid' }
const validCredential = value => typeof value === 'string' && /^[!-~]{1,256}$/.test(value)
const rejected = () => new ApiError(401, 'BINDING_REJECTED', '验证未通过，请核对密钥、交易环境、读取权限和 IP 白名单。')
const unavailable = () => new ApiError(503, 'BINDING_UNAVAILABLE', '暂时无法验证币安账户，请稍后重试。')
const limited = () => new ApiError(429, 'BINDING_RATE_LIMITED', '币安验证请求已达限流，请稍后重试。')
const missingUid = () => new ApiError(403, 'UID_UNAVAILABLE', '币安未返回可验证的账户 UID，请核对当前环境和账户读取权限。')
const uidMismatch = () => new ApiError(409, 'UID_MISMATCH', '币安账户的身份验证结果不一致，无法建立会话。')

function checkBrowserOrigin(request) {
  const origin = request.headers.get('Origin')
  if (!origin) return
  let url
  try { url = new URL(origin) } catch { /* Reject opaque origins. */ }
  const localHttp = url?.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
  if ((!localHttp && url?.protocol !== 'https:') || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new ApiError(403, 'INVALID_BINDING_ORIGIN', '请通过本机地址或工作台的 HTTPS 页面连接账户。')
  }
}

async function verifyMarket(env, base, probe, credentials) {
  try {
    const data = await binanceRequest(env, base, probe.path, { credentials, params: probe.params })
    if (!Array.isArray(data[probe.field])) return { status: 'unavailable' }
    return { status: 'verified', uid: data.uid }
  } catch (error) {
    if (error.status === 429 || error.status === 418 || error.code === '-1003') return { status: 'limited' }
    if (['-2014', '-2015', '-1022'].includes(error.code)) return { status: 'rejected' }
    return { status: 'unavailable' }
  }
}

// /api/v3/account identifies the signing key's owner. The USD-M account
// endpoint establishes futures access but does not document an account UID.
export async function verifyAccountIdentity(env, environment, credentials, allowedMarkets = marketNames) {
  if (!allowedMarkets.length) throw rejected()
  const [futures, spot] = await Promise.all([
    allowedMarkets.includes('futures') && verifyMarket(env, futuresBases[environment], futuresProbe, credentials),
    (environment === 'live' || allowedMarkets.includes('spot')) && verifyMarket(env, spotBases[environment], spotProbe, credentials),
  ])
  const verdicts = { futures, spot }
  const markets = allowedMarkets.filter(market => verdicts[market].status === 'verified')
  if (!markets.length) {
    if (allowedMarkets.some(market => verdicts[market].status === 'limited')) throw limited()
    if (allowedMarkets.some(market => verdicts[market].status === 'unavailable')) throw unavailable()
    throw rejected()
  }

  let identity = spot
  let issuer = environment === 'live' ? 'live' : 'spot-testnet'
  if (environment === 'testnet' && markets.includes('futures')) {
    // Spot Test Network and Binance Demo Trading issue credentials independently.
    if (markets.includes('spot')) throw uidMismatch()
    issuer = 'demo'
    identity = await verifyMarket(env, 'https://demo-api.binance.com', spotProbe, credentials)
  }
  if (identity.status === 'limited') throw limited()
  if (identity.status === 'unavailable') throw unavailable()
  // binanceRequest retains the exact source text of numeric UIDs.
  if (identity.status !== 'verified' || typeof identity.uid !== 'string' || !/^[1-9]\d{0,19}$/.test(identity.uid)) throw missingUid()
  if (futures?.uid !== undefined && futures.uid !== identity.uid) throw uidMismatch()
  const unavailableMarkets = allowedMarkets.filter(market => ['limited', 'unavailable'].includes(verdicts[market].status))
  return { issuer, uid: identity.uid, markets, unavailableMarkets }
}

export async function accountBinding(request, env) {
  try {
    const environment = getTradingEnvironment(env)
    if (new URL(request.url).pathname === '/api/accounts/session') {
      if (request.method !== 'DELETE') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'DELETE' })
      const token = sessionToken(request)
      if (token) env.orderStore.accounts.revoke(environment, token)
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    }
    if (request.method === 'GET') return jsonResponse({ environment, ...bindingPolicy })
    if (request.method !== 'POST') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET, POST' })
    checkBrowserOrigin(request)
    const input = await readOrderJson(request)
    if (input.environment !== environment)
      throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更，请核对后重新绑定。')
    if (Object.hasOwn(input, 'identity') && input.identity !== bindingPolicy.identity)
      throw new ApiError(409, 'BINDING_POLICY_MISMATCH', '当前服务仅支持通过币安 UID 绑定并在内存中使用密钥。')
    const { apiKey, apiSecret } = input
    if (!validCredential(apiKey) || !validCredential(apiSecret)
      || Object.keys(input).some(key => !['environment', 'identity', 'apiKey', 'apiSecret'].includes(key))) {
      throw new ApiError(400, 'INVALID_BINDING', '请输入有效的币安 HMAC API Key 和 API Secret。')
    }
    const legacy = legacyBinding(env, apiKey, apiSecret)
    const accounts = env.orderStore.accounts
    const allowed = accounts.bindingMarkets(environment, apiKey)
    const allowedMarkets = marketNames.filter(market => (!legacy || legacy.markets.includes(market)) && (!allowed || allowed.includes(market)))
    const identity = await verifyAccountIdentity(env, environment, { apiKey, apiSecret }, allowedMarkets)
    const result = accounts.bind(environment, { apiKey, apiSecret, ...identity }, legacy)
    return jsonResponse(result)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
