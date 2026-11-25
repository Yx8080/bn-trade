import assert from 'node:assert/strict'
import test from 'node:test'
import { bindAccount, getBindingEnvironment, getCopyStatus, getSelectedEnvironment, getSpotQuote, revokeSession,
  selectEnvironment, setUnauthorizedHandler, submitOrder, updateCopyStatus } from '../src/futures.ts'
import { pendingOrderKey, readPending, restorePreviousPending, writePending } from '../src/components/pendingOrder.ts'

const credentials = { environment: 'testnet', apiKey: 'sample-key', apiSecret: 'sample-secret' }
const capabilities = { identity: 'binance-uid', credentialStorage: 'memory' }
const uid = '12345678901234567890'
const session = { environment: 'testnet', id: 'uid:spot-testnet:' + uid, uid, issuer: 'spot-testnet',
  name: '测试账户', markets: ['spot'], expiresAt: Date.now() + 60_000, token: 'sample-session' }

test('读取服务环境、验证凭据和注销使用正确的请求位置', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push([url, init.method])
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('X-Trading-Environment'), 'testnet')
    if (init.method === 'GET') return Response.json({ environment: 'testnet', ...capabilities })
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { ...credentials, identity: 'binance-uid' })
      assert.equal(new Headers(init.headers).has('Authorization'), false)
      return Response.json(session)
    }
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer sample-session')
    assert.equal(init.body, undefined)
    return new Response(null, { status: 204 })
  })
  assert.equal(await getBindingEnvironment(), 'testnet')
  assert.deepEqual(await bindAccount(credentials), session)
  await revokeSession(session.token)
  assert.deepEqual(calls, [['/api/accounts/bind', 'GET'], ['/api/accounts/bind', 'POST'], ['/api/accounts/session', 'DELETE']])
})

test('切换时仅请求选中的环境，迟到的会话清理回到发起绑定的环境', async t => {
  const calls = []
  const pending = Promise.withResolvers()
  t.after(() => selectEnvironment('testnet'))
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const environment = new Headers(init.headers).get('X-Trading-Environment')
    calls.push([init.method, environment])
    if (init.method === 'POST') return pending.promise
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ environment, ...capabilities })
  })
  selectEnvironment('live')
  assert.equal(getSelectedEnvironment(), 'live')
  assert.equal(await getBindingEnvironment(), 'live')
  const login = bindAccount({ ...credentials, environment: 'live' })
  selectEnvironment('testnet')
  await getCopyStatus('testnet-token')
  await getSpotQuote('BTCUSDT', undefined, 'testnet')
  pending.resolve(Response.json({ ...session, environment: 'live', markets: [] }))
  await assert.rejects(login, /无效的会话/)
  assert.deepEqual(calls, [['GET','live'], ['POST','live'], ['GET','testnet'], ['GET','testnet'], ['DELETE','live']])
})

test('只在后台明确支持内存密钥和 UID 时允许打开绑定表单', async t => {
  let fields = {}
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    return Response.json({ environment: 'testnet', ...fields })
  })
  for (fields of [{}, { identity: 'binance-uid', credentialStorage: 'sqlite' }, { credentialStorage: 'memory' }]) {
    await assert.rejects(getBindingEnvironment(), { code: 'INCOMPATIBLE_BINDING', message: /重启/ })
  }
  fields = capabilities
  assert.equal(await getBindingEnvironment(), 'testnet')
})

test('拒绝提交其他环境的订单、跟单和密钥，阻止过期环境回执进入绑定表单', async t => {
  selectEnvironment('live')
  t.after(() => selectEnvironment('testnet'))
  const transport = t.mock.method(globalThis, 'fetch', () => Response.json({ environment: 'testnet' }))
  await assert.rejects(bindAccount(credentials), { code: 'ENVIRONMENT_CHANGED' })
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

test('已验证的实盘旧工作区可以恢复待核实订单，测试平台各自隔离', async t => {
  const oldId = 'bound-' + 'e'.repeat(64)
  const serverReply = { ...session, id: 'uid:42', uid: '42', issuer: 'live', environment: 'live', previousWorkspaceId: oldId }
  const records = new Map()
  t.mock.method(globalThis, 'fetch', () => Response.json({ ...serverReply, apiSecret: 'unexpected' }))
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key),
  } })
  t.after(() => {
    selectEnvironment('testnet')
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else delete globalThis.sessionStorage
  })
  selectEnvironment('live')
  const result = await bindAccount({ ...credentials, environment: 'live' })
  assert.deepEqual(result, serverReply)
  const prior = pendingOrderKey(oldId, 'live', 'spot')
  const current = pendingOrderKey(result.id, 'live', 'spot')
  const order = { clientOrderId: 'original', symbol: 'BTCUSDT' }
  writePending(prior, order)
  restorePreviousPending(result)
  assert.equal(readPending(prior), null)
  assert.deepEqual(readPending(current), order)
  selectEnvironment('testnet')
  serverReply.environment = 'testnet'
  serverReply.id = 'uid:spot-testnet:42'
  serverReply.issuer = 'spot-testnet'
  const testSession = await bindAccount(credentials)
  assert.equal('previousWorkspaceId' in testSession, false)
  assert.equal(readPending(pendingOrderKey(testSession.id, 'testnet', 'spot')), null)
  writePending(current, null)
})

test('非安全网页在发送密钥前停止绑定', async t => {
  Object.defineProperty(globalThis, 'window', { value: { isSecureContext: false }, configurable: true })
  t.after(() => { delete globalThis.window })
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected request') })
  await assert.rejects(bindAccount(credentials), /HTTPS/)
  assert.equal(fetch.mock.callCount(), 0)
})
