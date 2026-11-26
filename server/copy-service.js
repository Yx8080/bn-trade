import { randomUUID } from 'node:crypto'
import { isCopyLeverageOverrides } from '../shared/leverage.js'
import { ApiError, apiErrorResponse, getTradingEnvironment, getTradingUser, getTradingUserById, isValidLeverage, jsonResponse, readOrderJson } from '../worker/trading.js'
import { createCopyExchange } from './copy-exchange.js'
import { runCopyTick } from './copy-engine.js'
import { createMarkWatch } from './mark-watch.js'
import { otherTrades } from './other-trades.js'
import { ledgerIdentity } from './platform-store.js'

const interval = 5000
const keyIdentity = user => ledgerIdentity(user.id, user.apiKey)
const busy = () => new ApiError(409, 'COPY_CHANGED', '跟单状态刚刚更新，请刷新后重试。')

export function settlementAmounts(fills, expectedQuantity) {
  const totals = new Map()
  function currency(asset) {
    if (!totals.has(asset)) totals.set(asset, { asset, realized: 0, fees: 0 })
    return totals.get(asset)
  }
  let quantity = 0
  for (const fill of fills) {
    if (!Number.isFinite(fill.quantity) || fill.quantity <= 0 || !Number.isFinite(fill.realized)
      || !Number.isFinite(fill.commission) || !fill.commissionAsset) return null
    quantity += fill.quantity
    currency('USDT').realized += fill.realized
    currency(fill.commissionAsset).fees += fill.commission
  }
  if (!quantity || Math.abs(quantity - expectedQuantity) > expectedQuantity * 1e-10) return null
  return [...totals.values()].map(row => ({ ...row, net: row.realized - row.fees }))
}

function emptyState() {
  return { enabled: false, config: null, positions: [], events: [], lastCheck: null, error: '', pending: null, since: 0, seen: [] }
}

function publicState(state) {
  const { enabled, config, positions, events, lastCheck, error, pending } = state
  return { enabled, config, positions, events, lastCheck, error,
    pending: pending && { symbol: pending.symbol, portfolioId: pending.portfolioId, clientOrderId: pending.clientOrderId } }
}

function parseConfig(input) {
  const positive = value => Number.isFinite(value) && value > 0 && Number(value.toFixed(8)) === value
    && Number.isSafeInteger(Math.round(value * 1e8))
  const count = value => Number.isInteger(value) && value >= 1 && value <= 100
  const portfolioIds = input?.portfolioIds === undefined ? [input?.portfolioId] : input.portfolioIds
  if (!Array.isArray(portfolioIds) || !portfolioIds.length || new Set(portfolioIds).size !== portfolioIds.length
    || portfolioIds.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id))) {
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '请选择至少一个有效的带单组合，每个组合只能选择一次。')
  }
  if (input.leverage != null && input.leverage !== 'max' && !isValidLeverage(input.leverage) && !isCopyLeverageOverrides(input.leverage))
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '杠杆须为正整数，自定义倍数须在对应档位范围内。')
  // Clients and strategies created before margin sizing used a fixed notional.
  const sizingMode = input.sizingMode === undefined ? 'notional' : input.sizingMode
  if (!['notional', 'margin', 'equityPercent'].includes(sizingMode))
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '跟单金额模式无效。')
  if (sizingMode !== 'notional' && input.leverage == null)
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '按保证金开仓需要填写杠杆倍数。')
  if (sizingMode === 'equityPercent' && (!positive(input.amount) || input.amount > 100))
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '每次使用的合约账户总权益比例须大于 0 且不超过 100%。')
  const manualPositionPolicy = input.manualPositionPolicy === undefined ? 'skip' : input.manualPositionPolicy
  if (!['skip', 'add'].includes(manualPositionPolicy))
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '请选择已有平台手动同向仓位时的处理方式。')
  if (!positive(input.amount) || !positive(input.stopLoss) || !count(input.maxPositions)
    || !['first', 'fixed'].includes(input.repeat) || !count(input.maxEntries)) {
    throw new ApiError(400, 'INVALID_COPY_CONFIG', '请检查每次开仓金额、仓位数、开仓次数和止损金额。')
  }
  return { portfolioIds: [...portfolioIds].sort(), leverage: input.leverage ?? null, sizingMode, amount: input.amount, repeat: input.repeat, manualPositionPolicy,
    maxEntries: input.repeat === 'first' ? 1 : input.maxEntries, maxPositions: input.maxPositions, stopLoss: input.stopLoss }
}

