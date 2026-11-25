import assert from 'node:assert/strict'
import test from 'node:test'
import { runCopyTick } from './copy-engine.js'

const start = 1_800_000_000_000
const id = '5075281354358777856'
const btc = 'BTCUSDT'
const eth = 'ETHUSDT'
const sol = 'SOLUSDT'

function signal(offset, symbol = btc, kind = 'open', direction = 'LONG', key = String(offset)) {
  return { id: key, time: start + offset, symbol, direction, kind }
}

function ack(kind, symbol, direction, clientOrderId, qty = 1, status = 'FILLED', price = 100) {
  return {
    symbol, clientOrderId, orderId: '8595492206234297111', status, type: 'MARKET',
    side: ((kind === 'open') === (direction === 'LONG')) ? 'BUY' : 'SELL',
    executedQty: String(qty), avgPrice: String(price),
  }
}

function fixture(config) {
  const state = {
    enabled: true, config: { portfolioId: id, amount: 100, repeat: 'fixed', maxEntries: 2, maxPositions: 2, stopLoss: 5, ...config },
    positions: [], events: [], lastCheck: null, error: '', pending: null, since: start, seen: [],
  }
  const snapshots = []
  const orders = []
  const live = new Map()
  const feed = []
  const exchange = {
    async signals(portfolioId, from, to) {
      assert.equal(portfolioId, id)
      return feed.filter(s => s.time >= from && s.time <= to)
    },
    async positions() { return [...live.values()].map(p => ({ ...p })) },
    async open(symbol, direction, amount, clientOrderId) {
      assert.equal(snapshots.at(-1).pending?.clientOrderId, clientOrderId)
      orders.push(['open', symbol, direction, amount, clientOrderId])
      live.set(symbol, { symbol, direction, quantity: (live.get(symbol)?.quantity ?? 0) + 1, entryPrice: 100, markPrice: 100, unrealizedPnl: 0 })
      return ack('open', symbol, direction, clientOrderId)
    },
    async close(symbol, direction, quantity, clientOrderId) {
      assert.equal(snapshots.at(-1).pending?.clientOrderId, clientOrderId)
      orders.push(['close', symbol, direction, quantity, clientOrderId])
      const position = live.get(symbol)
      assert(position && position.direction === direction && position.quantity >= quantity)
      if (position.quantity === quantity) live.delete(symbol)
      else position.quantity -= quantity
      return ack('close', symbol, direction, clientOrderId, quantity)
    },
    async lookup() { throw Error('unexpected lookup') },
  }
  const save = snapshot => snapshots.push(snapshot)
  const tick = offset => runCopyTick(state, exchange, save, start + offset)
  return { state, feed, exchange, orders, snapshots, live, save, tick }
}

test('only eligible fresh signals open; fixed adds and symbol/entry caps apply within one batch and across overlap', async () => {
  const f = fixture()
  f.feed.push(signal(0), signal(1), signal(2, btc, 'open', 'LONG', '1'), signal(3, btc, 'open', 'SHORT'),
    signal(4), signal(5), signal(6, eth, 'open', 'SHORT'), signal(7, sol))
  await f.tick(1000)
  assert.deepEqual(f.orders.map(o => o.slice(0, 4)), [
    ['open', btc, 'LONG', 100], ['open', btc, 'LONG', 100], ['open', eth, 'SHORT', 100],
  ])
  assert.deepEqual(f.state.positions.map(p => [p.symbol,p.quantity,p.entries]), [[btc,2,2],[eth,1,1]])
  await f.tick(6000)
  assert.equal(f.orders.length, 3)
  assert.equal(f.snapshots.at(-1).pending, null)
  assert(f.snapshots.some(s => s.pending?.clientOrderId === f.orders[0][4]))
})

