export type Environment = 'testnet' | 'live'
export type FuturesPositionMode = 'oneWay' | 'hedge'
type Market = 'spot' | 'futures'
type PositionSide = 'BOTH' | 'LONG' | 'SHORT'
type Side = 'BUY' | 'SELL'
type OrderType = 'MARKET' | 'LIMIT'

const environmentKey = 'bn-trade:environment'
function initialEnvironment(): Environment {
  try { return window.sessionStorage.getItem(environmentKey) === 'live' ? 'live' : 'testnet' }
  catch { return 'testnet' }
}

let selectedEnvironment = initialEnvironment()
export function getSelectedEnvironment(): Environment {
  return selectedEnvironment
}

export function selectEnvironment(environment: Environment) {
  if (environment !== 'live' && environment !== 'testnet') throw Error('交易环境无效。')
  selectedEnvironment = environment
  try { window.sessionStorage.setItem(environmentKey, environment) }
  catch { /* The choice still applies to this page when storage is unavailable. */ }
}

export interface FuturesSession {
  id: string
  name: string
  environment: Environment
}

export interface BoundSession extends FuturesSession {
  uid: string
  issuer: 'live' | 'demo' | 'spot-testnet'
  previousWorkspaceId?: string
  markets: Market[]
  expiresAt: number
}

export interface BindingInput {
  environment: Environment
  apiKey: string
  apiSecret: string
}

export interface CopyConfig {
  portfolioIds: string[]
  leverage: number | null
  sizingMode: 'margin' | 'equityPercent' | 'notional'
  amount: number
  repeat: 'first' | 'fixed'
  manualPositionPolicy?: 'skip' | 'add'
  maxEntries: number
  maxPositions: number
  stopLoss: number
}

export interface CopyStatus {
  enabled: boolean
  config: CopyConfig | null
  positions: { portfolioId: string; symbol: string; direction: 'LONG' | 'SHORT'; quantity: number; entries: number; entryPrice: number }[]
  events: { time: number; message: string }[]
  lastCheck: number | null
  error: string
  pending: { portfolioId: string; symbol: string; clientOrderId: string } | null
}

export interface CopyAmount {
  asset: string
  realized: number
  fees: number
  net: number
}

export interface CopyPnlPage {
  totals: CopyAmount[]
  unrealized: number | null
  openCount: number
  unrealizedAt: number | null
  pendingCount: number
  total: number
  pageSize: number
  rows: {
    clientOrderId: string; orderId: string; symbol: string; portfolioId: string; direction: string; kind: 'open' | 'close'
    time: number; quantity: number; price: number; settled: boolean; amounts: CopyAmount[]
  }[]
}

export interface PlatformPnlPage {
  pageSize: number
  total: number
  pendingCount: number
  rows: {
    market: 'futures' | 'spot'; symbol: string; clientOrderId: string; orderId: string; side: Side; type: OrderType
    status: string; time: number; quantity: number; quote: number; amounts: CopyAmount[]; settled: boolean
  }[]
  totals: CopyAmount[]
}

export interface PlatformValuation {
  spot: { symbol: string; quantity: number; cost: number; value: number | null; unrealized: number | null }[]
  manualPositions: { symbol: string; positionSide: PositionSide; unrealized: number | null }[]
  valuationTime: number | null
  valuationError: string
}

type CopyCommand =
  | { action: 'start'; environment: Environment; config: CopyConfig }
  | { action: 'pause'; environment: Environment }

export interface SpotQuote {
  symbol: string
  lastPrice: string
  time: number
  environment: Environment
}

export interface Quote extends SpotQuote {
  markPrice: string
  lastTime: number
}

export interface Position {
  symbol: string
  positionSide: PositionSide
  quantity: string
  entryPrice: string
  markPrice: string
  unrealizedPnl: string
  marginAsset: string
  updateTime: number
}

export interface FuturesAccount extends Pick<FuturesSession, 'name' | 'environment'> {
  positions: Position[]
  balances: { asset: string; walletBalance: string; availableBalance: string }[]
}

