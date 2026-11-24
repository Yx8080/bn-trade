import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { handleFutures } from './futures.js'
import { createLocalOrderDb } from './local-orders.js'

const users = ['alice', 'bob'].map(name => ({
  id: name, name, token: name + '-test-token', apiKey: name + '-test-key', apiSecret: name + '-test-secret',
}))
const config = { BINANCE_FUTURES_USERS: JSON.stringify(users) }
const order = {
  environment: 'testnet', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH',
  type: 'LIMIT', quantity: '0.002', price: '60001.50', clientOrderId: 'intent-1',
}

function send(path, user, body, env = config) {
  const headers = {}
  if (user) headers.Authorization = 'Bearer ' + user.token
  if (body) headers['Content-Type'] = 'application/json'
  return handleFutures(new Request('https://local.test/api/futures/' + path, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
  }), env)
}

function verifySignature(url, init, user) {
  const params = new URLSearchParams(init.body ?? url.search)
  const signature = params.get('signature')
  params.delete('signature')
  assert.equal(createHmac('sha256', user.apiSecret).update(params.toString()).digest('hex'), signature)
  assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
  assert.equal(init.headers.has('Authorization'), false)
  return params
}

test('authentication selects one configured account without returning its credentials', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upstream request'))
  assert.equal((await send('session', null)).status, 401)
  assert.equal((await send('session', { token: 'unknown' })).status, 401)
  const session = await send('session?id=alice', users[1])
  assert.deepEqual(await session.json(), { id: 'bob', name: 'bob', environment: 'testnet' })
  const duplicates = { ...config, BINANCE_FUTURES_USERS: JSON.stringify([users[0], { ...users[1], apiKey: users[0].apiKey }]) }
  assert.equal((await send('session', users[1], undefined, duplicates)).status, 503)
  const rotated = { ...config, BINANCE_FUTURES_USERS: JSON.stringify([{ ...users[1], token: 'new-bob-token' }]) }
  assert.equal((await send('session', users[1], undefined, rotated)).status, 401)
  assert.equal((await send('session', { token: 'new-bob-token' }, undefined, rotated)).status, 200)
  assert.equal(upstream.mock.callCount(), 0)
})

test('public quote pairs a futures ticker with its mark and source timestamps', async t => {
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.headers.has('X-MBX-APIKEY'), false)
    assert.equal(url.origin, 'https://fapi.binance.com')
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
    return Response.json(url.pathname === '/fapi/v2/ticker/price'
      ? { symbol: 'BTCUSDT', price: '90000.1', time: 123 }
      : { symbol: 'BTCUSDT', markPrice: '90001.2', time: 456 })
  })
  const response = await send('quote?symbol=BTCUSDT&environment=live', null)
  assert.deepEqual(await response.json(), {
    symbol: 'BTCUSDT', lastPrice: '90000.1', lastTime: 123, markPrice: '90001.2', time: 456, environment: 'live',
  })
  assert.equal((await send('quote?symbol=BTCUSDT&environment=other', null)).status, 400)
})

test('account reports wallet, available balance and exchange-valued open positions only for the authenticated identity', async t => {
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.origin, 'https://demo-fapi.binance.com')
    verifySignature(url, init, users[1])
    return Response.json(url.pathname === '/fapi/v3/account' ? {
      assets: [{ asset: 'USDT', walletBalance: '14', availableBalance: '8.9' }],
    } : [
      { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-0.001', entryPrice: '90000', markPrice: '90800',
        unRealizedProfit: '-0.8', marginAsset: 'USDT', updateTime: 123 },
      { symbol: 'ETHUSDT', positionAmt: '0' },
      { symbol: 'BTCUSDC', positionSide: 'LONG', positionAmt: '1', entryPrice: '90000', markPrice: '91000',
        unRealizedProfit: '1000', marginAsset: 'USDC', updateTime: 123 },
    ])
  })
  const response = await send('account?userId=alice', users[1])
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), {
    name: 'bob', environment: 'testnet', balances: [{ asset: 'USDT', walletBalance: '14', availableBalance: '8.9' }],
    positions: [{ symbol: 'BTCUSDT', positionSide: 'SHORT', quantity: '-0.001', entryPrice: '90000',
      markPrice: '90800', unrealizedPnl: '-0.8', marginAsset: 'USDT', updateTime: 123 },
    { symbol: 'BTCUSDC', positionSide: 'LONG', quantity: '1', entryPrice: '90000',
      markPrice: '91000', unrealizedPnl: '1000', marginAsset: 'USDC', updateTime: 123 }],
  })
})

test('signed limit orders retain exact decimals and 64-bit IDs, including concurrent duplicate submissions', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const env = { ...config, orderStore: db }
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.origin, 'https://demo-fapi.binance.com')
    assert.equal(url.pathname, '/fapi/v1/order')
    const params = verifySignature(url, init, users[0])
    assert.equal(init.method, 'POST')
    assert.equal(params.get('price'), '60001.50')
    assert.equal(params.get('quantity'), '0.002')
    assert.equal(params.get('timeInForce'), 'GTC')
    assert.equal(params.get('newClientOrderId'), 'intent-1')
    return new Response('{"symbol":"BTCUSDT","clientOrderId":"intent-1","orderId":90071992547409935,"status":"NEW","type":"LIMIT","side":"BUY","executedQty":"0","avgPrice":"0"}')
  })
  const pair = await Promise.all([send('orders', users[0], order, env), send('orders', users[0], order, env)])
  const accepted = pair.find(response => response.status === 201)
  const duplicate = pair.find(response => response.status === 409)
  assert.equal((await accepted.json()).orderId, '90071992547409935')
  assert.equal((await duplicate.json()).code, 'ORDER_UNKNOWN')
  assert.equal(upstream.mock.callCount(), 1)
})

test('uncertain orders can be queried by their original customer ID without another submit', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const env = { ...config, orderStore: db }
  const market = { ...order, type: 'MARKET', price: undefined, side: 'SELL', positionSide: 'LONG' }
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    const params = verifySignature(url, init, users[0])
    if (init.method === 'POST') {
      assert.equal(params.has('price'), false)
      assert.equal(params.has('reduceOnly'), false)
      assert.equal(params.get('positionSide'), 'LONG')
      return new Response('<gateway timeout>', { status: 504 })
    }
    assert.equal(params.get('origClientOrderId'), market.clientOrderId)
    return Response.json({
      symbol: 'BTCUSDT', clientOrderId: market.clientOrderId, orderId: 55, status: 'FILLED', side: 'SELL',
      type: 'MARKET', executedQty: '0.002', avgPrice: '90000',
    })
  })
  assert.equal((await (await send('orders', users[0], market, env)).json()).code, 'ORDER_UNKNOWN')
  assert.equal((await send('orders', users[0], market, env)).status, 409)
  const lookup = await send('orders?symbol=BTCUSDT&clientOrderId=intent-1', users[0], undefined, env)
  assert.equal((await lookup.json()).status, 'FILLED')
  assert.equal(upstream.mock.callCount(), 2)
})

test('invalid or unconfigured orders do not reach Binance', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upstream request'))
  assert.equal((await send('orders', users[0], order)).status, 503)
  for (const edits of [{ quantity: '1e3' }, { reduceOnly: true, positionSide: 'SHORT' }, { price: '0' }, { userId: 'bob' }]) {
    assert.equal((await send('orders', users[0], { ...order, ...edits })).status, 400)
  }
  assert.equal((await send('orders', users[0], { ...order, environment: 'live' })).status, 409)
  assert.equal(upstream.mock.callCount(), 0)
})