test('first mode ignores adds, exits entire owned quantity on matching direction, accepts a newer fresh first entry', async () => {
  const f = fixture({ repeat: 'first' })
  f.feed.push(signal(1), signal(2), signal(3, btc, 'close', 'SHORT'), signal(4, btc, 'close'), signal(5))
  await f.tick(1000)
  assert.deepEqual(f.orders.map(o => o[0]), ['open', 'close', 'open'])
  f.feed.push(signal(3, btc, 'close', 'LONG', 'delayed-previous-position-close'))
  await f.tick(2000)
  assert.equal(f.orders.length,3)
})

test('pausing retains stop and leader exits, ignores adds and blocks old signals from reopening after stop', async () => {
  const f = fixture()
  f.feed.push(signal(1), signal(2), signal(3, eth, 'open', 'SHORT'))
  await f.tick(100)
  f.state.enabled = false
  f.live.get(btc).unrealizedPnl = -5
  f.feed.push(signal(200),signal(201,eth,'close','SHORT'),signal(202,sol))
  await f.tick(300)
  assert.deepEqual(f.orders.slice(3).map(o => o.slice(0,4)), [['close',btc,'LONG',2],['close',eth,'SHORT',1]])
  assert.equal(f.state.positions.length,0)
  f.state.enabled = true
  f.feed.push(signal(290,btc,'open','LONG','late'))
  await f.tick(500)
  assert.equal(f.orders.length,5)
})

test('initial unmanaged and manually changed holdings are left untouched', async () => {
  const f = fixture()
  f.live.set(eth, { symbol: eth, direction: 'SHORT', quantity: 3, entryPrice: 100, markPrice: 100, unrealizedPnl: -50 })
  f.feed.push(signal(1,eth,'open','SHORT'),signal(2,eth,'close','SHORT'),signal(3))
  await f.tick(1000)
  assert.deepEqual(f.orders.map(o => o[1]),[btc])
  f.live.get(btc).quantity = 1.5
  f.live.get(btc).unrealizedPnl = -10
  f.feed.push(signal(1500,btc,'close'))
  await f.tick(2000)
  assert.equal(f.orders.length,1)
  assert.equal(f.live.get(btc).quantity,1.5)
  assert.equal(f.state.positions.length,0)
  assert(f.state.events.some(e => e.message.includes('停止接管')))
})

test('a failed feed still checks stop loss and after recovery old entries are discarded; long downtime never opens stale trades', async () => {
  const f = fixture()
  f.feed.push(signal(1))
  await f.tick(100)
  f.live.get(btc).unrealizedPnl = -6
  const normal = f.exchange.signals
  f.exchange.signals = async () => { throw Error('offline') }
  await f.tick(500)
  assert.equal(f.orders.at(-1)[0],'close')
  assert.match(f.state.error,/offline/)
  f.feed.push(signal(600),signal(700,eth))
  f.exchange.signals = normal
  await f.tick(1000)
  assert.equal(f.orders.length,2)
  f.feed.push(signal(1001))
  await f.tick(2000)
  assert.equal(f.orders.length,3)
  f.feed.push(signal(70_001,eth))
  await f.tick(70_100)
  assert.equal(f.orders.length,3)
  f.feed.push(signal(70_101,eth))
  await f.tick(71_000)
  assert.equal(f.orders.length,4)
})

test('journaled order with lost reply survives restart and NOT_FOUND; repeated partial and final acknowledgements apply exactly once', async () => {
  const f = fixture()
  let orderId
  let step = 0
  f.exchange.open = async (symbol,direction,amount,key) => {
    orderId=key
    assert.equal(f.snapshots.at(-1).pending.clientOrderId, key)
    throw Error('lost reply')
  }
  f.exchange.lookup = async (symbol,key) => {
    assert.equal(key,orderId)
    step++
    if(step===1) throw Object.assign(Error('订单不存在'),{code:'-2013'})
    return ack('open', symbol, 'LONG', key, step <= 3 ? 0.4 : 1, step <= 3 ? 'PARTIALLY_FILLED' : 'FILLED')
  }
  f.feed.push(signal(1))
  await f.tick(100)
  const restored = structuredClone(f.snapshots.at(-1))
  assert.equal(restored.pending.clientOrderId,orderId)
  const run = offset => runCopyTick(restored, f.exchange, f.save, start+offset)
  await run(1000)
  assert.equal(restored.pending.clientOrderId,orderId)
  f.live.set(btc,{ symbol:btc,direction:'LONG',quantity:0.4,entryPrice:100,markPrice:100,unrealizedPnl:0 })
  await run(2000)
  await run(3000)
  assert.equal(restored.positions[0].quantity,0.4)
  assert.equal(restored.positions[0].entries,1)
  f.live.get(btc).quantity=1
  await run(4000)
  assert.equal(restored.positions[0].quantity,1)
  assert.equal(restored.positions[0].entries,1)
  assert.equal(restored.pending,null)
  assert.equal(restored.error,'')
})

