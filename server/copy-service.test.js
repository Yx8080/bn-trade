import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate as flush } from 'node:timers/promises'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createCopyService } from './copy-service.js'

const epoch = 1_800_000_000_000
const config = { portfolioId: '101', amount: 50, repeat: 'first', maxEntries: 1, maxPositions: 1, stopLoss: 20 }
const users = ['a', 'b'].map(id => ({ id, name: id, token: 'fixture-' + id, apiKey: 'key-' + id, apiSecret: 'fixture-secret' }))

function packet(path, token = users[0].token, command, method) {
  return new Request('http://localhost/api/futures/' + path, {
    method: method ?? (command ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: command ? JSON.stringify(command) : undefined,
  })
}

async function json(service, path, token, command) {
  const response = await service.fetch(packet(path, token, command))
  assert.equal(response.status, 200)
  return response.json()
}

function orderAck(order, status = 'FILLED', quantity = 1, price = 50) {
  return { symbol: order.symbol, clientOrderId: order.clientOrderId, orderId: order.orderId, status,
    type: 'MARKET', side: order.kind === 'open' ? 'BUY' : 'SELL', executedQty: String(quantity), avgPrice: String(price) }
}

function venue() {
  const orders = []
  const feed = []
  const accounts = new Map()
  const observed = []
  const at = (key, fallback) => accounts.get(key) ?? fallback
  const factory = (_, user, environment) => {
    const scope = environment + '/' + user.id
    async function place(kind, symbol, direction, amount, clientOrderId) {
      const order = { scope, kind, symbol, direction, amount, clientOrderId, orderId: String(900000 + orders.length) }
      orders.push(order)
      if (kind === 'open') accounts.set(scope, [{ symbol, direction, quantity: 1, entryPrice: 50, markPrice: 55, unrealizedPnl: 5 }])
      else accounts.set(scope, [])
      return orderAck(order)
    }
    return {
      async positions() {
        observed.push([scope, 'positions'])
        return structuredClone(at(scope, []))
      },
      async signals(portfolioId, from, until) {
        observed.push([scope, 'signals'])
        return feed.filter(row => row.time > from && row.time <= until)
      },
      open: (...args) => place('open', ...args),
      close: (...args) => place('close', ...args),
      async lookup(symbol, key) {
        observed.push([scope, 'lookup', key])
        const known = orders.find(order => order.scope === scope && order.symbol === symbol && order.clientOrderId === key)
        if (!known) throw Error('订单不存在')
        return orderAck(known)
      },
      async fills(symbol, orderId) {
        observed.push([scope, 'fills', orderId])
        const order = orders.find(o => o.scope === scope && o.symbol === symbol && o.orderId === orderId)
        if (!order) throw Error('尚未查到成交')
        return [{ quantity: 1, realized: order.kind === 'open' ? 0 : 5, commissionAsset: 'USDT', commission: 0.25 }]
      },
    }
  }
  return { factory, orders, observed, feed, accounts }
}

async function harness(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: epoch })
  const directory = await mkdtemp(join(tmpdir(), 'bn-copy-store-'))
  const file = join(directory, 'orders.sqlite')
  const started = []
  const market = venue()
  function launch(factory = market.factory, environment = 'testnet', openMarkStream) {
    const db = createLocalOrderDb(file)
    const env = { BINANCE_FUTURES_USERS: JSON.stringify(users), BINANCE_FUTURES_ENV: environment, orderStore: db, openMarkStream }
    const service = createCopyService(env, factory)
    started.push({ db, service })
    return { db: db.copy, service }
  }
  async function tick(ms = 5000) {
    t.mock.timers.tick(ms)
    await flush()
  }
  t.after(async () => {
    for (const { db, service } of started) { await service.close(); db.close() }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(basename(directory).startsWith('bn-copy-store-'))
    await rm(directory, { recursive: true, force: true })
  })
  return { file, market, launch, tick }
}

const begin = { action: 'start', environment: 'testnet', config }
const pause = { action: 'pause', environment: 'testnet' }
const fillSignal = (time, kind) => ({ time: epoch + time, id: String(time), symbol: 'BTCUSDT', direction: 'LONG', kind })

test('a streamed loss threshold wakes a leased account check before the next poll, including after pausing openings', async t => {
  const { launch, market, tick } = await harness(t)
  const socket = { readyState: 1, send() {}, close() {} }
  const connect = t.mock.fn(async () => socket)
  const { service } = launch(market.factory, 'testnet', connect)
  await json(service, 'copy', undefined, begin)
  market.feed.push(fillSignal(100, 'open'))
  await tick()
  assert.equal(connect.mock.callCount(), 0)
  await json(service, 'copy', undefined, pause)
  await tick()
  assert.equal(connect.mock.callCount(), 1)
  market.accounts.get('testnet/a')[0].unrealizedPnl = -21
  socket.onmessage({ data: JSON.stringify({ e: 'markPriceUpdate', E: Date.now(), s: 'BTCUSDT', p: '29' }) })
  await flush()
  assert.deepEqual(market.orders.map(row => row.kind), ['open', 'close'])
  assert.equal((await json(service, 'copy')).positions.length, 0)
})

