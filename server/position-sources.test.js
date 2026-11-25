import assert from 'node:assert/strict'
import test from 'node:test'
import { isPlatformManualPosition, positionSources, tracePosition } from './position-sources.js'

const position = (quantity, entryPrice = '100') => ({ symbol: 'BTCUSDT', positionSide: 'BOTH', quantity, entryPrice, updateTime: 20 })
const fill = (side, quantity, source, time, options = {}) => ({ symbol: 'BTCUSDT', positionSide: 'BOTH',
  side, quantity, source, time, price: '100', ...options })

test('separates the current leg from previous positions and the opposite hedge side', () => {
  const short = position('-1', '90')
  const rows = [fill('SELL', '3', 'manual', 20, { price: '90' }), fill('BUY', '2', 'copy', 18)]
  assert.deepEqual(tracePosition(short, rows), { complete: true, sources: [{ kind: 'manual' }], manualOnly: true })
  assert.deepEqual(tracePosition({ ...short, entryPrice: '91' }, rows).sources, [])
  assert.equal(tracePosition({ ...short, updateTime: 21 }, rows).complete, false)
  const hedge = { ...position('2'), positionSide: 'LONG' }
  const legs = [fill('SELL', '5', 'manual', 20, { positionSide: 'SHORT' }),
    fill('BUY', '2', 'untracked', 20, { positionSide: 'LONG' })]
  assert.deepEqual(tracePosition(hedge, legs).sources, [{ kind: 'external' }])
})

test('mixed openings keep portfolio identity and reductions do not pretend to select a specific contributor', () => {
  const added = [fill('BUY', '2', 'copy', 20, { portfolioId: '90071992547409931', price: '110' }),
    fill('BUY', '2', 'manual', 18)]
  assert.deepEqual(tracePosition(position('4', '105'), added), { complete: true, manualOnly: false,
    sources: [{ kind: 'manual' }, { kind: 'copy', portfolioId: '90071992547409931' }] })
  const reduced = [fill('SELL', '2', 'manual', 20), ...added]
  assert.deepEqual(tracePosition(position('2', '105'), reduced), { sources: [], complete: false, manualOnly: false })
  const smallerReduction = [fill('SELL', '1', 'untracked', 20), ...added]
  assert.equal(tracePosition(position('3', '105'), smallerReduction).sources.length, 2)
})

test('incomplete history can verify an addition without assigning the pre-existing balance to it', () => {
  assert.deepEqual(tracePosition(position('3'), [fill('BUY', '1', 'manual', 20)]),
    { sources: [{ kind: 'unknown' }, { kind: 'manual' }], complete: false, manualOnly: false })
  const trimmed = [fill('SELL', '1', 'untracked', 20), fill('BUY', '2', 'manual', 18)]
  assert.deepEqual(tracePosition(position('1'), trimmed),
    { sources: [{ kind: 'manual' }], complete: true, manualOnly: true })
})

test('journaled copy round trips leave the verified manual base eligible at the combined exchange entry', () => {
  const copy = (kind, quantity, price, time, owner = '1') => fill(kind === 'open' ? 'BUY' : 'SELL', quantity, 'copy', time,
    { price, portfolioId: owner, copyKind: kind, copyDirection: 'LONG' })
  const cycle = [copy('close', '0.03', '120', 20), copy('open', '0.03', '110', 18),
    fill('BUY', '0.10', 'manual', 17)]
  const expected = { complete: true, sources: [{ kind: 'manual' }], manualOnly: true }
  assert.deepEqual(tracePosition(position('0.1', '102.30769231'), cycle), expected)
  const second = [copy('close', '0.02', '95', 22, '2'), copy('open', '0.02', '90', 21, '2'), ...cycle]
  assert.deepEqual(tracePosition({ ...position('0.1', '100.25641026'), updateTime: 22 }, second), expected)
  for (const mismatch of [{ portfolioId: '2' }, { copyDirection: 'SHORT' }, { copyKind: null }]) {
    assert.equal(tracePosition(position('0.1', '102.30769231'), [{ ...cycle[0], ...mismatch }, ...cycle.slice(1)]).manualOnly, false)
  }
  // An intervening unallocated sell can have consumed some of the copy lot.
  const uncertain = [copy('close', '0.03', '120', 20), fill('SELL', '0.01', 'untracked', 19), ...cycle.slice(1)]
  assert.equal(tracePosition(position('0.09', '102.30769231'), uncertain).manualOnly, false)
})

