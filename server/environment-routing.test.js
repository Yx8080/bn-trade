import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createApiMiddleware } from './api.js'

async function serve(t, env, exchange) {
  const localFetch = globalThis.fetch.bind(globalThis)
  t.mock.method(globalThis, 'fetch', exchange)
  const api = createApiMiddleware({ env: { ...env, NO_PROXY: '*' }, databaseFile: ':memory:' })
  const server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await api.close()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/api/'
  return (path, environment, token, body, method = body ? 'POST' : 'GET') => localFetch(base + path, {
    method, headers: { ...(environment && { 'X-Trading-Environment': environment }),
      ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  })
}

test('requests for a retired environment never reach Binance; all unlabeled requests use live', async t => {
  const requests = []
  const call = await serve(t, { BINANCE_FUTURES_ENV: 'testnet', BINANCE_FUTURES_USERS: JSON.stringify([
    { id: 'legacy', name: 'Legacy', token: 'old-session', apiKey: 'old-key', apiSecret: 'secret' }]) }, (url, init) => {
    requests.push(url.hostname)
    if (url.pathname === '/api/v3/ticker/price') return Response.json({ symbol: 'BTCUSDT', price: '100' })
    assert.equal(init.headers.get('X-MBX-APIKEY'), 'fixture')
    return Response.json(url.pathname === '/fapi/v3/account' ? { assets: [] } : { balances: [], uid: 1314 })
  })
  const policy = { credentialStorage: 'memory', identity: 'binance-uid' }
  assert.deepEqual(await (await call('accounts/bind')).json(), { environment: 'live', ...policy })
  assert.equal((await call('accounts/bind', 'testnet')).status, 400)
  assert.equal((await call('accounts/bind', 'invalid')).status, 400)
  assert.equal((await call('spot/quote?symbol=BTCUSDT&environment=live&environment=testnet')).status, 409)
  const bind = { apiKey: 'fixture', apiSecret: 'secret', environment: 'live', identity: 'binance-uid' }
  assert.equal((await call('accounts/bind', 'live', null, { ...bind, environment: 'testnet' })).status, 409)
  assert.equal((await call('futures/session', undefined, 'old-session')).status, 401)
  assert.deepEqual(requests, [])
  const quote = await (await call('spot/quote?symbol=BTCUSDT')).json()
  assert.equal(quote.environment, 'live')
  assert.equal(requests.pop(), 'api.binance.com')
  const response = await call('accounts/bind', 'live', null, bind)
  assert.equal(response.status, 200)
  const session = await response.json()
  assert.equal(session.issuer, 'live')
  assert.equal(session.id, 'uid:1314')
  assert.deepEqual(requests.sort(), ['api.binance.com', 'fapi.binance.com'])
  assert.equal((await call('accounts/session', 'testnet', session.token, null, 'DELETE')).status, 400)
  assert.equal((await call('futures/session', 'live', session.token)).status, 200)
  assert.equal((await call('accounts/session', 'live', session.token, null, 'DELETE')).status, 204)
  assert.equal((await call('futures/session', 'live', session.token)).status, 401)
})

test('live copy execution and platform settlement continue after logout', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const leaders = []
  const amount = '20'
  const environment = 'live'
  const call = await serve(t, {}, (url, init) => {
    if (url.hostname === 'www.binance.com') {
      const { portfolioId } = JSON.parse(init.body)
      if (portfolioId === amount) leaders.push(portfolioId)
      return Response.json({ code: '000000', data: { list: [], total: 0 } })
    }
    assert.ok(['api.binance.com', 'fapi.binance.com'].includes(url.hostname))
    assert.equal(init.headers.get('X-MBX-APIKEY'), 'live-fixture')
    switch (url.pathname) {
      case '/api/v3/account': return Response.json({ balances: [], uid: 201 })
      case '/fapi/v3/account': return Response.json({ assets: [] })
      case '/fapi/v1/positionSide/dual': return Response.json({ dualSidePosition: false })
      case '/fapi/v3/positionRisk': return Response.json([])
      case '/api/v3/order':
        assert.equal(init.method, 'POST')
        assert.equal(new URLSearchParams(init.body).get('quoteOrderQty'), amount)
        return Response.json({ clientOrderId: 'same-client', orderId: '42', symbol: 'BTCUSDT', side: 'BUY',
          type: 'MARKET', status: 'FILLED', executedQty: '1', cummulativeQuoteQty: amount })
      case '/api/v3/myTrades':
        return Response.json([{ id: '7', orderId: '42', symbol: 'BTCUSDT', price: amount, qty: '1', quoteQty: amount,
          time: Date.now(), isBuyer: true, commission: '0', commissionAsset: 'USDT' }])
      default: throw Error('Unexpected mock exchange route')
    }
  })
  const login = async () => {
    const apiKey = 'live-fixture'
    const res = await call('accounts/bind', environment, null, { environment, apiKey, apiSecret: 'fixture-secret' })
    assert.equal(res.status, 200)
    return (await res.json()).token
  }
  {
    const token = await login()
    const config = { portfolioIds: [amount], leverage: 1, sizingMode: 'margin', amount: 10, repeat: 'first', maxEntries: 1, maxPositions: 1, stopLoss: 5 }
    assert.equal((await call('futures/copy', environment, token, { action: 'start', environment, config })).status, 200)
    const order = { symbol: 'BTCUSDT', quoteOrderQty: amount, clientOrderId: 'same-client', environment }
    assert.equal((await call('spot/orders', environment, token, { ...order, environment: 'testnet' })).status, 409)
    assert.equal((await call('spot/orders', environment, token, order)).status, 201)
    assert.equal((await call('accounts/session', environment, token, null, 'DELETE')).status, 204)
  }
  t.mock.timers.tick(5000)
  {
    const token = await login()
    let report, strategy
    for (let attempt = 0; attempt < 25; attempt++) {
      report = await (await call('platform/pnl', environment, token)).json()
      strategy = await (await call('futures/copy', environment, token)).json()
      if (report.pendingCount === 0 && strategy.lastCheck) break
      await setImmediate()
    }
    assert.equal(strategy.enabled, true)
    assert.ok(strategy.lastCheck)
    assert.deepEqual(strategy.config.portfolioIds, [amount])
    assert.equal(report.pendingCount, 0)
    assert.deepEqual(report.rows.map(row => row.quote), [Number(amount)])
  }
  assert.deepEqual(leaders, [amount])
})