test('partial exit with terminal cancellation retains a durable exit for the exact residual quantity', async () => {
  const f = fixture()
  f.feed.push(signal(1),signal(2))
  await f.tick(100)
  const close=f.exchange.close
  let sent=0
  f.exchange.close=async (symbol,direction,quantity,key) => {
    if (++sent>1) return close(symbol,direction,quantity,key)
    assert.equal(quantity,2)
    f.live.get(btc).quantity=1.25
    return ack('close',symbol,direction,key,0.75,'EXPIRED')
  }
  f.feed.push(signal(110,btc,'close'))
  await f.tick(200)
  assert.equal(f.state.positions[0].quantity,1.25)
  assert(f.state.positions[0].exit)
  await f.tick(300)
  assert.equal(f.orders.at(-1)[3],1.25)
  assert.equal(f.state.positions.length,0)
})

test('storage failure prevents side effects and single-flight guard serializes concurrent invocations', async () => {
  const f = fixture()
  f.feed.push(signal(1))
  await assert.rejects(runCopyTick(f.state,f.exchange,()=>{throw Error('store offline')},start+100),/store offline/)
  assert.equal(f.orders.length,0)
  const second=fixture()
  second.feed.push(signal(1))
  await Promise.all([second.tick(100),second.tick(100)])
  assert.equal(second.orders.length,1)
})

test('downtime checks missed lead exits for managed positions while discarding missed entries', async () => {
  const f = fixture()
  f.feed.push(signal(1))
  await f.tick(100)
  f.state.enabled = false
  f.feed.push(signal(10_000, btc, 'close'), signal(11_000, eth))
  await f.tick(5 * 3_600_000)
  assert.deepEqual(f.orders.map(order => order[0]), ['open', 'close'])
  assert.equal(f.state.positions.length, 0)
})

test('an incomplete page is retried over smaller historical windows and cannot hide a managed exit', async () => {
  const f = fixture()
  f.feed.push(signal(1))
  await f.tick(100)
  f.feed.push(signal(700, btc, 'close'), signal(1500, eth))
  const signals = f.exchange.signals
  f.exchange.signals = async (...args) => {
    if (args[2] - args[1] > 2000) throw Object.assign(Error('incomplete'), {code:'INCOMPLETE_COPY_SIGNALS'})
    return signals(...args)
  }
  await f.tick(4000)
  assert.equal(f.state.since,start + 100)
  assert.match(f.state.error,/尚未核实/)
  await f.tick(4500)
  assert.deepEqual(f.orders.map(order => order[0]), ['open', 'close'])
})

test('public-feed rate limit persists its retry deadline and pauses account, order and feed requests until then', async () => {
  const f = fixture()
  let checks = 0
  f.exchange.positions = async () => { checks++; return [] }
  const signals = f.exchange.signals
  let reads = 0
  f.exchange.signals = async () => {
    reads++
    throw Object.assign(Error('429'),{ status:429, headers:{ 'Retry-After': '120' } })
  }
  await f.tick(1000)
  assert(f.state.retryAt >= start+121_000)
  assert.match(f.state.error,/限流/)
  const stored = structuredClone(f.snapshots.at(-1))
  await runCopyTick(stored,f.exchange,f.save,start+120_000)
  assert.equal(checks,0)
  assert.equal(reads,1)
  f.exchange.signals=async (...args) => { reads++; return signals(...args) }
  await runCopyTick(stored,f.exchange,f.save,start+122_000)
  assert.equal(checks,0)
  assert.equal(reads,2)
})