interface SpotAccount extends Pick<FuturesSession, 'name' | 'environment'> {
  balances: { asset: string; free: string; locked: string }[]
}

export interface OtherTrades {
  market: 'spot' | 'futures'
  symbol: string
  balances: SpotAccount['balances']
  positions: Position[]
  trades: {
    id: string; orderId: string; symbol: string; time: number; side: Side; positionSide: PositionSide | null
    quantity: string; price: string; commission: string; commissionAsset: string; realizedPnl: string | null
    marginAsset: string | null; source: 'untracked' | 'unverified'
  }[]
}

export interface PositionSource {
  kind: 'manual' | 'copy' | 'external' | 'unknown'
  portfolioId?: string | null
}

export interface PositionAttribution extends Pick<Position, 'symbol' | 'positionSide' | 'quantity' | 'entryPrice' | 'updateTime'> {
  sources: PositionSource[]
  complete: boolean
}

export interface FuturesFills {
  market: 'futures'
  symbol: string
  limit: number
  windowDays: number
  atLimit: boolean
  trades: (Omit<OtherTrades['trades'][number], 'source'> & {
    source: 'manual' | 'copy' | 'untracked' | 'unverified'
    portfolioId: string | null
  })[]
}

interface OrderIntent {
  environment: Environment
  clientOrderId: string
  symbol: string
}

export interface OrderInput extends OrderIntent {
  side: Side
  positionSide: PositionSide
  type: OrderType
  quantity: string
  price?: string
  reduceOnly?: boolean
  leverage?: number
}

export interface ClosePositionInput extends OrderIntent {
  positionSide: PositionSide
  direction: 'LONG' | 'SHORT'
  expectedQuantity: string
  expectedUpdateTime: number
  quantity: string
}

export interface ClosePositionRules {
  symbol: string
  environment: Environment
  baseAsset: string
  stepSize: string
  minQty: string
  maxQty: string | null
}

export interface SpotBuyInput extends OrderIntent {
  quoteOrderQty: string
}

export interface OrderResult {
  symbol: string
  orderId: string
  clientOrderId: string
  status: string
  side: Side
  type: OrderType
  executedQty: string
  avgPrice: string
}

export class FuturesError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

function uncertainOrder() {
  return new FuturesError('ORDER_UNKNOWN', 0, '未收到确定的订单结果，请用原客户订单号查询。')
}

// These failures happen before the server sends an order to the exchange.
const preOrderErrors = new Set([
  'ORDER_DB_NOT_CONFIGURED', 'ORDER_DB_UNAVAILABLE', 'USERS_NOT_CONFIGURED', 'INVALID_USERS',
  'INVALID_ENVIRONMENT', 'FUTURES_NOT_CONFIGURED', 'SPOT_NOT_CONFIGURED', 'LEVERAGE_NOT_CONFIRMED', 'ACCOUNT_VAULT_UNAVAILABLE',
  'CLOSE_CHECK_UNAVAILABLE',
])

let onUnauthorized: ((token: string) => void) | undefined
export function setUnauthorizedHandler(handler?: (token: string) => void) {
  onUnauthorized = handler
}

function environmentChanged() {
  return new FuturesError('ENVIRONMENT_CHANGED', 409, '交易环境已切换，请在当前环境重新确认。')
}

