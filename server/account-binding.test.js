import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import worker from '../worker/index.js'
import { getTradingUserById } from '../worker/trading.js'
import { accountBinding } from './account-binding.js'
import { createCopyService } from './copy-service.js'
import { createPlatformSettlement } from './platform-settlement.js'

const input = { environment: 'testnet', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' }
function request(path, { method = 'GET', data, token, headers = {} } = {}) {
  return new Request('http://localhost/api/' + path, { method, headers: {
    'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }), ...headers,
  }, body: data === undefined ? undefined : JSON.stringify(data) })
}
const bind = (env, data = input, headers) => accountBinding(request('accounts/bind', { method: 'POST', data, headers }), env)
const dbFor = t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  return db
}
const denied = () => Response.json({ code: -2015, msg: 'upstream detail' }, { status: 401 })

test('binding signs read-only account probes and scopes/revokes a new session without administrator setup', async t => {
  const calls = []
  const env = { orderStore: dbFor(t), async fetchBinance(url, init) {
    calls.push(url.origin + url.pathname)
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.get('X-MBX-APIKEY'), input.apiKey)
    const query = new URLSearchParams(url.search)
    const signature = query.get('signature')
    query.delete('signature')
    assert.equal(signature, createHmac('sha256', input.apiSecret).update(query.toString()).digest('hex'))
    assert.ok(!url.href.includes(input.apiKey) && !url.href.includes(input.apiSecret))
    return url.pathname === '/fapi/v3/account' ? denied() : Response.json({ uid: 31415, balances: [] })
  } }
  const res = await bind(env, { ...input, identity: 'binance-uid' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const session = await res.json()
  assert.deepEqual(session.markets, ['spot'])
  assert.equal(session.uid, '31415')
  assert.deepEqual(calls.sort(), ['https://demo-fapi.binance.com/fapi/v3/account', 'https://testnet.binance.vision/api/v3/account'])
  assert.ok(!JSON.stringify(session).includes(input.apiKey) && !JSON.stringify(session).includes(input.apiSecret))
  assert.equal((await worker.fetch(request('spot/account', session), env)).status, 200)
  assert.equal((await worker.fetch(request('futures/account', session), env)).status, 503)
  const copy = createCopyService(env)
  try { assert.equal((await copy.fetch(request('futures/copy', session))).status, 403) }
  finally { await copy.close() }
  const revoke = await accountBinding(request('accounts/session', { method: 'DELETE', token: session.token }), env)
  assert.equal(revoke.status, 204)
  assert.equal((await worker.fetch(request('futures/session', session), env)).status, 401)
  // Older API clients omit the handshake marker and receive the same verified identity.
  const again = await (await bind(env)).json()
  assert.equal(again.id, session.id)
  assert.notEqual(again.token, session.token)
})

test('environment confirmation, browser transport, invalid/missing credentials and exchange failures leave no binding', async t => {
  const env = { orderStore: dbFor(t), fetchBinance: () => { throw Error('unexpected') } }
  const get = await accountBinding(request('accounts/bind'), env)
  assert.deepEqual(await get.json(), { environment: 'testnet', credentialStorage: 'memory', identity: 'binance-uid' })
  assert.equal((await bind(env, { ...input, environment: 'live' })).status, 409)
  for (const identity of ['key-hash', '', null]) {
    const response = await bind(env, { ...input, identity })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'BINDING_POLICY_MISMATCH')
  }
  for (const extra of [{ apiSecret: '' }, { apiKey: 'line\nbreak' }, { id: 'forged' }, { uid: '1' }, { issuer: 'live' }, { markets: ['futures'] }])
    assert.equal((await bind(env, { ...input, ...extra })).status, 400)
  assert.equal((await bind(env, input, { Origin: 'http://192.0.2.1' })).status, 403)
  assert.equal((await bind(env, input, { Origin: 'https://example.org', 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  for (const [fetchBinance, code] of [
    [() => Response.json({ code: -2015, msg: input.apiSecret }, { status: 401 }), 'BINDING_REJECTED'],
    [() => Response.json({ code: -1003 }, { status: 418 }), 'BINDING_RATE_LIMITED'],
    [() => Response.json({ code: -1021 }, { status: 400 }), 'BINDING_UNAVAILABLE'],
    [() => Response.json({ unexpected: [] }), 'BINDING_UNAVAILABLE'],
  ]) {
    const error = await (await bind({ ...env, fetchBinance })).json()
    assert.equal(error.code, code)
    assert.ok(!JSON.stringify(error).includes(input.apiSecret))
  }
  assert.equal(env.orderStore.accounts.hasAccounts('testnet'), false)
})

test('independent legacy keys resume their own markets and cannot operate the other key’s strategy', async t => {
  const legacy = { id: 'old-owner', name: '已有账户', token: 'legacy', apiKey: input.apiKey, apiSecret: input.apiSecret,
    spotApiKey: 'legacy-spot-key', spotApiSecret: 'legacy-spot-secret' }
  const env = { orderStore: dbFor(t), BINANCE_FUTURES_ENV: 'live', BINANCE_FUTURES_USERS: JSON.stringify([legacy]), fetchBinance: (url, init) => {
    if (url.pathname === '/api/v3/account') return Response.json({ uid: 31415, balances: [] })
    if (url.pathname === '/fapi/v3/account' && init.headers.get('X-MBX-APIKEY') === legacy.apiKey) return Response.json({ assets: [] })
    return denied()
  } }
  const futures = await (await bind(env, { ...input, environment: 'live' })).json()
  const spot = await (await bind(env, { environment: 'live', apiKey: legacy.spotApiKey, apiSecret: legacy.spotApiSecret })).json()
  assert.equal(futures.uid, '31415')
  assert.equal(spot.id, futures.id)
  delete env.BINANCE_FUTURES_USERS
  assert.deepEqual(futures.markets, ['futures'])
  assert.deepEqual(spot.markets, ['spot'])
  const background = getTradingUserById(env, futures.id)
  assert.equal(background.apiKey, legacy.apiKey)
  assert.equal(background.spotApiKey, legacy.spotApiKey)
  const copy = createCopyService(env)
  try {
    assert.equal((await copy.fetch(request('futures/copy', futures))).status, 200)
    assert.equal((await copy.fetch(request('futures/copy', spot))).status, 403)
  } finally { await copy.close() }
  assert.equal((await worker.fetch(request('spot/account', futures), env)).status, 503)
  assert.equal((await worker.fetch(request('spot/account', spot), env)).status, 200)
})

test('a disconnected bound account can settle a platform spot order without administrator config', async t => {
  const env = { orderStore: dbFor(t), fetchBinance: (url, init) => {
    if (url.pathname === '/fapi/v3/account') return denied()
    if (url.pathname === '/api/v3/account') return Response.json({ balances: [], uid: 31415 })
    if (url.pathname === '/api/v3/order' && init.method === 'POST') return Response.json({
      symbol: 'BTCUSDT', orderId: '123', clientOrderId: 'spot-fixture', side: 'BUY', type: 'MARKET',
      status: 'FILLED', executedQty: '2', cummulativeQuoteQty: '20' })
    assert.equal(url.pathname, '/api/v3/myTrades')
    return Response.json([{ symbol: 'BTCUSDT', orderId: '123', id: 44, time: Date.now(), isBuyer: true,
      price: '10', qty: '2', quoteQty: '20', commission: '0.01', commissionAsset: 'USDT' }])
  } }
  const session = await (await bind(env)).json()
  assert.equal((await worker.fetch(request('spot/orders', { ...session, method: 'POST', data: {
    environment: 'testnet', quoteOrderQty: '20', symbol: 'BTCUSDT', clientOrderId: 'spot-fixture' } }), env)).status, 201)
  await accountBinding(request('accounts/session', { ...session, method: 'DELETE' }), env)
  const settlement = createPlatformSettlement(env)
  try { await settlement.poll() } finally { await settlement.close() }
  const report = env.orderStore.platform.report('testnet', session.id)
  assert.equal(report.pendingCount, 0)
  assert.equal(report.rows[0].quantity, 2)
  assert.equal(report.totals[0].fees, 0.01)
})

test('exchange UID is lossless across API key rotation and separates accounts with adjacent 64-bit UIDs', async t => {
  const live = { ...input, environment: 'live' }
  const env = { orderStore: dbFor(t), BINANCE_FUTURES_ENV: 'live', fetchBinance(url, init) {
    if (url.pathname === '/fapi/v3/account') return Response.json({ assets: [] })
    const uid = init.headers.get('X-MBX-APIKEY') === 'different-owner' ? '9007199254740993' : '9007199254740992'
    return new Response('{"balances":[],"uid":' + uid + '}')
  } }
  const first = await (await bind(env, live)).json()
  const rotated = await (await bind(env, { ...live, apiKey: 'rotation', apiSecret: 'new-secret' })).json()
  const other = await (await bind(env, { ...live, apiKey: 'different-owner' })).json()
  assert.equal(first.uid, '9007199254740992')
  assert.equal(rotated.id, first.id)
  assert.notEqual(other.id, first.id)
  assert.equal(other.uid, '9007199254740993')
})

test('signed account read must disclose a valid UID even when futures access has passed', async t => {
  const env = { orderStore: dbFor(t), BINANCE_FUTURES_ENV: 'live' }
  for (const uid of [undefined, null, 0, -1, 0.5, '00', '1e5', '', {}, ' 123']) {
    env.fetchBinance = url => Response.json(url.pathname === '/fapi/v3/account' ? { assets: [] } : { balances: [], uid })
    const result = await bind(env, { ...input, environment: 'live' })
    assert.equal((await result.json()).code, 'UID_UNAVAILABLE')
  }
  env.fetchBinance = url => url.pathname === '/fapi/v3/account' ? Response.json({ assets: [], accountAlias: '767' }) : denied()
  assert.equal((await (await bind(env, { ...input, environment: 'live' })).json()).code, 'UID_UNAVAILABLE')
  env.fetchBinance = url => Response.json(url.pathname === '/fapi/v3/account' ? { assets: [], uid: 51 } : { balances: [], uid: 52 })
  assert.equal((await (await bind(env, { ...input, environment: 'live' })).json()).code, 'UID_MISMATCH')
  assert.equal(env.orderStore.accounts.hasAccounts('live'), false)
})

test('testnet issuer follows the actual trading venue and Demo identity never grants Spot Test Network access', async t => {
  const env = { orderStore: dbFor(t), fetchBinance(url, init) {
    const key = init.headers.get('X-MBX-APIKEY')
    if (url.hostname === 'testnet.binance.vision' && key === 'demo-account') return denied()
    if (url.hostname === 'demo-fapi.binance.com') return key === 'spot-network-account' ? denied() : Response.json({ assets: [] })
    assert.equal(url.pathname, '/api/v3/account')
    assert.ok(['testnet.binance.vision', 'demo-api.binance.com'].includes(url.hostname))
    return Response.json({ balances: [], uid: 4567 })
  } }
  const demo = await (await bind(env, { ...input, apiKey: 'demo-account' })).json()
  const spot = await (await bind(env, { ...input, apiKey: 'spot-network-account' })).json()
  assert.deepEqual(demo.markets, ['futures'])
  assert.deepEqual(spot.markets, ['spot'])
  assert.equal(demo.uid, spot.uid)
  assert.notEqual(demo.id, spot.id)
  assert.equal((await (await bind(env, { ...input, apiKey: 'ambiguous' })).json()).code, 'UID_MISMATCH')
})
