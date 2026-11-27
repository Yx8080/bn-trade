import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate as flush } from 'node:timers/promises'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createCopyService } from './copy-service.js'
import { createMonitorApi } from './monitor-api.js'

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
        return { mode: 'oneWay', positions: structuredClone(at(scope, [])) }
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
  function launch(factory = market.factory, environment = 'live', openMarkStream, configured = users) {
    const db = createLocalOrderDb(file)
    const env = { BINANCE_FUTURES_USERS: configured ? JSON.stringify(configured) : undefined, BINANCE_FUTURES_ENV: environment, orderStore: db, openMarkStream }
    const service = createCopyService(env, factory)
    const instance = { db: db.copy, accounts: db.accounts, service, env }
    started.push(instance)
    return instance
  }
  async function tick(ms = 5000) {
    t.mock.timers.tick(ms)
    await flush()
  }
  t.after(async () => {
    for (const { env, service, monitor } of started) {
      await monitor?.close()
      await service.close()
      env.orderStore.close()
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(basename(directory).startsWith('bn-copy-store-'))
    await rm(directory, { recursive: true, force: true })
  })
  return { file, market, launch, tick }
}

const begin = { action: 'start', environment: 'live', config }
const pause = { action: 'pause', environment: 'live' }
const fillSignal = (time, kind) => ({ time: epoch + time, id: String(time), symbol: 'BTCUSDT', direction: 'LONG', kind })

test('one monitor notifies every matching strategy only after a complete sample, including exits after pausing', async t => {
  const { launch, tick, market } = await harness(t)
  const accountExchange = (...args) => {
    const exchange = market.factory(...args)
    delete exchange.signals
    return exchange
  }
  const first = launch(accountExchange, 'live', undefined, null)
  const second = launch(accountExchange, 'live', undefined, null)
  const connect = (instance, index) => instance.accounts.bind('live', { uid: String(index + 100), issuer: 'live',
    apiKey: users[index].apiKey, apiSecret: users[index].apiSecret, markets: ['futures'] })
  const a = connect(first, 0)
  const b = connect(second, 1)
  first.env.orderStore.monitorWatchlists.save(undefined, ['101'])
  const calls = []
  const opened = { symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', orderTime: epoch + 2_000,
    orderUpdateTime: epoch + 2_001, orderId: JSON.rawJSON('9007199254740993'), avgPrice: 1e-7, executedQty: 1 }
  const ignored = { ...opened, orderId: JSON.rawJSON('9007199254740992'), status: 'PARTIALLY_FILLED' }
  let reply = () => ({ list: [], total: 0 })
  let monitorBusy = false
  for (const instance of [first, second]) {
    instance.env.fetchBinance = (url, request) => {
      assert.match(url.pathname, /lead-portfolio\/order-history$/)
      assert.equal(request.headers.has('X-MBX-APIKEY'), false)
      const query = JSON.parse(request.body)
      calls.push(query)
      if (monitorBusy) return Response.json({ code: '11012005', message: 'The system is currently busy.' })
      return Response.json({ code: '000000', data: reply(query) })
    }
    instance.monitor = createMonitorApi(instance.env, instance.service.notifyPortfolio)
  }
  await json(first.service, 'copy', a.token, begin)
  await json(second.service, 'copy', b.token, begin)
  await tick(1_000)
  assert.equal(calls.length, 1)
  reply = ({ indexValue }) => indexValue ? { list: [opened, ignored], total: 2, indexValue: 'page2' }
    : { list: [opened], total: 2, indexValue: 'page2' }
  await tick()
  assert.deepEqual(market.orders, [])
  await tick()
  assert.deepEqual(market.orders.map(({ scope, kind }) => [scope, kind]), [['live/' + a.id, 'open']])
  await tick(4_000)
  assert.deepEqual(calls.map(({ portfolioId }) => portfolioId), ['101', '101', '101'])
  assert.equal(calls[1].endTime, calls[2].endTime)
  assert.deepEqual(market.orders.map(({ scope, kind }) => [scope, kind]), [[`live/${a.id}`, 'open'], [`live/${b.id}`, 'open']])

  monitorBusy = true
  await tick(1_000)
  await tick(4_000)
  const response = await first.monitor.handle(new Request('http://localhost/api/monitor/status?portfolioId=101'))
  assert.match((await response.json()).portfolios[0].error, /11012005/)
  for (const [instance, user] of [[first, a], [second, b]]) {
    const strategy = await json(instance.service, 'copy', user.token)
    assert.equal(strategy.error, '')
    assert.equal(strategy.events.some(event => /监控|繁忙/.test(event.message)), false)
  }

  await json(first.service, 'copy', a.token, pause)
  await json(second.service, 'copy', b.token, pause)
  first.env.orderStore.monitorWatchlists.save(undefined, [])
  const closed = { ...opened, side: 'SELL', orderTime: epoch + 20_500, orderUpdateTime: epoch + 20_501,
    orderId: '9007199254740994' }
  monitorBusy = false
  reply = () => ({ list: [closed], total: 1 })
  await tick(1_000)
  await tick(4_000)
  assert.deepEqual(market.orders.slice(2).map(({ scope, kind }) => [scope, kind]), [[`live/${a.id}`, 'close'], [`live/${b.id}`, 'close']])
  assert.equal(calls.length, 5)
  assert.equal(market.observed.some(([, request]) => request === 'signals'), false)
})