async function request<T>(path: string, token?: string, signal?: AbortSignal, body?: OrderIntent | CopyCommand,
  environment = selectedEnvironment): Promise<T> {
  if (body && body.environment !== environment) throw environmentChanged()
  const headers = new Headers({ Accept: 'application/json', 'X-Trading-Environment': environment })
  if (token) headers.set('Authorization', 'Bearer ' + token)
  if (body) headers.set('Content-Type', 'application/json')
  const order = body && 'clientOrderId' in body ? body : undefined
  const timeout = AbortSignal.timeout(order && ('leverage' in order || 'expectedQuantity' in order) ? 28_000 : 16_000)
  let response: Response
  let data
  try {
    response = await fetch('/api/' + path, {
      method: body ? 'POST' : 'GET', headers, cache: 'no-store', redirect: 'error',
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
    data = await response.json()
  } catch (cause) {
    if (order) throw uncertainOrder()
    if (signal?.aborted) throw cause
    if (body) throw new FuturesError('COPY_UNKNOWN', 0, '未收到跟单操作回执，请刷新并核对服务端状态。')
    throw new FuturesError('UNAVAILABLE', 0, '暂时无法读取交易接口，请稍后刷新。')
  }
  if (!response.ok) {
    if (token && response.status === 401 && data?.code === 'UNAUTHORIZED') onUnauthorized?.(token)
    // An intermediary may have replaced an exchange acknowledgement with its own error.
    if (order && (typeof data?.code !== 'string' ||
      ((response.status === 408 || response.status >= 500) && !preOrderErrors.has(data.code)))) throw uncertainOrder()
    throw new FuturesError(String(data?.code ?? 'REQUEST_FAILED'), response.status,
      typeof data?.message === 'string' ? data.message : '交易服务暂时无法完成请求。')
  }
  if (order && (data?.clientOrderId !== order.clientOrderId || data?.symbol !== order.symbol ||
    typeof data?.orderId !== 'string' || typeof data.status !== 'string' ||
    typeof data.executedQty !== 'string' || typeof data.avgPrice !== 'string')) throw uncertainOrder()
  return data as T
}

export const createClientOrderId = () => crypto.randomUUID()

export const getSession = (token: string, signal?: AbortSignal) =>
  request<FuturesSession>('futures/session', token, signal)

export async function getBindingEnvironment(signal?: AbortSignal): Promise<Environment> {
  const expected = selectedEnvironment
  const result = await request<{ environment: Environment; credentialStorage?: string; identity?: string }>('accounts/bind', undefined, signal)
  if (result?.environment !== expected || selectedEnvironment !== expected) throw environmentChanged()
  if (result.credentialStorage !== 'memory' || result.identity !== 'binance-uid') {
    throw new FuturesError('INCOMPATIBLE_BINDING', 409, '当前后端未确认支持内存密钥和币安 UID。请使用新版代码重启交易服务，再点击重试。')
  }
  return result.environment
}

export async function bindAccount(input: BindingInput): Promise<BoundSession & { token: string }> {
  if (input.environment !== selectedEnvironment) throw environmentChanged()
  if (typeof window !== 'undefined' && !window.isSecureContext)
    throw Error('请使用 HTTPS 或本机 localhost 地址绑定密钥。')
  let response: Response
  let data
  try {
    response = await fetch('/api/accounts/bind', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Trading-Environment': input.environment },
      body: JSON.stringify({ ...input, identity: 'binance-uid' }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45_000),
    })
    data = await response.json()
  } catch {
    throw Error('暂时无法确认绑定结果，请检查服务连接后重试。')
  }
  if (!response.ok) {
    if (data?.code === 'BINDING_RATE_LIMITED' || response.status === 429) throw Error('验证请求过于频繁，请稍后再试。')
    if (data?.code === 'ENVIRONMENT_CHANGED') throw Error('交易环境已变更，请重新打开连接窗口。')
    if (data?.code === 'BINDING_POLICY_MISMATCH') throw Error('页面和后端的账户验证方式不一致。请重启新版交易服务并刷新页面。')
    if (data?.code === 'ACCOUNT_HISTORY_BUSY') throw Error('旧工作区正在处理交易。请等当前任务完成后再连接。')
    if (data?.code === 'ACCOUNT_HISTORY_CONFLICT') throw Error('旧工作区和 UID 工作区存在重叠记录。系统已保留原数据，请核对两边的策略和订单。')
    if (data?.code === 'UID_UNAVAILABLE') throw Error('币安未返回可验证的账户 UID。请核对当前环境和密钥的账户读取权限后重试。')
    if (data?.code === 'UID_MISMATCH') throw Error('币安返回的账户标识不一致。请核对密钥及所属环境后重新连接。')
    if (data?.code === 'BINDING_REJECTED' || data?.code === 'INVALID_BINDING' ||
      response.status === 400 || response.status === 401 || response.status === 403) {
      throw Error('验证失败，请核对密钥所属环境、API Key、API Secret、读取权限和币安 IP 白名单。')
    }
    throw Error('交易服务暂时无法验证密钥，请稍后再试。')
  }
  if (data?.environment !== input.environment || typeof data.token !== 'string' || !data.token ||
    typeof data.id !== 'string' || !data.id || typeof data.name !== 'string' || !data.name ||
    typeof data.uid !== 'string' || !/^[1-9]\d{0,19}$/.test(data.uid) ||
    (input.environment === 'live' ? data.issuer !== 'live' || data.id !== 'uid:' + data.uid
      : !['demo', 'spot-testnet'].includes(data.issuer) || data.id !== 'uid:' + data.issuer + ':' + data.uid) ||
    !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now() ||
    !Array.isArray(data.markets) || !data.markets.length || !data.markets.every((market: unknown) => market === 'futures' || market === 'spot')) {
    if (typeof data?.token === 'string' && data.token) void revokeSession(data.token, input.environment).catch(() => {})
    throw Error('交易服务返回了无效的会话信息，请重新绑定。')
  }
  const { environment, id, uid, issuer, name, markets, expiresAt, token, previousWorkspaceId } = data
  return { environment, id, uid, issuer, name, markets, expiresAt, token,
    ...(environment === 'live' && typeof previousWorkspaceId === 'string' && /^bound-[a-f0-9]{64}$/.test(previousWorkspaceId)
      ? { previousWorkspaceId } : {}) }
}

export async function revokeSession(token: string, environment = selectedEnvironment) {
  const response = await fetch('/api/accounts/session', {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token, 'X-Trading-Environment': environment },
    redirect: 'error', cache: 'no-store', keepalive: true,
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok && response.status !== 401) throw Error('服务器暂未确认会话注销。')
}

export const getCopyStatus = (token: string, signal?: AbortSignal) =>
  request<CopyStatus>('futures/copy', token, signal)

export const getOtherTrades = (token: string, market: OtherTrades['market'], symbol: string, signal?: AbortSignal) =>
  request<OtherTrades>('futures/other-trades?' + new URLSearchParams({ market, symbol }), token, signal)

export const getFuturesFills = (token: string, symbol: string, signal?: AbortSignal) =>
  request<FuturesFills>('futures/other-trades?' + new URLSearchParams({ market: 'futures', symbol, scope: 'all' }), token, signal)

export const getPositionSources = (token: string, signal?: AbortSignal) =>
  request<{ environment: Environment; positions: PositionAttribution[] }>('futures/position-sources', token, signal)

export const getCopyPnl = (token: string, page: number, signal?: AbortSignal) =>
  request<CopyPnlPage>('futures/copy-pnl?' + new URLSearchParams({ page: String(page) }), token, signal)

export const getPlatformPnl = (token: string, page: number, signal?: AbortSignal) =>
  request<PlatformPnlPage>('platform/pnl?' + new URLSearchParams({ page: String(page) }), token, signal)

export const getPlatformValuation = (token: string, signal?: AbortSignal) =>
  request<PlatformValuation>('platform/valuation', token, signal)

export const updateCopyStatus = (token: string, command: CopyCommand, signal?: AbortSignal) =>
  request<CopyStatus>('futures/copy', token, signal, command)

export const getAccount = (token: string, signal?: AbortSignal) =>
  request<FuturesAccount>('futures/account', token, signal)

export async function getFuturesPositionMode(token: string, environment: Environment, signal?: AbortSignal): Promise<FuturesPositionMode> {
  if (environment !== selectedEnvironment) throw environmentChanged()
  const result = await request<{ environment: Environment; mode: FuturesPositionMode }>(
    'futures/position-mode', token, signal, undefined, environment)
  if (result?.environment !== environment || environment !== selectedEnvironment) throw environmentChanged()
  if (result.mode !== 'oneWay' && result.mode !== 'hedge') throw Error('币安账户持仓模式无效。')
  return result.mode
}

export const getCopyEquity = (token: string, signal?: AbortSignal) =>
  request<{ equity: number; asset: 'USDT'; time: number }>('futures/equity', token, signal)

export type ManualSizingMode = 'margin' | 'equityPercent'
export interface ManualOrderSize {
  symbol: string
  environment: Environment
  quantity: string
  margin: string
  equity: number | null
}
export const getManualOrderSize = (token: string, input: {
  symbol: string; environment: Environment; mode: ManualSizingMode; amount: string; price: string; leverage: string; type: OrderType
  side?: Side; positionSide?: PositionSide
}, signal?: AbortSignal) => request<ManualOrderSize>('futures/order-size?' + new URLSearchParams(input), token, signal)

export interface SymbolLeverage {
  symbol: string
  environment: Environment
  leverage: number | null
  symbolMaxLeverage: number
  maxLeverage: number | null
  exposure: string | null
  brackets: { cap: string; leverage: number }[]
}
export const getFuturesLeverage = (token: string, symbol: string, signal?: AbortSignal) =>
  request<SymbolLeverage>(
    'futures/leverage?' + new URLSearchParams({ symbol }), token, signal)

export const getSpotAccount = (token: string, signal?: AbortSignal) =>
  request<SpotAccount>('spot/account', token, signal)

function quoteQuery(symbol: string, environment?: Environment) {
  const params = new URLSearchParams({ symbol })
  if (environment) params.set('environment', environment)
  return params
}

export const getQuote = (symbol: string, signal?: AbortSignal, environment?: Environment) =>
  request<Quote>('futures/quote?' + quoteQuery(symbol, environment), undefined, signal, undefined, environment)

export const getSpotQuote = (symbol: string, signal?: AbortSignal, environment?: Environment) =>
  request<SpotQuote>('spot/quote?' + quoteQuery(symbol, environment), undefined, signal, undefined, environment)

export const submitOrder = (token: string, input: OrderInput, signal?: AbortSignal) =>
  request<OrderResult>('futures/orders', token, signal, input)

export async function getClosePositionRules(token: string, symbol: string, environment: Environment, signal?: AbortSignal) {
  if (environment !== selectedEnvironment) throw environmentChanged()
  const rules = await request<ClosePositionRules>('futures/close-position?' + new URLSearchParams({ symbol }),
    token, signal, undefined, environment)
  if (rules?.environment !== environment || selectedEnvironment !== environment) throw environmentChanged()
  const decimal = (value: unknown) => typeof value === 'string' && /^\d{1,20}(?:\.\d{1,18})?$/.test(value)
  if (rules.symbol !== symbol || typeof rules.baseAsset !== 'string' || !rules.baseAsset.trim() ||
    !decimal(rules.stepSize) || !/[1-9]/.test(rules.stepSize) || !decimal(rules.minQty) ||
    !(rules.maxQty === null || decimal(rules.maxQty))) throw Error('无法核实此合约的平仓数量规则。')
  return rules
}

export const closePosition = (token: string, input: ClosePositionInput) =>
  request<OrderResult>('futures/close-position', token, undefined, input)

export const buySpot = (token: string, input: SpotBuyInput, signal?: AbortSignal) =>
  request<OrderResult>('spot/orders', token, signal, input)

export const lookupOrder = (token: string, symbol: string, clientOrderId: string, signal?: AbortSignal) =>
  request<OrderResult>('futures/orders?' + new URLSearchParams({ symbol, clientOrderId }), token, signal)

export const lookupSpotOrder = (token: string, symbol: string, clientOrderId: string, signal?: AbortSignal) =>
  request<OrderResult>('spot/orders?' + new URLSearchParams({ symbol, clientOrderId }), token, signal)