test('copy APIs authenticate both reads and writes, validate the intended environment and isolate each user’s strategy and settled ledger', async t => {
  const { launch, tick, market } = await harness(t)
  const { service } = launch()
  const live = launch(market.factory, 'live').service
  assert.equal((await service.fetch(packet('copy', 'invalid', begin))).status, 401)
  assert.equal((await service.fetch(packet('copy-pnl', 'invalid'))).status, 401)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, environment: 'live' }))).status, 409)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, config: { ...config, amount: -10 } }))).status, 400)
  assert.equal((await service.fetch(packet('copy-pnl?page=0'))).status, 400)
  assert.equal((await service.fetch(packet('copy-pnl', undefined, pause))).status, 405)
  const active = await json(service, 'copy', undefined, begin)
  assert.equal(active.enabled, true)
  assert(!('keyIdentity' in active))
  market.feed.push(fillSignal(100, 'open'))
  await tick()
  let pnl = await json(service, 'copy-pnl?page=1')
  assert.equal(pnl.total, 1)
  assert.equal(pnl.pendingCount, 1)
  assert.equal(pnl.rows[0].settled, false)
  assert.deepEqual(pnl.totals, [])
  assert.equal(pnl.unrealized, null)
  await tick()
  pnl = await json(service, 'copy-pnl')
  assert.equal(pnl.pendingCount, 0)
  assert.equal(pnl.unrealized, 5)
  assert.equal(pnl.openCount, 1)
  assert.equal(pnl.rows[0].price, 50)
  assert.deepEqual(pnl.totals, [{ asset: 'USDT', realized: 0, fees: 0.25, net: -0.25 }])
  await json(service, 'copy', undefined, pause)
  market.feed.push(fillSignal(10_100, 'close'), fillSignal(10_200, 'open'))
  await tick()
  await tick()
  pnl = await json(service, 'copy-pnl')
  assert.deepEqual(pnl.rows.map(row => row.kind), ['close', 'open'])
  assert.deepEqual(pnl.totals, [{ asset: 'USDT', realized: 5, fees: 0.5, net: 4.5 }])
  assert.equal(pnl.unrealized, 0)
  assert.equal(pnl.openCount, 0)
  assert.equal((await json(service, 'copy?userId=a', users[1].token)).config, null)
  assert.equal((await json(service, 'copy-pnl?userId=a', users[1].token)).total, 0)
  assert.equal((await json(live, 'copy-pnl?environment=testnet')).total, 0)
  assert.equal((await json(live, 'copy')).enabled, false)
  assert.deepEqual(market.orders.map(o => [o.scope, o.kind]), [['testnet/a', 'open'], ['testnet/a', 'close']])
})

test('pause on a second SQLite connection before the journal write wins and prevents submission', async t => {
  const { launch, tick, market } = await harness(t)
  const held = Promise.withResolvers()
  const started = Promise.withResolvers()
  const { service } = launch((...args) => {
    const api = market.factory(...args)
    return { ...api, async signals(...query) { started.resolve(); await held.promise; return api.signals(...query) } }
  })
  const other = launch()
  await json(service, 'copy', undefined, begin)
  market.feed.push(fillSignal(100, 'open'))
  await tick()
  await started.promise
  assert.equal(other.db.ready('testnet', Date.now()).length, 0)
  assert.equal((await json(other.service, 'copy', undefined, pause)).enabled, false)
  held.resolve()
  await flush()
  const end = await json(service, 'copy')
  assert.equal(end.enabled, false)
  assert.equal(end.pending, null)
  assert.equal(market.orders.length, 0)
})

test('a pause between submission and acknowledgement is preserved; recovery reconciles the submitted order once', async t => {
  const { launch, tick, market } = await harness(t)
  const held = Promise.withResolvers()
  const started = Promise.withResolvers()
  const { service } = launch((...args) => {
    const api = market.factory(...args)
    return { ...api, async open(...params) {
      const result = await api.open(...params)
      started.resolve()
      await held.promise
      return result
    } }
  })
  const other = launch()
  await json(service, 'copy', undefined, begin)
  market.feed.push(fillSignal(100, 'open'))
  await tick()
  await started.promise
  const paused = await json(other.service, 'copy', undefined, pause)
  assert.equal(paused.pending.clientOrderId, market.orders[0].clientOrderId)
  held.resolve()
  await flush()
  assert.equal((await json(service, 'copy-pnl')).total, 0)
  await tick()
  await tick()
  const end = await json(service, 'copy')
  assert.equal(end.enabled, false)
  assert.equal(end.pending, null)
  assert.equal(end.positions[0].quantity, 1)
  assert.equal((await json(service, 'copy-pnl')).total, 1)
  assert.equal(market.orders.length, 1)
  assert.equal(market.observed.filter(o => o[1] === 'lookup').length, 1)
})

