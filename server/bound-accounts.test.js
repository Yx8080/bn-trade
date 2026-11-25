import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'

const pair = { apiKey: 'fixture-api-key-only', apiSecret: 'fixture-api-secret-only' }
const both = { ...pair, uid: '733992', issuer: 'live', markets: ['spot', 'futures'] }
const rotated = { ...both, apiKey: 'fixture-rotated-key', apiSecret: 'fixture-rotated-secret' }
const digest = s => createHash('sha256').update(s).digest('hex')
const derived = (env, key) => 'bound-' + digest(env + '\0' + key)

async function filenameFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bn-uid-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'orders.sqlite')
}

function legacyPlatformOrder(db, owner, key, market, client, environment = 'live') {
  db.prepare('INSERT INTO order_requests VALUES (?,?,?,?)').run(environment, market, owner, client)
  db.prepare(`INSERT INTO platform_orders(environment,user_id,market,client_id,key_identity,symbol,side,type,time,order_id)
    VALUES (?,?,?,?,?,'BTCUSDT','BUY','MARKET',123,?)`).run(environment, owner, market, client, digest(key), client)
  db.prepare(`INSERT INTO platform_fills VALUES (?,?,?,?, '9',123,'1',10,10,0,'USDT',0,'USDT')`)
    .run(environment, owner, market, client)
  db.prepare(`INSERT INTO platform_fill_scans VALUES (?,?,?,?,'10')`).run(environment, owner, market, client)
}

test('UID owns the journal across key rotation and restart; credentials and browser sessions never persist', async t => {
  const filename = await filenameFor(t)
  let db = createLocalOrderDb(filename)
  let first
  try {
    first = db.accounts.bind('live', both)
    assert.equal(first.id, 'uid:' + both.uid)
    assert.equal(first.uid, both.uid)
    assert.equal(first.previousWorkspaceId, derived('live', pair.apiKey))
    assert.ok(!JSON.stringify(first).includes(pair.apiKey))
    assert.ok(!JSON.stringify(first).includes(pair.apiSecret))
    assert.equal(db.accounts.resolveSession('testnet', first.token), null)
    assert.deepEqual(db.accounts.connectedOwners('live', 'spot'), [first.id])
    assert(db.reserve('live', 'futures', first.id, 'my-order'))
    assert(db.accounts.revoke('live', first.token))
    assert.equal(db.accounts.resolveSession('live', first.token), null)
    assert.equal(db.accounts.getUserById('live', first.id).apiSecret, pair.apiSecret)
  } finally { db.close() }
  assert.equal(existsSync(filename + '.vault-key'), false)
  const bytes = await readFile(filename)
  for (const s of [pair.apiKey, pair.apiSecret, digest(pair.apiKey), first.previousWorkspaceId, first.token]) {
    assert.equal(bytes.includes(s), false)
  }
  db = createLocalOrderDb(filename)
  try {
    assert.equal(db.accounts.getUserById('live', first.id), null)
    assert.equal(db.accounts.hasAccounts('live'), false)
    assert.equal(db.accounts.resolveSession('live', first.token), null)
    const next = db.accounts.bind('live', rotated)
    assert.equal(next.id, first.id)
    assert.equal(db.reserve('live', 'futures', next.id, 'my-order'), false)
    assert.equal(db.accounts.getUserById('live', next.id).apiKey, rotated.apiKey)
    const other = db.accounts.bind('live', { ...both, uid: '106', apiKey: 'key-for-different-uid' })
    assert.notEqual(next.id, other.id)
    assert(db.reserve('live', 'futures', other.id, 'my-order'))
  } finally { db.close() }
})

test('market-specific sessions do not acquire replacement credentials or new rights', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const { accounts } = db
  const initial = accounts.bind('live', both)
  const connectedAt = accounts.getUserById('live', initial.id).futuresConnectedAt
  t.mock.timers.tick(1000)
  const spot = accounts.bind('live', { ...rotated, markets: ['spot'] })
  assert.deepEqual(accounts.resolveSession('live', initial.token).markets, ['futures'])
  assert.deepEqual(accounts.resolveSession('live', spot.token).markets, ['spot'])
  assert.equal(accounts.getUserById('live', initial.id).apiSecret, pair.apiSecret)
  assert.equal(accounts.getUserById('live', initial.id).spotApiSecret, rotated.apiSecret)
  const newFutures = accounts.bind('live', { ...rotated, unavailableMarkets: ['spot'], markets: ['futures'] })
  assert.equal(accounts.resolveSession('live', initial.token), null)
  assert.equal(accounts.resolveSession('live', newFutures.token).spotApiKey, undefined)
  assert.equal(accounts.getUserById('live', initial.id).futuresConnectedAt, connectedAt)
  accounts.bind('live', { ...rotated, markets: ['futures'] })
  assert.equal(accounts.resolveSession('live', spot.token), null)
  assert.equal(accounts.getUserById('live', initial.id).spotApiKey, undefined)
  t.mock.timers.tick(12 * 3_600_000)
  assert.equal(accounts.resolveSession('live', newFutures.token), null)
  assert.deepEqual(accounts.connectedOwners('live', 'futures'), [initial.id])
})