test('rate limit during a stop prevents new orders and further calls for the rest of the tick', async () => {
  const f = fixture()
  f.feed.push(signal(1),signal(2,eth))
  await f.tick(100)
  f.live.get(btc).unrealizedPnl = -10
  f.live.get(eth).unrealizedPnl = -9
  let closeCalls = 0
  f.exchange.close = async () => {
    closeCalls++
    throw Object.assign(Error('418'),{ definite:true, status:418, headers:new Headers({'Retry-After': new Date(start+60_000).toUTCString()}) })
  }
  f.exchange.signals = () => { assert.fail('feed queried during 418 ban') }
  await f.tick(3000)
  assert.equal(closeCalls,1)
  assert(f.state.positions.every(position => position.exit))
  assert.equal(f.state.retryAt,start+60_000)
})

test('every positive partial and final acknowledgement supplies atomic cumulative execution metadata, with original submission time', async () => {
  const f = fixture()
  const executionWrites = []
  const save = (snapshot, execution) => {
    f.save(snapshot)
    if (execution) executionWrites.push({ snapshot, execution })
  }
  f.exchange.open = async (symbol, direction, amount, key) => {
    assert.equal(f.snapshots.at(-1).pending.clientOrderId, key)
    return ack('open', symbol, direction, key, 0.4, 'PARTIALLY_FILLED', 101)
  }
  f.exchange.lookup = async (symbol, key) => ack('open', symbol, 'LONG', key, 0.4, 'PARTIALLY_FILLED', 101)
  f.feed.push(signal(1))
  await runCopyTick(f.state, f.exchange, save, start + 100)
  const restored = structuredClone(f.snapshots.at(-1))
  await runCopyTick(restored, f.exchange, save, start + 200)
  f.exchange.lookup = async (symbol, key) => ack('open', symbol, 'LONG', key, 1, 'FILLED', 103)
  f.live.set(btc, { symbol: btc, direction: 'LONG', quantity: 1, entryPrice: 103, unrealizedPnl: 1 })
  await runCopyTick(restored, f.exchange, save, start + 300)
  assert.deepEqual(executionWrites.map(({execution: e}) => [e.quantity, e.price]), [[0.4,101],[0.4,101],[1,103]])
  for (const {snapshot, execution} of executionWrites) {
    assert.deepEqual(execution, {
      clientOrderId: f.snapshots[0].pending.clientOrderId, orderId: '8595492206234297111', symbol: btc,
      direction: 'LONG', kind: 'open', portfolioId: id, time: f.snapshots[0].pending.time,
      quantity: snapshot.positions[0].quantity, price: snapshot.positions[0].entryPrice,
    })
  }
  assert.equal(executionWrites.at(-1).snapshot.pending,null)
})

test('unrealized PnL sums only matched owned positions and is unknown after submission, mismatch or account outage', async () => {
  const f = fixture()
  f.feed.push(signal(1), signal(2, eth))
  await f.tick(100)
  assert.equal(f.state.unrealized,null)
  assert.equal(f.state.unrealizedAt,null)
  f.live.get(btc).unrealizedPnl = 12
  f.live.get(eth).unrealizedPnl = -3
  f.live.set(sol, { symbol: sol, direction: 'LONG', quantity: 1, entryPrice: 100, unrealizedPnl: 888 })
  await f.tick(200)
  assert.equal(f.state.unrealized,9)
  assert(f.state.unrealizedAt >= start + 200)
  f.live.get(btc).quantity = 2
  await f.tick(300)
  assert.equal(f.state.unrealized,null)
  assert.equal(f.state.positions.length,1)
  f.exchange.positions = async () => { throw Error('outage') }
  await f.tick(400)
  assert.equal(f.state.unrealized,null)
  assert.equal(f.state.unrealizedAt,null)
  const flat = fixture()
  await flat.tick(10)
  assert.equal(flat.state.unrealized,0)
})