function restoreState(state) {
  if (state.config) {
    state.config = parseConfig(state.config)
    if (state.config.portfolioIds.length === 1) {
      const [owner] = state.config.portfolioIds
      for (const position of state.positions) position.portfolioId ??= owner
      if (state.pending) state.pending.portfolioId ??= owner
    }
  }
  return state
}

export function createCopyService(env, exchangeFor = createCopyExchange) {
  const startedAt = Date.now()
  const running = new Map()
  let settlement
  let nextSettlementAt = 0
  let markWatch
  let stopped = false
  const store = () => env.orderStore.copy

  async function run(environment, id) {
    const owner = randomUUID()
    const db = store()
    if (!db.claim(environment, id, owner, Date.now())) return
    let leaseLost = false
    // Reading several paginated leaders can outlast one lease. Only the original
    // owner can extend a still-valid lease; a crashed process stops renewing.
    const heartbeat = setInterval(() => {
      if (leaseLost || stopped) return
      try { leaseLost = !db.renew(environment, id, owner, Date.now()) }
      catch { leaseLost = true }
    }, 30_000)
    heartbeat.unref()
    let delay = interval
    try {
      const record = db.read(environment, id)
      const state = restoreState(record.state)
      const save = (updated, fill) => {
        if (stopped || leaseLost || !db.write(environment, id, updated, record.revision, owner, fill)) throw busy()
        record.revision++
      }
      const user = getTradingUserById(env, id)
      if (!user?.apiKey || !user.apiSecret || state.keyIdentity !== keyIdentity(user)) {
        state.enabled = false
        state.error = '跟单账户的合约密钥已变更或移除，请先核对原账户的仓位和订单。'
        save(state)
        delay = 60_000
        return
      }
      state.openedAfter = Math.max(state.openedAfter ?? state.since, startedAt, user.futuresConnectedAt ?? 0)
      await runCopyTick(state, exchangeFor(env, user, environment), save)
      delay = Math.max(interval, (state.retryAt ?? 0) - Date.now())
    } finally {
      clearInterval(heartbeat)
      db.release(environment, id, owner, Date.now() + delay)
    }
  }

  async function settleDue(environment, owners) {
    const db = store()
    for (const row of db.settlementsDue(environment, Date.now(), owners)) {
      if (stopped || !db.claimSettlement(environment, row, Date.now())) continue
      try {
        const user = getTradingUserById(env, row.userId)
        if (!user?.apiKey || keyIdentity(user) !== row.keyIdentity) continue
        const fills = await exchangeFor(env, user, environment).fills(row.symbol, row.orderId)
        const amounts = settlementAmounts(fills, row.quantity)
        if (amounts) db.settle(environment, row, amounts)
      } catch (error) {
        console.warn('跟单成交明细尚未核对', error?.code ?? error?.name)
        if (error?.status === 429 || error?.status === 418) {
          const header = error.headers?.['Retry-After']
          const deadline = /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header)
          nextSettlementAt = Math.max(Date.now() + 60_000, Number.isSafeInteger(deadline) ? deadline : 0)
          db.delaySettlement(environment, row, nextSettlementAt)
          break
        }
      }
    }
  }

  function launch(environment, id) {
    if (running.has(id) || stopped) return
    const job = run(environment, id).catch(error => {
      if (error?.code !== 'COPY_CHANGED') console.warn('跟单轮询失败', error?.code ?? error?.name)
    }).finally(() => running.delete(id))
    running.set(id, job)
  }

  function poll() {
    if (stopped) return
    try {
      const environment = getTradingEnvironment(env)
      if (!env.BINANCE_FUTURES_USERS && !env.orderStore.accounts.hasAccounts(environment)) return
      const owners = env.verifyConfiguredUser || !env.BINANCE_FUTURES_USERS
        ? env.orderStore.accounts.connectedOwners(environment, 'futures') : undefined
      if (env.openMarkStream) {
        markWatch ??= createMarkWatch(env.openMarkStream, id => {
          if (stopped || running.has(id)) return
          try {
            if (store().wakeRisk(environment, id, Date.now())) launch(environment, id)
          } catch (error) { console.warn('跟单止损检查暂不可用', error?.code ?? error?.name) }
        })
        markWatch.update(store().exposures(environment, Date.now(), owners))
      }
      if (!settlement && Date.now() >= nextSettlementAt) settlement = settleDue(environment, owners).catch(error => {
        console.warn('跟单盈亏核对失败', error?.code ?? error?.name)
      }).finally(() => { settlement = undefined })
      for (const id of store().ready(environment, Date.now(), owners)) {
        if (running.size >= 4) break
        launch(environment, id)
      }
    } catch (error) {
      console.warn('无法读取跟单任务', error?.code ?? error?.name)
    }
  }
  const timer = setInterval(poll, interval)
  timer.unref()

  return {
    async fetch(request) {
      try {
        const user = await getTradingUser(request, env)
        const environment = getTradingEnvironment(env)
        const db = store()
        const url = new URL(request.url)
        if (url.pathname === '/api/futures/other-trades') {
          if (request.method !== 'GET') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET' })
          return jsonResponse(await otherTrades(env, user, environment, url.searchParams.get('market') ?? 'futures',
            url.searchParams.get('symbol'), url.searchParams.get('scope') ?? 'other'))
        }
        if (url.pathname === '/api/futures/copy-pnl') {
          if (request.method !== 'GET') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET' })
          const page = Number(url.searchParams.get('page') ?? 1)
          if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / 20))
            throw new ApiError(400, 'INVALID_PAGE', '页码无效。')
          return jsonResponse(db.pnl(environment, user.id, page, user.apiKey ? keyIdentity(user) : ''))
        }
        if (user.markets && !user.markets.includes('futures'))
          throw new ApiError(403, 'FUTURES_NOT_CONFIGURED', '请绑定具有合约读取权限的币安密钥。')
        const record = db.read(environment, user.id)
        let state = restoreState(record?.state ?? emptyState())
        if (request.method === 'GET') return jsonResponse(publicState(state))
        if (request.method !== 'POST') return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: 'GET, POST' })
        const { action, config: input, environment: confirmed } = await readOrderJson(request)
        if (confirmed !== environment) throw new ApiError(409, 'ENVIRONMENT_CHANGED', '交易环境已变更，请重新确认。')
        if (action === 'pause') {
          if (!state.enabled) return jsonResponse(publicState(state))
          state.enabled = false
        } else if (action === 'start') {
          if (!user.apiKey || !user.apiSecret) throw new ApiError(503, 'FUTURES_NOT_CONFIGURED', '此账户尚未配置合约密钥。')
          const config = parseConfig(input)
          const same = JSON.stringify(config) === JSON.stringify(state.config) && keyIdentity(user) === state.keyIdentity
          // Original single-leader clients used their exchange leverage. Keep
          // those requests and exact resumes compatible, but require a leverage
          // choice when starting or editing a strategy via the new form.
          if (input.portfolioIds !== undefined && config.leverage === null && !same)
            throw new ApiError(400, 'INVALID_COPY_CONFIG', '请填写跟单杠杆倍数。')
          if (same && state.enabled) return jsonResponse(publicState(state))
          if (!same && (state.enabled || state.positions.length || state.pending))
            throw new ApiError(409, 'COPY_IN_USE', '请先暂停新开仓，待已跟仓位和待核实订单处理完毕后再更改策略。')
          const exchange = exchangeFor(env, user, environment)
          await exchange.positions()
          if (!state.positions.length && !state.pending) state = { ...emptyState(), events: state.events, since: Date.now() }
          state.config = config
          state.openedAfter = Date.now()
          state.keyIdentity = keyIdentity(user)
          state.enabled = true
          state.error = ''
        } else {
          throw new ApiError(400, 'INVALID_ACTION', '跟单操作无效。')
        }
        state.events.unshift({ time: Date.now(), message: state.enabled ? '已启用策略，等待新的公开成交。' : '已暂停新开仓，继续管理已有跟单仓位。' })
        state.events = state.events.slice(0, 60)
        if (!db.write(environment, user.id, state, record?.revision ?? 0)) throw busy()
        return jsonResponse(publicState(state))
      } catch (error) {
        return apiErrorResponse(error)
      }
    },
    async close() {
      stopped = true
      clearInterval(timer)
      markWatch?.close()
      await Promise.allSettled([...running.values(), settlement])
    },
  }
}