test('a saved monitor warning is removed from the current status while execution errors remain', async t => {
  const { launch } = await harness(t)
  const { db, service } = launch()
  await json(service, 'copy', users[0].token, begin)
  const { state, revision } = db.read('live', users[0].id)
  const monitorError = '组合 101 带单成交监控暂不可用。币安查询繁忙（11012005），将自动重试。'
  const orderError = 'BTCUSDT 订单回执待核实，将按原订单号查询。'
  state.error = monitorError + ' ' + orderError
  state.events.unshift({ time: epoch, message: monitorError }, { time: epoch, message: orderError })
  assert.equal(db.write('live', users[0].id, state, revision), true)
  assert.equal((await json(service, 'copy')).error, orderError)
})

test('a restarted strategy waits for its UID, ignores missed entries, and resumes with a rotated key', async t => {
  const { launch, tick, market } = await harness(t)
  const start = () => launch(market.factory, 'live', undefined, null)
  const original = start()
  const credential = { uid: '2187', issuer: 'live', apiKey: 'copy-fixture', apiSecret: 'fixture-secret', markets: ['futures'] }
  const user = original.accounts.bind('live', credential)
  assert.equal((await json(original.service, 'copy', user.token, begin)).enabled, true)
  original.accounts.revoke('live', user.token)
  await original.service.close()
  const recovered = start()
  market.feed.push(fillSignal(200, 'open'))
  await tick()
  await tick()
  assert.deepEqual(market.orders, [])
  const login = recovered.accounts.bind('live', { ...credential, apiKey: 'replacement', apiSecret: 'new-secret' })
  assert.equal(login.id, user.id)
  await tick()
  assert.deepEqual(market.orders, [])
  market.feed.push(fillSignal(15_200, 'open'))
  await tick()
  await tick()
  assert.deepEqual(market.orders.map(order => [order.scope, order.kind]), [['live/' + user.id, 'open']])
  assert.equal((await json(recovered.service, 'copy-pnl', login.token)).pendingCount, 0)
  assert.equal((await recovered.service.fetch(packet('copy', user.token))).status, 401)
})

test('copy config validates the leader set and leverage, and an equivalent selection can resume a strategy', async t => {
  const { launch } = await harness(t)
  const { service } = launch()
  const plan = { ...config, portfolioId: undefined, portfolioIds: ['101', '202'], leverage: 150 }
  for (const invalid of [
    { portfolioIds: [] }, { portfolioIds: ['101', '101'] }, { portfolioIds: ['1X'] }, { portfolioIds: null },
    { leverage: null }, { leverage: undefined }, { leverage: '3' }, { leverage: 0 }, { leverage: 1.5 },
    { leverage: Number.MAX_SAFE_INTEGER + 1 }, { sizingMode: 'unknown' },
    { leverage: [] }, { leverage: { 125: 25 } }, { leverage: { 20: 21 } }, { leverage: { 50: 1.5 } }, { leverage: { 150: '50' } },
    { manualPositionPolicy: 'adopt' }, { manualPositionPolicy: true }, { manualPositionPolicy: null },
    { sizingMode: 'equityPercent', amount: 101 }, { sizingMode: 'equityPercent', amount: 0 },
    { portfolioIds: undefined, portfolioId: '101', sizingMode: 'margin', leverage: null },
  ]) {
    const response = await service.fetch(packet('copy', undefined, { ...begin, config: { ...plan, ...invalid } }))
    assert.equal(response.status, 400)
  }
  plan.sizingMode = 'equityPercent'
  plan.manualPositionPolicy = 'add'
  const active = await json(service, 'copy', undefined, { ...begin, config: plan })
  assert.deepEqual(active.config.portfolioIds, ['101', '202'])
  assert.equal(active.config.leverage, 150)
  assert.equal(active.config.sizingMode, 'equityPercent')
  assert.equal((await json(service, 'copy')).config.manualPositionPolicy, 'add')
  assert.equal((await json(service, 'copy', undefined, { ...begin, config: { ...plan, portfolioIds: ['202', '101'] } })).enabled, true)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, config: { ...plan, leverage: 6 } }))).status, 409)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, config: { ...plan, manualPositionPolicy: 'skip' } }))).status, 409)
})

