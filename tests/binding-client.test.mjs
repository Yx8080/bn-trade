import assert from 'node:assert/strict'
import test from 'node:test'
import { bindAccount, getBindingEnvironment, getCopyStatus, getSpotQuote, revokeSession,
  setUnauthorizedHandler, submitOrder, updateCopyStatus } from '../src/futures.ts'
import { pendingOrderKey, readPending, restorePreviousPending, writePending } from '../src/components/pendingOrder.ts'

const credentials = { environment: 'live', apiKey: 'sample-key', apiSecret: 'sample-secret' }
const capabilities = { identity: 'binance-uid', credentialStorage: 'memory' }
const uid = '12345678901234567890'
const session = { environment: 'live', id: 'uid:' + uid, uid, issuer: 'live',
  name: '测试账户', markets: ['spot'], expiresAt: Date.now() + 60_000, token: 'sample-session' }

test('读取服务环境、验证凭据和注销使用正确的请求位置', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push([url, init.method])
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('X-Trading-Environment'), 'live')
    if (init.method === 'GET') return Response.json({ environment: 'live', ...capabilities })
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { ...credentials, identity: 'binance-uid' })
      assert.equal(new Headers(init.headers).has('Authorization'), false)
      return Response.json(session)
    }
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer sample-session')
    assert.equal(init.body, undefined)
    return new Response(null, { status: 204 })
  })
  assert.equal(await getBindingEnvironment(), 'live')
  assert.deepEqual(await bindAccount(credentials), session)
  await revokeSession(session.token)
  assert.deepEqual(calls, [['/api/accounts/bind', 'GET'], ['/api/accounts/bind', 'POST'], ['/api/accounts/session', 'DELETE']])
})

test('公开行情、跟单查询和无效会话回收都使用实盘', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const environment = new Headers(init.headers).get('X-Trading-Environment')
    calls.push([init.method, environment])
    if (init.method === 'POST') return Response.json({ ...session, markets: [] })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({})
  })
  await getCopyStatus('fixture-token')
  await getSpotQuote('BTCUSDT')
  await assert.rejects(bindAccount(credentials), /无效的会话/)
  assert.deepEqual(calls, [['GET', 'live'], ['GET', 'live'], ['POST', 'live'], ['DELETE', 'live']])
})

test('只在后台明确支持内存密钥和 UID 时允许打开绑定表单', async t => {
  let fields = {}
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    return Response.json({ environment: 'live', ...fields })
  })
  for (fields of [{}, { identity: 'binance-uid', credentialStorage: 'sqlite' }, { credentialStorage: 'memory' }]) {
    await assert.rejects(getBindingEnvironment(), { code: 'INCOMPATIBLE_BINDING', message: /重启/ })
  }
  fields = capabilities
  assert.equal(await getBindingEnvironment(), 'live')
})

test('拒绝提交其他环境的订单、跟单和密钥，阻止过期环境回执进入绑定表单', async t => {
  const transport = t.mock.method(globalThis, 'fetch', () => Response.json({ environment: 'testnet' }))
  await assert.rejects(bindAccount({ ...credentials, environment: 'testnet' }), { code: 'ENVIRONMENT_CHANGED' })
  await assert.rejects(submitOrder('previous', { symbol: 'BTCUSDT', clientOrderId: 'old', environment: 'testnet',
    positionSide: 'BOTH', side: 'BUY', type: 'MARKET', quantity: '1' }), { code: 'ENVIRONMENT_CHANGED' })
  await assert.rejects(updateCopyStatus('previous', { action: 'pause', environment: 'testnet' }), { code: 'ENVIRONMENT_CHANGED' })
  assert.equal(transport.mock.callCount(), 0)
  await assert.rejects(getBindingEnvironment(), { code: 'ENVIRONMENT_CHANGED' })
})

test('绑定错误使用安全提示并回收无法验证的成功会话', async t => {
  let malformed = false
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push(init.method)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return malformed ? Response.json({ ...session, uid: undefined })
      : Response.json({ code: 'BINDING_REJECTED', message: 'echo ' + credentials.apiSecret }, { status: 403 })
  })
  await assert.rejects(bindAccount(credentials), error => error.message.includes('验证失败') && !error.message.includes(credentials.apiSecret))
  malformed = true
  await assert.rejects(bindAccount(credentials), /无效的会话/)
  assert.deepEqual(calls, ['POST', 'POST', 'DELETE'])
})

test('只对服务端确认无效的登录会话触发退出', async t => {
  const tokens = []
  setUnauthorizedHandler(token => tokens.push(token))
  t.after(() => setUnauthorizedHandler())
  let code = 'BINANCE_REJECTED'
  t.mock.method(globalThis, 'fetch', () => Response.json({ code }, { status: 401 }))
  await assert.rejects(getCopyStatus('valid-session'))
  code = 'UNAUTHORIZED'
  await assert.rejects(getCopyStatus('expired-session'))
  assert.deepEqual(tokens, ['expired-session'])
})

test('旧工作区忙、迁移冲突和绑定协议不兼容给出具体提示', async t => {
  let code
  t.mock.method(globalThis, 'fetch', () => Response.json({ code }, { status: 409 }))
  for (const [errorCode, expected] of [
    ['ACCOUNT_HISTORY_BUSY', /等当前任务完成/], ['ACCOUNT_HISTORY_CONFLICT', /核对两边的策略和订单/],
    ['BINDING_POLICY_MISMATCH', /重启新版交易服务/],
  ]) {
    code = errorCode
    await assert.rejects(bindAccount(credentials), expected)
  }
})

test('只允许已验证的实盘旧工作区恢复待核实订单', async t => {
  const oldId = 'bound-' + 'e'.repeat(64)
  const serverReply = { ...session, id: 'uid:42', uid: '42', issuer: 'live', environment: 'live', previousWorkspaceId: oldId }
  const records = new Map()
  t.mock.method(globalThis, 'fetch', (_url, init) => init.method === 'DELETE' ? new Response(null, { status: 204 })
    : Response.json({ ...serverReply, apiSecret: 'unexpected' }))
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key),
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else delete globalThis.sessionStorage
  })
  const result = await bindAccount({ ...credentials, environment: 'live' })
  assert.deepEqual(result, serverReply)
  const prior = pendingOrderKey(oldId, 'live', 'spot')
  const current = pendingOrderKey(result.id, 'live', 'spot')
  const order = { clientOrderId: 'original', symbol: 'BTCUSDT' }
  writePending(prior, order)
  restorePreviousPending(result)
  assert.equal(readPending(prior), null)
  assert.deepEqual(readPending(current), order)
  serverReply.environment = 'testnet'
  serverReply.id = 'uid:spot-testnet:42'
  serverReply.issuer = 'spot-testnet'
  await assert.rejects(bindAccount(credentials), /无效的会话/)
  assert.equal(readPending(pendingOrderKey(serverReply.id, 'testnet', 'spot')), null)
  writePending(current, null)
})

test('非安全网页在发送密钥前停止绑定', async t => {
  Object.defineProperty(globalThis, 'window', { value: { isSecureContext: false }, configurable: true })
  t.after(() => { delete globalThis.window })
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected request') })
  await assert.rejects(bindAccount(credentials), /HTTPS/)
  assert.equal(fetch.mock.callCount(), 0)
})
