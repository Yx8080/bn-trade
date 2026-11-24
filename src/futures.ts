type Environment = 'testnet' | 'live'
type PositionSide = 'BOTH' | 'LONG' | 'SHORT'
type Side = 'BUY' | 'SELL'
type OrderType = 'MARKET' | 'LIMIT'

export interface FuturesSession {
  id: string
  name: string
  environment: Environment
}

export interface CopyConfig {
  portfolioId: string
  amount: number
  repeat: 'first' | 'fixed'
  maxEntries: number
  maxPositions: number
  stopLoss: number
}

export interface CopyStatus {
  enabled: boolean
  config: CopyConfig | null
  positions: { symbol: string; direction: 'LONG' | 'SHORT'; quantity: number; entries: number; entryPrice: number }[]
  events: { time: number; message: string }[]
  lastCheck: number | null
  error: string
  pending: { symbol: string; clientOrderId: string } | null
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
const configurationErrors = new Set([
  'ORDER_DB_NOT_CONFIGURED', 'ORDER_DB_UNAVAILABLE', 'USERS_NOT_CONFIGURED', 'INVALID_USERS',
  'INVALID_ENVIRONMENT', 'FUTURES_NOT_CONFIGURED', 'SPOT_NOT_CONFIGURED',
])

async function request<T>(path: string, token?: string, signal?: AbortSignal, body?: OrderIntent | CopyCommand): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' })
  if (token) headers.set('Authorization', 'Bearer ' + token)
  if (body) headers.set('Content-Type', 'application/json')
  const order = body && 'clientOrderId' in body ? body : undefined
  const timeout = AbortSignal.timeout(16_000)
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
    // An intermediary may have replaced an exchange acknowledgement with its own error.
    if (order && (typeof data?.code !== 'string' || response.status === 408 ||
      (response.status >= 500 && !configurationErrors.has(data.code)))) throw uncertainOrder()
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

export const getCopyStatus = (token: string, signal?: AbortSignal) =>
  request<CopyStatus>('futures/copy', token, signal)

export const getCopyPnl = (token: string, page: number, signal?: AbortSignal) =>
  request<CopyPnlPage>('futures/copy-pnl?' + new URLSearchParams({ page: String(page) }), token, signal)

export const updateCopyStatus = (token: string, command: CopyCommand, signal?: AbortSignal) =>
  request<CopyStatus>('futures/copy', token, signal, command)

export const getAccount = (token: string, signal?: AbortSignal) =>
  request<FuturesAccount>('futures/account', token, signal)

export const getSpotAccount = (token: string, signal?: AbortSignal) =>
  request<SpotAccount>('spot/account', token, signal)

function quoteQuery(symbol: string, environment?: Environment) {
  const params = new URLSearchParams({ symbol })
  if (environment) params.set('environment', environment)
  return params
}

export const getQuote = (symbol: string, signal?: AbortSignal, environment?: Environment) =>
  request<Quote>('futures/quote?' + quoteQuery(symbol, environment), undefined, signal)

export const getSpotQuote = (symbol: string, signal?: AbortSignal, environment?: Environment) =>
  request<SpotQuote>('spot/quote?' + quoteQuery(symbol, environment), undefined, signal)

export const submitOrder = (token: string, input: OrderInput, signal?: AbortSignal) =>
  request<OrderResult>('futures/orders', token, signal, input)

export const buySpot = (token: string, input: SpotBuyInput, signal?: AbortSignal) =>
  request<OrderResult>('spot/orders', token, signal, input)

export const lookupOrder = (token: string, symbol: string, clientOrderId: string, signal?: AbortSignal) =>
  request<OrderResult>('futures/orders?' + new URLSearchParams({ symbol, clientOrderId }), token, signal)

export const lookupSpotOrder = (token: string, symbol: string, clientOrderId: string, signal?: AbortSignal) =>
  request<OrderResult>('spot/orders?' + new URLSearchParams({ symbol, clientOrderId }), token, signal)
