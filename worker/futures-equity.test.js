import assert from 'node:assert/strict'
import test from 'node:test'
import { handleFutures } from './futures.js'

const user = { id: 'desk', name: 'desk', token: 'fixture-token', apiKey: 'fixture-key', apiSecret: 'fixture-secret' }
function read(path, fetchBinance, token = user.token) {
  const env = { BINANCE_FUTURES_USERS: JSON.stringify([user]), fetchBinance }
  return handleFutures(new Request('http://localhost/api/futures/' + path, { headers: { Authorization: 'Bearer ' + token } }), env)
}

test('equity uses the whole account margin balance; multi-assets USD equity is converted into USDT', async () => {
  for (const multi of [false, true]) {
    const paths = []
    const result = await read('equity', (url, init) => {
      paths.push(url.pathname)
      if (url.pathname === '/fapi/v2/account') {
        assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
        return Response.json({ totalMarginBalance: '1010', availableBalance: '200', totalWalletBalance: '1000', multiAssetsMargin: multi })
      }
      assert.equal(init.headers.has('X-MBX-APIKEY'), false)
      assert.equal(url.searchParams.get('symbol'), 'USDTUSD')
      return Response.json({ symbol: 'USDTUSD', index: '1.01' })
    })
    const snapshot = await result.json()
    assert.equal(result.status, 200)
    assert.equal(snapshot.equity, multi ? 1000 : 1010)
    assert.equal(snapshot.asset, 'USDT')
    assert.equal(paths.length, multi ? 2 : 1)
  }
  assert.equal((await read('equity', () => assert.fail('private request without identity'), 'invalid')).status, 401)
  assert.equal((await read('equity', () => Response.json({ availableBalance: '100', multiAssetsMargin: false }))).status, 502)
})

test('manual sizing computes margin from fresh equity and rounds the confirmed quantity down to the relevant lot step', async () => {
  for (const [mode, type, qty] of [['margin', 'LIMIT', '1.234'], ['equityPercent', 'MARKET', '2.46']]) {
    const calls = []
    const resp = await read('order-size?' + new URLSearchParams({ environment: 'live', symbol: 'ETHUSDT', type,
      price: '100', mode, amount: mode === 'margin' ? '12.349' : '2', leverage: '10' }), url => {
      calls.push(url.pathname)
      if (url.pathname === '/fapi/v2/account') return Response.json({ totalMarginBalance:'1234.9', multiAssetsMargin:false,
        assets: [{ asset: 'USDT', availableBalance: '95.66886394' }] })
      assert.equal(url.pathname, '/fapi/v1/exchangeInfo')
      return Response.json({ symbols: [{ symbol:'ETHUSDT', status:'TRADING', quoteAsset:'USDT', orderTypes:['MARKET','LIMIT'],
        filters: [{ filterType:'LOT_SIZE', stepSize:'0.001', minQty:'0.001', maxQty:'100' },
          { filterType:'MARKET_LOT_SIZE', stepSize:'0.01', minQty:'0.01', maxQty:'50' },
          { filterType:'MIN_NOTIONAL', notional:'5' }] }] })
    })
    assert.equal(resp.status, 200)
    assert.equal((await resp.json()).quantity, qty)
    assert.equal(calls.includes('/fapi/v2/account'), true)
  }
})

test('manual sizing checks USDT available to open and excludes the matching one-way closing portion', async () => {
  async function preview(amount, available, side, positionSide = 'BOTH') {
    const query = new URLSearchParams({ environment: 'live', symbol: 'ETHUSDT', type: 'LIMIT', price: '100',
      mode: 'margin', leverage: '10', amount, side, positionSide })
    return read('order-size?' + query, url => {
      if (url.pathname === '/fapi/v2/account') return Response.json({ positions: [
        { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1000' },
        { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '1' },
      ], assets: [{ asset: 'USDT', walletBalance: '106.60875902', availableBalance: available }] })
      assert.equal(url.pathname, '/fapi/v1/exchangeInfo')
      return Response.json({ symbols: [{ symbol: 'ETHUSDT', status: 'TRADING', quoteAsset: 'USDT', orderTypes: ['LIMIT'],
        filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' },
          { filterType: 'MIN_NOTIONAL', notional: '5' }] }] })
    })
  }
  assert.equal((await (await preview('100', '95.66886394', 'BUY')).json()).code, 'INSUFFICIENT_AVAILABLE_MARGIN')
  assert.equal((await preview('95.66886394', '95.66886394', 'BUY')).status, 200)
  assert.equal((await (await preview('10', '0', 'SELL')).json()).quantity, '1')
  assert.equal((await (await preview('15', '5', 'SELL')).json()).quantity, '1.5')
  assert.equal((await (await preview('15.1', '5', 'SELL')).json()).code, 'INSUFFICIENT_AVAILABLE_MARGIN')
  assert.equal((await (await preview('10', '0', 'SELL', 'SHORT')).json()).code, 'INSUFFICIENT_AVAILABLE_MARGIN')
  assert.equal((await (await preview('10', undefined, 'BUY')).json()).code, 'FUTURES_BALANCE_UNAVAILABLE')
})
