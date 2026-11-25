import { randomBytes } from 'node:crypto'
import { ApiError } from '../worker/trading.js'
import { createAccountHistory } from './account-history.js'

const lifetime = 12 * 3_600_000
const markets = ['spot', 'futures']
const validMarkets = value => Array.isArray(value) && value.every(m => markets.includes(m))

function accountId(environment, uid, issuer) {
  if (typeof uid !== 'string' || !/^[1-9]\d{0,19}$/.test(uid)) return null
  if (environment === 'live' && issuer === 'live') return 'uid:' + uid
  if (environment === 'testnet' && ['demo', 'spot-testnet'].includes(issuer)) return 'uid:' + issuer + ':' + uid
  return null
}

function tradingUser(account, granted) {
  const user = { id: account.id, uid: account.uid, issuer: account.issuer, name: account.name, markets: granted }
  if (granted.includes('spot')) {
    user.spotApiKey = account.spot.apiKey
    user.spotApiSecret = account.spot.apiSecret
  }
  if (granted.includes('futures')) {
    user.apiKey = account.futures.apiKey
    user.apiSecret = account.futures.apiSecret
    user.futuresConnectedAt = account.futuresConnectedAt
  }
  return user
}

export function createBoundAccounts(db) {
  const history = createAccountHistory(db)
  const connected = new Map()
  const sessions = new Map()

  return {
    bindingMarkets: history.bindingMarkets,

    // Only the server's signed exchange probes supply these identity fields.
    bind(environment, { uid, issuer, apiKey, apiSecret, markets: verified, unavailableMarkets = [] }, legacyOwner) {
      const id = accountId(environment, uid, issuer)
      if (!id || !validMarkets(verified) || !verified.length || !validMarkets(unavailableMarkets)
        || unavailableMarkets.some(m => verified.includes(m))
        || (issuer === 'demo' && verified.includes('spot')) || (issuer === 'spot-testnet' && verified.includes('futures'))
        || typeof apiKey !== 'string' || !apiKey || typeof apiSecret !== 'string' || !apiSecret) {
        throw new ApiError(400, 'INVALID_BINDING', '绑定身份或已验证的市场范围无效。')
      }
      const allowed = history.bindingMarkets(environment, apiKey)
      const granted = markets.filter(m => verified.includes(m) && (!allowed || allowed.includes(m))
        && (!legacyOwner?.markets || legacyOwner.markets.includes(m)))
      if (!granted.length) throw new ApiError(401, 'BINDING_REJECTED', '该密钥没有已验证的市场权限。')
      const previousId = history.claim(environment, id, issuer, apiKey, legacyOwner)
      const account = connected.get(id) ?? { id, uid, issuer, environment, name: '币安 UID ' + uid }
      const now = Date.now()
      const replaced = new Set()
      for (const market of markets) {
        const previous = account[market]
        if (granted.includes(market)) {
          if (!previous && market === 'futures') account.futuresConnectedAt = now
          if (previous && (previous.apiKey !== apiKey || previous.apiSecret !== apiSecret)) replaced.add(market)
          account[market] = { apiKey, apiSecret }
        } else if (previous?.apiKey === apiKey && !unavailableMarkets.includes(market)) {
          replaced.add(market)
          delete account[market]
          if (market === 'futures') delete account.futuresConnectedAt
        }
      }
      connected.set(id, account)
      // A previous token cannot gain a replacement key's rights. Tokens for
      // disjoint markets stay valid with their original verified scope.
      for (const [token, session] of sessions) {
        if (session.id === id && replaced.size) session.markets = session.markets.filter(m => !replaced.has(m))
        if (!session.markets.length || session.expiresAt <= now) sessions.delete(token)
      }
      const token = 'bs_' + randomBytes(32).toString('base64url')
      const session = { id, uid, issuer, name: account.name, environment, expiresAt: now + lifetime, markets: granted }
      sessions.set(token, session)
      return { ...session, token, ...(issuer === 'live' ? { previousWorkspaceId: previousId } : {}) }
    },

    resolveSession(environment, token) {
      const session = sessions.get(token)
      if (!session || session.environment !== environment) return null
      if (session.expiresAt <= Date.now()) {
        sessions.delete(token)
        return null
      }
      return tradingUser(connected.get(session.id), [...session.markets])
    },

    getUserById(environment, id) {
      const account = connected.get(id)
      if (!account || account.environment !== environment) return null
      return tradingUser(account, markets.filter(m => account[m]))
    },

    revoke(environment, token) {
      return sessions.get(token)?.environment === environment && sessions.delete(token)
    },

    connectedOwners(environment, market) {
      return [...connected.values()].filter(a => a.environment === environment && a[market]).map(a => a.id)
    },

    hasAccounts(environment) {
      return [...connected.values()].some(a => a.environment === environment)
    },

    clear() { sessions.clear(); connected.clear() },
  }
}