test('account read shares one history per symbol and manual adoption verifies scope without rereading inventory', async () => {
  const user = { id: 'mock-owner', name: 'mock-owner', token: 'test-token', apiKey: 'fixture', apiSecret: 'fixture-secret' }
  const fills = [{ symbol: 'BTCUSDT', positionSide: 'BOTH', orderId: '90071992547409931', id: '1', time: 20,
    qty: '2', price: '100', commission: '0', commissionAsset: 'USDT', side: 'BUY', realizedPnl: '0' }]
  let calls = []
  const env = { BINANCE_FUTURES_USERS: JSON.stringify([user]), orderStore: {
    platform: { orderIds(environment, owner, key, market, symbol, ids) {
      assert.equal(environment, 'testnet')
      assert.equal(owner, user.id)
      assert.equal(market, 'futures')
      assert.equal(symbol, 'BTCUSDT')
      return new Set(ids)
    } },
    copy: { orderPortfolios: () => [] },
  }, fetchBinance(url, init) {
    assert.equal(init.method, 'GET')
    calls.push(url.pathname)
    if (url.pathname.endsWith('/positionRisk')) return Response.json([{ positionAmt: '2', entryPrice: '100', symbol: 'BTCUSDT',
      positionSide: 'BOTH', markPrice: '101', unRealizedProfit: '2', marginAsset: 'USDT', updateTime: 20 }])
    assert.equal(url.pathname, '/fapi/v1/userTrades')
    assert.ok(['20', '21'].includes(url.searchParams.get('endTime')))
    return Response.json(fills)
  } }
  const req = new Request('http://fixture/api/futures/position-sources', { headers: { authorization: 'Bearer test-token' } })
  assert.equal((await positionSources(new Request(req.url), env)).status, 401)
  assert.equal((await positionSources(new Request(req.url, { method: 'POST' }), env)).status, 405)
  const { positions } = await (await positionSources(req, env)).json()
  assert.deepEqual(positions, [{ ...position('2'), complete: true, sources: [{ kind: 'manual' }] }])
  assert.deepEqual(calls, ['/fapi/v3/positionRisk', '/fapi/v1/userTrades'])
  calls = []
  const actual = { symbol: 'BTCUSDT', direction: 'LONG', quantity: 2, entryPrice: 100, updateTime: 20 }
  assert.equal(await isPlatformManualPosition(env, user, 'testnet', actual), true)
  assert.deepEqual(calls, ['/fapi/v1/userTrades'])
  assert.equal(await isPlatformManualPosition(env, user, 'testnet', { ...actual, updateTime: 21 }), false)
})

test('older manual base requires exchange history covering both the ledger anchor and the current snapshot', async () => {
  const user = { id: 'uid:21', apiKey: 'fixture', apiSecret: 'test' }
  const row = (id, side, qty, price, time) => ({ id, orderId: id, side, qty, price, time, positionSide: 'BOTH', symbol: 'BTCUSDT',
    commissionAsset: 'USDT', commission: '0', realizedPnl: '0' })
  const history = [row('201', 'BUY', '0.10', '100', 1), row('205', 'BUY', '0.03', '110', 18), row('209', 'SELL', '0.03', '120', 20)]
  const portfolios = [{ orderId: '205', portfolioId: '42', copyKind: 'open', copyDirection: 'LONG' },
    { orderId: '209', portfolioId: '42', copyKind: 'close', copyDirection: 'LONG' }]
  let older = history
  const cursors = []
  const env = { orderStore: { platform: {
    orderIds: (_env, _id, _key, _market, _symbol, ids) => new Set(ids.filter(id => id === '201')),
    futuresFills(environment, id, keys) {
      assert.deepEqual([environment, id, keys], ['testnet', 'uid:21', { futures: 'uid:21', spot: null }])
      return [{ symbol: 'BTCUSDT', positionSide: 'BOTH', side: 'BUY', quantity: 0.1, price: 100, tradeId: '201' }]
    },
  }, copy: { orderPortfolios: () => portfolios } }, fetchBinance(url) {
    const fromId = url.searchParams.get('fromId')
    cursors.push(fromId)
    assert.equal(url.pathname, '/fapi/v1/userTrades')
    return Response.json(fromId ? older : history.slice(1))
  } }
  const live = { symbol: 'BTCUSDT', direction: 'LONG', quantity: 0.1, entryPrice: 102.30769231, updateTime: 20 }
  assert.equal(await isPlatformManualPosition(env, user, 'testnet', live), true)
  assert.deepEqual(cursors, [null, '201'])
  older = history.slice(0, -1)
  assert.equal(await isPlatformManualPosition(env, user, 'testnet', live), false)
})