test('flat idle and ineligible signals make no signed account reads; first eligible trade checks for unmanaged holdings before opening', async () => {
  const f = fixture()
  const positions = f.exchange.positions
  let checks = 0
  f.exchange.positions = async () => { checks++; return positions() }
  await f.tick(100)
  f.feed.push(signal(120, btc, 'close'))
  await f.tick(200)
  assert.equal(checks,0)
  f.live.set(eth,{symbol:eth,direction:'SHORT',entryPrice:100,quantity:1,unrealizedPnl:0})
  f.feed.push(signal(201, eth),signal(202, btc))
  await f.tick(300)
  assert.equal(checks,2)
  assert.deepEqual(f.orders.map(o => o[1]),[btc])
})

test('an observed close suppresses a delayed older open and an ambiguous same-millisecond open even while flat', async () => {
  const f = fixture()
  f.feed.push(signal(100, btc, 'close'))
  await f.tick(200)
  f.feed.push(signal(99), signal(100, btc, 'open', 'LONG', 'tied-open'))
  await f.tick(300)
  assert.equal(f.orders.length, 0)
  f.feed.push(signal(301))
  await f.tick(400)
  assert.equal(f.orders.length, 1)
})

test('selected leaders share the position cap and only the owning leader can add, exit or claim the execution', async () => {
  const other = '22'
  const f = fixture({ portfolioIds: [id, other], leverage: 10, sizingMode: 'equityPercent', amount: 2 })
  const trades = { [id]: [signal(1), signal(3, eth, 'close'), signal(4, sol), signal(6)],
    [other]: [signal(2, eth, 'open', 'LONG', '1'), signal(2, btc), signal(3, btc, 'close')] }
  const queried = new Set()
  f.exchange.signals = async portfolioId => {
    queried.add(portfolioId)
    return trades[portfolioId]
  }
  const open = f.exchange.open
  f.exchange.open = async (...args) => {
    assert.equal(args[2], 2)
    assert.equal(args[4], 10)
    assert.equal(args[5], 'equityPercent')
    return open(...args)
  }
  const ledger = []
  const save = (snapshot, fill) => { f.save(snapshot); if (fill) ledger.push([fill.kind, fill.portfolioId, fill.symbol]) }
  await runCopyTick(f.state, f.exchange, save, start + 100)
  assert.deepEqual(queried, new Set([id, other]))
  assert.deepEqual(ledger, [['open', id, btc], ['open', other, eth], ['open', id, btc]])
  assert.deepEqual(f.state.positions.map(p => [p.portfolioId, p.quantity]), [[id, 2], [other, 1]])
  // Even a failed leader feed must leave the other leader's exit actionable.
  const slow = Promise.withResolvers()
  f.exchange.signals = async portfolioId => {
    if (portfolioId === id) return slow.promise
    return [...trades[other], signal(150, eth, 'close')]
  }
  const polling = runCopyTick(f.state, f.exchange, save, start + 200)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ledger.at(-1), ['close', other, eth])
  slow.reject(Error('offline'))
  await polling
  assert.match(f.state.error, /offline/)
  assert.equal(f.state.feeds[id].since, start + 100)
  assert.equal(f.state.feeds[other].since, start + 200)
  assert.deepEqual(ledger.at(-1), ['close', other, eth])
  assert.deepEqual(f.state.positions.map(p => p.portfolioId), [id])
  // Upon recovery the owner still receives its exit, and the healthy source can
  // open using the same raw fill identifier the other source already processed.
  f.exchange.signals = async portfolioId => portfolioId === id ? [signal(170, btc, 'close')] : [signal(220, eth, 'open', 'LONG', '6')]
  await runCopyTick(f.state, f.exchange, save, start + 300)
  assert.deepEqual(ledger.slice(-2), [['close', id, btc], ['open', other, eth]])
})
