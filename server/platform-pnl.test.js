import assert from 'node:assert/strict'
import test from 'node:test'
import { manualPositionBasis, platformPnl } from './platform-pnl.js'

test('manual futures basis respects additions, reductions, reversals and distinct hedge sides', () => {
  const fill = (side, quantity, price, positionSide = 'BOTH') => ({ symbol: 'BTCUSDT', side, quantity, price, positionSide })
  const buys = [fill('BUY', 1, 100), fill('BUY', 1, 110), fill('SELL', 1, 120)]
  assert.equal(manualPositionBasis(buys)[0].entryPrice, 105)
  assert.deepEqual(manualPositionBasis([...buys, fill('SELL', 3, 95), fill('SELL', 1, 500, 'LONG')]), [
    { symbol: 'BTCUSDT', positionSide: 'BOTH', quantity: -2, entryPrice: 95, firstTradeId: undefined, unrealized: null }
  ])
})

test('stored P&L reads need no exchange call; mismatched holdings and external spot sales cannot inflate valuation', async () => {
  const user = { id:'me', name:'desk', token:'fixture', apiKey:'key', apiSecret:'secret', spotApiKey:'spot', spotApiSecret:'secret' }
  const api = path => new Request('http://local/api/platform/' + path, { headers: { Authorization:'Bearer fixture' } })
  const calls = []
  let externalSale = true
  let liveFuturesQuantity = '3'
  let externalReopen = true
  const env = { BINANCE_FUTURES_USERS: JSON.stringify([user]),
    orderStore: { copy: {read: () => null}, platform: {
      report: () => ({ total:1, totals:[], rows:[], spot:[{ symbol:'BTCUSDT', quantity:1, cost:100, firstBuyTime:50, keyIdentity:'private-hash' }] }),
      futuresFills: () => [{ symbol:'ETHUSDT', positionSide:'BOTH', quantity:2, side:'BUY', price:100, tradeId:'101' }] } },
    fetchBinance: url => {
      calls.push(url.pathname)
      if (url.pathname === '/fapi/v3/positionRisk') return Response.json([{ symbol:'ETHUSDT', positionSide:'BOTH', positionAmt:liveFuturesQuantity,
        entryPrice:'100', markPrice:'200', unRealizedProfit:String(Number(liveFuturesQuantity)*100), marginAsset:'USDT', updateTime:100 }])
      if (url.pathname === '/fapi/v1/userTrades') return Response.json((externalReopen ? ['101','102','103'] : ['101'])
        .map(id => ({ id, symbol:'ETHUSDT', positionSide:'BOTH' })))
      if (url.pathname === '/api/v3/account') return Response.json({ balances:[{asset:'BTC',free:'1',locked:'0'}] })
      if (url.pathname === '/api/v3/myTrades') return Response.json([{symbol:'BTCUSDT',isBuyer:!externalSale,time:55}])
      return Response.json({symbol:'BTCUSDT',price:'120'})
    } }
  assert.equal((await (await platformPnl(api('pnl'), env)).json()).total, 1)
  assert.equal(calls.length, 0)
  const mixed = await (await platformPnl(api('valuation'), env)).json()
  assert.equal(mixed.spot[0].unrealized, null)
  assert.equal(mixed.manualPositions[0].unrealized, null)
  assert(!JSON.stringify(mixed).includes('private-hash'))
  externalSale = false
  liveFuturesQuantity = '2'
  const equalSize = await (await platformPnl(api('valuation'), env)).json()
  assert.equal(equalSize.spot[0].unrealized, 20)
  assert.equal(equalSize.manualPositions[0].unrealized, null)
  externalReopen = false
  assert.equal((await (await platformPnl(api('valuation'), env)).json()).manualPositions[0].unrealized, 200)
})