test('abrupt process exit between exchange submission and acknowledgement recovers after lease expiry through lookup only', async t => {
  const { file, launch, market, tick } = await harness(t)
  // The child dies inside the simulated submission, without releasing the lease or
  // returning an acknowledgement. Both the journal and lease must survive on disk.
  const child = `
    import { mock } from 'node:test'
    import { createCopyService } from ${JSON.stringify(new URL('./copy-service.js', import.meta.url).href)}
    import { createLocalOrderDb } from ${JSON.stringify(new URL('../worker/local-orders.js', import.meta.url).href)}
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: ${epoch} })
    const env = { orderStore: createLocalOrderDb(process.argv[1]), BINANCE_FUTURES_USERS: process.argv[2] }
    const service = createCopyService(env, () => ({
      positions: async () => [],
      signals: async () => [${JSON.stringify(fillSignal(100, 'open'))}],
      open: async () => process.exit(47)
    }))
    const request = new Request('http://localhost/api/futures/copy', { method: 'POST',
      headers: { Authorization: 'Bearer fixture-a', 'Content-Type': 'application/json' }, body: process.argv[3] })
    if ((await service.fetch(request)).status !== 200) process.exit(2)
    mock.timers.tick(5000)
    await new Promise(resolve => setImmediate(resolve))
    process.exit(3)
  `
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', child, file, JSON.stringify(users), JSON.stringify(begin)], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(crash.status, 47, crash.stderr)
  const { db, service } = launch()
  const saved = db.read('testnet', 'a').state.pending
  assert.equal(saved.kind, 'open')
  market.orders.push({ ...saved, scope: 'testnet/a', orderId: '10101' })
  market.accounts.set('testnet/a', [{ symbol: 'BTCUSDT', direction: 'LONG', quantity: 1, entryPrice: 50, unrealizedPnl: 4 }])
  await tick(90_000)
  assert.equal(market.observed.length, 0)
  await tick(5000)
  const recovered = await json(service, 'copy')
  assert.equal(recovered.pending, null)
  assert.equal(recovered.positions.length, 1)
  assert.equal(recovered.positions[0].entries, 1)
  await tick()
  assert.equal(market.orders.length, 1)
  assert.equal(market.observed.filter(o => o[1] === 'lookup').length, 1)
  const pnl = await json(service, 'copy-pnl')
  assert.equal(pnl.total, 1)
  assert.equal(pnl.pendingCount, 0)
  assert.equal(pnl.rows[0].clientOrderId, saved.clientOrderId)
  assert.equal(pnl.rows[0].time, saved.time)
})

test('cumulative partials stay one execution and settlement for an older quantity cannot mark the final quantity settled', async t => {
  const { launch, market, tick } = await harness(t)
  const priorFills = Promise.withResolvers()
  let full = false
  let fillReads = 0
  const { service } = launch((...args) => {
    const api = market.factory(...args)
    return {
      ...api,
      async open(...params) {
        await api.open(...params)
        market.accounts.get('testnet/a')[0].quantity = 0.4
        return orderAck(market.orders[0], 'PARTIALLY_FILLED', 0.4)
      },
      async lookup(symbol, key) {
        const order = market.orders.find(o => o.symbol === symbol && o.clientOrderId === key)
        if (full) market.accounts.get('testnet/a')[0].quantity = 1
        return orderAck(order, full ? 'FILLED' : 'PARTIALLY_FILLED', full ? 1 : 0.4)
      },
      async fills() {
        if (++fillReads === 1) return priorFills.promise
        return [
          { quantity: 0.4, realized: 0, commissionAsset: 'USDT', commission: 0.1 },
          { quantity: 0.6, realized: 0, commissionAsset: 'BNB', commission: 0.002 },
        ]
      },
    }
  })
  await json(service, 'copy', undefined, begin)
  market.feed.push(fillSignal(100, 'open'))
  await tick()
  await tick()
  let pnl = await json(service, 'copy-pnl')
  assert.equal(pnl.rows[0].quantity, 0.4)
  assert.equal(pnl.total, 1)
  assert.equal(fillReads, 1)
  full = true
  await tick()
  priorFills.resolve([{ quantity: 0.4, realized: 0, commissionAsset: 'USDT', commission: 0.1 }])
  await flush()
  pnl = await json(service, 'copy-pnl')
  assert.equal(pnl.rows[0].quantity, 1)
  assert.equal(pnl.pendingCount, 1)
  assert.deepEqual(pnl.totals, [])
  await tick()
  pnl = await json(service, 'copy-pnl')
  assert.equal(pnl.total, 1)
  assert.equal(pnl.pendingCount, 0)
  assert.equal(pnl.rows[0].clientOrderId, market.orders[0].clientOrderId)
  assert.deepEqual(pnl.totals.sort((a, b) => a.asset.localeCompare(b.asset)), [
    { asset: 'BNB', realized: 0, fees: 0.002, net: -0.002 },
    { asset: 'USDT', realized: 0, fees: 0.1, net: -0.1 },
  ])
})