test('maximum leverage persists and is forwarded to the signal order', async t => {
  const { launch, market, tick } = await harness(t)
  const open = t.mock.fn()
  const { service } = launch((...args) => {
    const exchange = market.factory(...args)
    return { ...exchange, open(...order) { open(...order); return exchange.open(...order) } }
  })
  const plan = { ...config, portfolioIds: ['101'], leverage: 'max', sizingMode: 'margin' }
  await json(service, 'copy', undefined, { ...begin, config: plan })
  assert.equal((await json(service, 'copy')).config.leverage, 'max')
  market.feed.push(fillSignal(200, 'open'))
  await tick()
  assert.equal(open.mock.callCount(), 1)
  assert.deepEqual(open.mock.calls[0].arguments.slice(4, 6), ['max', 'margin'])
})

test('custom leverage persists across reads, can resume, and reaches the signal order', async t => {
  const { launch, market, tick } = await harness(t)
  const open = t.mock.fn()
  const { service } = launch((...args) => {
    const exchange = market.factory(...args)
    return { ...exchange, open(...order) { open(...order); return exchange.open(...order) } }
  })
  const leverage = { 150: 50, 100: 20, 20: 5 }
  const plan = { ...config, portfolioIds: ['101'], leverage, sizingMode: 'equityPercent' }
  await json(service, 'copy', undefined, { ...begin, config: { ...plan, leverage: {} } })
  await json(service, 'copy', undefined, pause)
  await json(service, 'copy', undefined, { ...begin, config: plan })
  assert.deepEqual((await json(service, 'copy')).config.leverage, leverage)
  assert.equal((await json(service, 'copy', undefined, { ...begin, config: { ...plan, leverage: { ...leverage } } })).enabled, true)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, config: { ...plan, leverage: { ...leverage, 20: 6 } } }))).status, 409)
  market.feed.push(fillSignal(200, 'open'))
  await tick()
  assert.equal(open.mock.callCount(), 1)
  assert.deepEqual(open.mock.calls[0].arguments.slice(4, 6), [leverage, 'equityPercent'])
})

test('old stored in-flight orders retain their sole leader and exchange leverage after recovery', async t => {
  const { launch, market, tick } = await harness(t)
  const { service, db } = launch()
  await json(service, 'copy', undefined, begin)
  const record = db.read('live', 'a')
  record.state.config = config
  record.state.pending = { symbol: 'BTCUSDT', direction: 'LONG', kind: 'open', clientOrderId: 'legacy-key',
    baseQuantity: 0, baseEntries: 0, baseEntryPrice: 0, signalTime: epoch, time: epoch }
  db.write('live', 'a', record.state, record.revision)
  market.orders.push({ ...record.state.pending, scope: 'live/a', orderId: '10101' })
  market.accounts.set('live/a', [{ symbol: 'BTCUSDT', direction: 'LONG', quantity: 1, entryPrice: 50, unrealizedPnl: 4 }])
  const restored = await json(service, 'copy')
  assert.deepEqual(restored.config.portfolioIds, ['101'])
  assert.equal(restored.config.leverage, null)
  assert.equal(restored.config.sizingMode, 'notional')
  assert.equal(restored.config.manualPositionPolicy, 'skip')
  assert.equal(restored.pending.portfolioId, '101')
  assert.equal((await json(service, 'copy', undefined, { ...begin, config: restored.config })).enabled, true)
  await tick()
  assert.equal((await json(service, 'copy')).positions[0].portfolioId, '101')
  assert.equal((await json(service, 'copy-pnl')).rows[0].portfolioId, '101')
  assert.equal(market.orders.length, 1)
})

test('previously running fixed-notional strategies keep their original sizing and leverage', async t => {
  const { launch } = await harness(t)
  const { service, db } = launch()
  await json(service, 'copy', undefined, begin)
  const record = db.read('live', 'a')
  record.state.config = { ...config, leverage: 150 }
  db.write('live', 'a', record.state, record.revision)
  const original = (await json(service, 'copy')).config
  assert.equal(original.sizingMode, 'notional')
  assert.equal(original.amount, config.amount)
  assert.equal(original.leverage, 150)
  assert.equal((await json(service, 'copy', undefined, { ...begin, config: original })).enabled, true)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, config: { ...original, amount: 99 } }))).status, 409)
})

