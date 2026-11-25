import { ApiError } from '../worker/trading.js'
import { verifyAccountIdentity } from './account-binding.js'

// The old bearer token authenticates a configured client. Its configured
// workspace name cannot establish ownership of an exchange account.
export function createConfiguredVerifier(env, environment) {
  const clients = new WeakMap()

  async function verify(user, pair, cache) {
    const scope = pair.markets.join(',')
    const accounts = env.orderStore.accounts
    const previous = cache.get(scope)
    if (previous) {
      const session = accounts.resolveSession(environment, (await previous).token)
      if (session) return session
    }
    const pending = (async () => {
      const allowed = accounts.bindingMarkets(environment, pair.apiKey)
      const markets = pair.markets.filter(market => !allowed || allowed.includes(market))
      const identity = await verifyAccountIdentity(env, environment, pair, markets)
      return accounts.bind(environment, { ...pair, ...identity }, { id: user.id, markets })
    })()
    cache.set(scope, pending)
    try {
      const binding = await pending
      const session = accounts.resolveSession(environment, binding.token)
      if (!session) throw new ApiError(401, 'UNAUTHORIZED', '交易凭证已更新，请重试。')
      return session
    } catch (error) {
      if (cache.get(scope) === pending) cache.delete(scope)
      throw error
    }
  }

  return async (user, request) => {
    let cache = clients.get(user)
    if (!cache) {
      cache = new Map()
      clients.set(user, cache)
    }
    const pairs = []
    if (user.apiKey) pairs.push({ apiKey: user.apiKey, apiSecret: user.apiSecret, markets: ['futures'] })
    if (user.spotApiKey) {
      if (user.apiKey === user.spotApiKey && user.apiSecret === user.spotApiSecret) pairs[0].markets.push('spot')
      else pairs.push({ apiKey: user.spotApiKey, apiSecret: user.spotApiSecret, markets: ['spot'] })
    }
    if (!pairs.length) throw new ApiError(401, 'UNAUTHORIZED', '请先连接可验证 UID 的币安账户。')
    const url = new URL(request.url)
    let market
    if (url.pathname === '/api/futures/other-trades') market = url.searchParams.get('market') ?? 'futures'
    else if (url.pathname.startsWith('/api/spot/')) market = 'spot'
    else if (url.pathname.startsWith('/api/futures/') && url.pathname !== '/api/futures/session') market = 'futures'
    const relevant = pairs.filter(pair => !market || pair.markets.includes(market))
    if (!relevant.length) throw new ApiError(403, 'MARKET_NOT_CONFIGURED', '该账户尚未配置此市场。')
    const sessions = await Promise.all(relevant.map(pair => verify(user, pair, cache)))
    if (sessions.some(session => session.id !== sessions[0].id)) {
      throw new ApiError(409, 'UID_MISMATCH', '配置中的密钥属于不同账户，请分别连接对应市场的密钥。')
    }
    return Object.assign({}, ...sessions, { markets: [...new Set(sessions.flatMap(session => session.markets))] })
  }
}