test('both test issuers and production isolate equal numeric UIDs; missing or ambiguous identities fail closed', t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const spot = db.accounts.bind('testnet', { ...both, issuer: 'spot-testnet', markets: ['spot'] })
  const demo = db.accounts.bind('testnet', { ...both, issuer: 'demo', markets: ['futures'] })
  const live = db.accounts.bind('live', both)
  assert.equal(new Set([spot.id, demo.id, live.id]).size, 3)
  assert.equal(db.accounts.resolveSession('testnet', spot.token).apiKey, undefined)
  assert.equal(db.accounts.resolveSession('live', demo.token), null)
  assert.deepEqual(db.accounts.connectedOwners('testnet', 'spot'), [spot.id])
  for (const [environment, props] of [['testnet', both], ['live', { ...both, uid: '01' }],
    ['live', { ...both, uid: '' }], ['live', { ...both, uid: 123 }], ['testnet', { ...both, issuer: 'demo' }]]) {
    assert.throws(() => db.accounts.bind(environment, props), { code: 'INVALID_BINDING' })
  }
})

test('upgrade erases obsolete vault rows and claims only the matching key’s pre-UID orders, children and strategy', async t => {
  const filename = await filenameFor(t)
  createLocalOrderDb(filename).close()
  const raw = new DatabaseSync(filename)
  const legacy = 'old-workstation'
  const fingerprint = digest(pair.apiKey)
  try {
    raw.exec(`CREATE TABLE bound_accounts(environment,user_id,key_hash,name,scopes,credentials);
      CREATE TABLE bound_sessions(token_hash,environment,user_id,scopes,expires_at);`)
    raw.prepare('INSERT INTO bound_accounts VALUES (?,?,?,?,?,?)').run('live', legacy, fingerprint, 'prior account', 3,
      Buffer.from('synthetic-former-encrypted-payload'))
    legacyPlatformOrder(raw, legacy, pair.apiKey, 'spot', 'old-order')
    legacyPlatformOrder(raw, 'former-configured-user', pair.apiKey, 'spot', 'orphan-order')
    legacyPlatformOrder(raw, legacy, 'key-for-unrelated-account', 'spot', 'foreign-order')
    raw.prepare('INSERT INTO order_requests VALUES (?,?,?,?)').run('live', 'spot', legacy, 'unattributed')
    const state = JSON.stringify({ enabled: false, pending: null, positions: [], keyIdentity: fingerprint })
    raw.prepare('INSERT INTO copy_strategies(environment,user_id,state,revision,runnable) VALUES (?,?,?,1,0)')
      .run('live', legacy, state)
    raw.prepare(`INSERT INTO copy_executions(environment,user_id,client_id,order_id,portfolio_id,key_identity,symbol,direction,kind,time,quantity,price)
      VALUES ('live',?,'copy-order','25','lead',?,'BTCUSDT','LONG','open',4,1,10)`).run(legacy, fingerprint)
  } finally { raw.close() }
  const db = createLocalOrderDb(filename)
  const read = new DatabaseSync(filename)
  try {
    const before = db.accounts.bind('live', rotated)
    assert.equal(db.platform.report('live', before.id).rows.length, 0)
    const proven = db.accounts.bind('live', both)
    assert.equal(before.id, proven.id)
    assert.equal(db.copy.read('live', proven.id).state.keyIdentity, proven.id)
    assert.equal(db.copy.pnl('live', proven.id, 1, proven.id).rows[0].orderId, '25')
    assert.deepEqual(db.platform.report('live', proven.id, 1, { spot: proven.id }).rows.map(o => o.clientOrderId).sort(),
      ['old-order', 'orphan-order'])
    for (const table of ['platform_orders', 'platform_fills', 'platform_fill_scans', 'order_requests']) {
      assert.equal(read.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=?`).get(proven.id).n, 2)
    }
    assert.equal(db.platform.report('live', legacy).rows[0].clientOrderId, 'foreign-order')
    assert.equal(db.reserve('live', 'spot', legacy, 'unattributed'), false)
    assert.equal(read.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('bound_accounts','bound_sessions')").get().n, 0)
    assert.equal(db.accounts.bind('live', rotated).id, proven.id)
  } finally { read.close(); db.close() }
  assert.equal((await readFile(filename)).includes('synthetic-former-encrypted-payload'), false)
})

test('test issuer recovery moves only its own market even when pre-UID owners match; conflicting claims roll back', async t => {
  const filename = await filenameFor(t)
  const db = createLocalOrderDb(filename)
  const raw = new DatabaseSync(filename)
  try {
    const oldId = derived('testnet', pair.apiKey)
    legacyPlatformOrder(raw, oldId, pair.apiKey, 'spot', 'original-spot', 'testnet')
    legacyPlatformOrder(raw, oldId, pair.apiKey, 'futures', 'original-futures', 'testnet')
    const spot = db.accounts.bind('testnet', { ...both, issuer: 'spot-testnet', markets: ['spot'] })
    assert.equal(db.platform.report('testnet', spot.id).rows.length, 1)
    assert.equal(db.platform.report('testnet', oldId).rows[0].clientOrderId, 'original-futures')
    const demo = db.accounts.bind('testnet', { ...both, issuer: 'demo', markets: ['futures'] })
    assert.equal(db.platform.report('testnet', demo.id).rows[0].clientOrderId, 'original-futures')
    legacyPlatformOrder(raw, derived('testnet', rotated.apiKey), rotated.apiKey, 'spot', 'original-spot', 'testnet')
    assert.throws(() => db.accounts.bind('testnet', { ...rotated, issuer: 'spot-testnet', markets: ['spot'] }),
      { code: 'ACCOUNT_HISTORY_CONFLICT' })
    assert.equal(db.accounts.getUserById('testnet', spot.id).spotApiKey, pair.apiKey)
    assert.equal(db.platform.report('testnet', derived('testnet', rotated.apiKey)).rows.length, 1)
  } finally { raw.close(); db.close() }
})