test('a streamed loss threshold wakes a leased account check before the next poll, including after pausing openings', async t => {
  const { launch, market, tick } = await harness(t)
  const socket = { readyState: 1, send() {}, close() {} }
  const connect = t.mock.fn(async () => socket)
  const { service } = launch(market.factory, 'live', connect)
  await json(service, 'copy', undefined, begin)
  market.feed.push(fillSignal(100, 'open'))
  await tick()
  assert.equal(connect.mock.callCount(), 0)
  await json(service, 'copy', undefined, pause)
  await tick()
  assert.equal(connect.mock.callCount(), 1)
  market.accounts.get('live/a')[0].unrealizedPnl = -21
  socket.onmessage({ data: JSON.stringify({ e: 'markPriceUpdate', E: Date.now(), s: 'BTCUSDT', p: '29' }) })
  await flush()
  assert.deepEqual(market.orders.map(row => row.kind), ['open', 'close'])
  assert.equal((await json(service, 'copy')).positions.length, 0)
})

test('copy APIs authenticate both reads and writes, validate the intended environment and isolate each user’s strategy and settled ledger', async t => {
  const { launch, tick, market } = await harness(t)
  const { db, service } = launch()
  assert.equal((await service.fetch(packet('copy', 'invalid', begin))).status, 401)
  assert.equal((await service.fetch(packet('copy-pnl', 'invalid'))).status, 401)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, environment: 'testnet' }))).status, 409)
  assert.equal((await service.fetch(packet('copy', undefined, { ...begin, config: { ...config, amount: -10 } }))).status, 400)
  assert.equal((await service.fetch(packet('copy-pnl?page=0'))).status, 400)
  assert.equal((await service.fetch(packet('copy-pnl', undefined, pause))).status, 405)
  const active = await json(service, 'copy', undefined, begin)
  assert.equal(active.enabled, true)
  assert(!('keyIdentity' in active))
  assert.equal(db.write('testnet', users[0].id, db.read('live', users[0].id).state, 0), true)
  const archived = db.read('testnet', users[0].id)
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
  assert.deepEqual(db.read('testnet', users[0].id), archived)
  assert.deepEqual(market.orders.map(o => [o.scope, o.kind]), [['live/a', 'open'], ['live/a', 'close']])
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
  assert.equal(other.db.ready('live', Date.now()).length, 0)
  assert.equal((await json(other.service, 'copy', undefined, pause)).enabled, false)
  held.resolve()
  await flush()
  const end = await json(service, 'copy')
  assert.equal(end.enabled, false)
  assert.equal(end.pending, null)
  assert.equal(market.orders.length, 0)
})

test('a long multi-leader poll renews its SQLite lease and records progress while another process waits', async t => {
  const { launch, market, tick } = await harness(t)
  const held = Promise.withResolvers()
  const pending = Promise.withResolvers()
  const { service } = launch((...args) => {
    const api = market.factory(...args)
    return { ...api, async signals(id) {
      if (id === '202') { pending.resolve(); await held.promise }
      return []
    } }
  })
  const other = launch()
  await json(service, 'copy', undefined, { ...begin, config: { ...config, portfolioIds: ['101', '202'], leverage: 3 } })
  await tick()
  await pending.promise
  for (let elapsed = 0; elapsed < 120_000; elapsed += 30_000) await tick(30_000)
  assert.equal(other.db.claim('live', 'a', 'competitor', Date.now()), false)
  held.resolve()
  await flush()
  const { state } = other.db.read('live', 'a')
  assert.equal(state.feeds['101'].since, epoch + 5000)
  assert.equal(state.feeds['202'].since, epoch + 5000)
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
      positions: async () => ({ mode: 'oneWay', positions: [] }),
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
  const saved = db.read('live', 'a').state.pending
  assert.equal(saved.kind, 'open')
  market.orders.push({ ...saved, scope: 'live/a', orderId: '10101' })
  market.accounts.set('live/a', [{ symbol: 'BTCUSDT', direction: 'LONG', quantity: 1, entryPrice: 50, unrealizedPnl: 4 }])
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
        market.accounts.get('live/a')[0].quantity = 0.4
        return orderAck(market.orders[0], 'PARTIALLY_FILLED', 0.4)
      },
      async lookup(symbol, key) {
        const order = market.orders.find(o => o.symbol === symbol && o.clientOrderId === key)
        if (full) market.accounts.get('live/a')[0].quantity = 1
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