test('a configured token with different signed UIDs can select a market but cannot combine the two account histories', async t => {
  const config = { id: 'pre-uid-owner', name: '历史账户', token: 'configured-fixture',
    apiKey: 'futures-key', apiSecret: 'futures-secret', spotApiKey: 'spot-key', spotApiSecret: 'spot-secret' }
  const call = await serve(t, { BINANCE_FUTURES_ENV: 'live', BINANCE_FUTURES_USERS: JSON.stringify([config]) }, (url, init) => {
    const key = init.headers.get('X-MBX-APIKEY')
    if (url.pathname === '/fapi/v3/account') {
      assert.equal(key, config.apiKey)
      return Response.json({ assets: [] })
    }
    assert.equal(url.pathname, '/api/v3/account')
    assert.ok(url.searchParams.has('signature'))
    return Response.json({ uid: key === config.spotApiKey ? 19 : 91, balances: [] })
  })
  for (const path of ['futures/session', 'platform/pnl']) {
    const response = await call(path, 'live', config.token)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'UID_MISMATCH')
  }
  assert.equal((await call('futures/copy-pnl', 'live', config.token)).status, 200)
  const spot = await call('spot/account', 'live', config.token)
  assert.equal(spot.status, 200)
  assert.equal((await spot.json()).name, '币安 UID 19')
})

test('self-binding a replacement key recovers pending and settled manual orders only for their verified UID', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const call = await serve(t, {}, (url, init) => {
    const key = init.headers.get('X-MBX-APIKEY')
    switch (url.pathname) {
      case '/fapi/v3/account': return Response.json({ code: -2015 }, { status: 401 })
      case '/api/v3/account': return Response.json({ balances: [], uid: key === 'unrelated' ? 88002 : 88001 })
      case '/api/v3/order':
        assert.equal(key, 'original')
        assert.equal(init.method, 'POST')
        return Response.json({ clientOrderId: 'uid-recovery', orderId: '82', symbol: 'BTCUSDT', side: 'BUY',
          type: 'MARKET', status: 'FILLED', executedQty: '2', cummulativeQuoteQty: '30' })
      case '/api/v3/myTrades':
        assert.equal(key, 'rotated')
        assert.equal(url.searchParams.get('orderId'), '82')
        return Response.json([{ id: '17', orderId: '82', symbol: 'BTCUSDT', price: '15', qty: '2', quoteQty: '30',
          time: Date.now(), isBuyer: true, commission: '0.03', commissionAsset: 'USDT' }])
      default: throw Error('Unexpected mock exchange route')
    }
  })
  async function bind(apiKey) {
    const response = await call('accounts/bind', 'live', null, { environment: 'live', identity: 'binance-uid',
      apiKey, apiSecret: 'fixture-secret-' + apiKey })
    assert.equal(response.status, 200)
    return (await response.json()).token
  }
  async function report(token) {
    const response = await call('platform/pnl', 'live', token)
    assert.equal(response.status, 200)
    return response.json()
  }

  const original = await bind('original')
  const order = { environment: 'live', symbol: 'BTCUSDT', clientOrderId: 'uid-recovery', quoteOrderQty: '30' }
  assert.equal((await call('spot/orders', 'live', original, order)).status, 201)
  assert.equal((await call('accounts/session', 'live', original, null, 'DELETE')).status, 204)
  const rotated = await bind('rotated')
  assert.equal((await report(rotated)).pendingCount, 1)
  const unrelated = await bind('unrelated')
  assert.equal((await report(unrelated)).pendingCount, 0)

  t.mock.timers.tick(5000)
  let settled = await report(rotated)
  for (let i = 0; i < 25 && settled.pendingCount; i++) {
    await setImmediate()
    settled = await report(rotated)
  }
  assert.equal(settled.pendingCount, 0)
  assert.deepEqual(settled.rows.map(row => [row.clientOrderId, row.quantity, row.quote]), [['uid-recovery', 2, 30]])
  assert.deepEqual(settled.totals.map(row => [row.asset, row.fees]), [['USDT', 0.03]])
  const recovered = await report(await bind('rotated-again'))
  assert.deepEqual(recovered.rows, settled.rows)
  assert.deepEqual(recovered.totals, settled.totals)
  const separate = await report(unrelated)
  assert.deepEqual(separate.rows, [])
  assert.deepEqual(separate.totals, [])
})
