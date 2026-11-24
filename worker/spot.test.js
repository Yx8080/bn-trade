import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { handleSpot } from './spot.js'
import { createLocalOrderDb } from './local-orders.js'

const user = { id: 'alice', name: 'Alice', token: 'spot-test-token',
  spotApiKey: 'spot-test-key', spotApiSecret: 'spot-test-secret', apiKey: 'different-futures-key', apiSecret: 'different-futures-secret' }
const config = { BINANCE_FUTURES_USERS: JSON.stringify([user]) }
const buy = { symbol: 'ETHUSDT', quoteOrderQty: '25.50', clientOrderId: 'spot-1', environment: 'testnet' }

function send(path, body, env = config) {
  const request = new Request('https://local.test/api/spot/' + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return handleSpot(request, env)
}

function signedParams(url, init) {
  assert.equal(url.origin, 'https://testnet.binance.vision')
  assert.equal(init.headers.get('X-MBX-APIKEY'), user.spotApiKey)
  assert.equal(init.headers.has('Authorization'), false)
  const params = new URLSearchParams(init.body ?? url.search)
  const signature = params.get('signature')
  params.delete('signature')
  assert.equal(createHmac('sha256', user.spotApiSecret).update(params.toString()).digest('hex'), signature)
  return params
}

test('spot quote uses the configured public spot market', async t => {
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.href, 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')
    assert.equal(init.headers.has('X-MBX-APIKEY'), false)
    return Response.json({ symbol: 'ETHUSDT', price: '2300.11' })
  })
  const answer = await send('quote?symbol=ETHUSDT&environment=live')
  assert.equal(answer.status, 200)
  const quote = await answer.json()
  assert.equal(quote.lastPrice, '2300.11')
  assert.equal(quote.environment, 'live')
  assert.ok(quote.time > 0)
})

test('spot balances include locked funds and are signed with the user’s separate spot credential', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.pathname, '/api/v3/account')
    assert.equal(signedParams(url, init).get('omitZeroBalances'), 'true')
    return Response.json({ balances: [{ asset: 'BTC', free: '0', locked: '0.125' }, { asset: 'ETH', free: '0', locked: '0' }] })
  })
  const account = await send('account')
  assert.deepEqual(await account.json(), { name: user.name, environment: 'testnet', balances: [{ asset: 'BTC', free: '0', locked: '0.125' }] })
  const futuresOnly = { ...user, spotApiKey: undefined, spotApiSecret: undefined }
  const unavailable = await send('account', undefined, { BINANCE_FUTURES_USERS: JSON.stringify([futuresOnly]) })
  assert.equal((await unavailable.json()).code, 'SPOT_NOT_CONFIGURED')
  assert.equal(upstream.mock.callCount(), 1)
})

test('spot buy spends the requested quote amount once and can query the resulting average fill price', async t => {
  const database = createLocalOrderDb(':memory:')
  t.after(() => database.close())
  const env = { ...config, orderStore: database }
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.pathname, '/api/v3/order')
    const params = signedParams(url, init)
    if (init.method === 'POST') {
      assert.equal(params.get('side'), 'BUY')
      assert.equal(params.get('type'), 'MARKET')
      assert.equal(params.get('newOrderRespType'), 'RESULT')
      assert.equal(params.get('quoteOrderQty'), '25.50')
      assert.equal(params.has('quantity'), false)
    } else {
      assert.equal(params.get('origClientOrderId'), buy.clientOrderId)
    }
    return new Response('{"symbol":"ETHUSDT","orderId":9223372036854701111,"clientOrderId":"spot-1","status":"FILLED","side":"BUY","type":"MARKET","executedQty":"0.010","cummulativeQuoteQty":"25.49000"}')
  })
  const placed = await send('orders', buy, env)
  const receipt = await placed.json()
  assert.equal(placed.status, 201)
  assert.equal(receipt.avgPrice, '2549')
  assert.equal(receipt.orderId, '9223372036854701111')
  assert.equal((await send('orders', buy, env)).status, 409)
  const fetched = await send('orders?symbol=ETHUSDT&clientOrderId=spot-1', undefined, env)
  assert.deepEqual(await fetched.json(), receipt)
  assert.equal(upstream.mock.callCount(), 2)
})

test('spot only accepts an environment-confirmed market buy with an exact positive quote amount', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upstream order'))
  for (const edits of [{ quantity: '2' }, { side: 'SELL' }, { quoteOrderQty: '-1' }, { quoteOrderQty: '0.0' }]) {
    assert.equal((await send('orders', { ...buy, ...edits })).status, 400)
  }
  assert.equal((await send('orders', { ...buy, environment: 'live' })).status, 409)
  assert.equal(upstream.mock.callCount(), 0)
})

test('incomplete spot acknowledgments preserve the customer ID for lookup', async t => {
  const database = createLocalOrderDb(':memory:')
  t.after(() => database.close())
  const env = { ...config, orderStore: database }
  const upstream = t.mock.method(globalThis, 'fetch', () => Response.json({ orderId: 12 }))
  assert.equal((await (await send('orders', buy, env)).json()).code, 'ORDER_UNKNOWN')
  assert.equal((await send('orders', buy, env)).status, 409)
  assert.equal(upstream.mock.callCount(), 1)
})
