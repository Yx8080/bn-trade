export const DAY_MS = 86_400_000

const PAGE_SIZE = 10
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })
const twoDecimalFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const smallAmountFormat = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 8 })

export interface Trade {
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: string
  type: string
  positionSide: string
  executedQty: number | null
  avgPrice: number | null
  quoteQuantity?: number | null
  totalPnl: number | null
  orderTime: number | null
  orderUpdateTime: number
}

export interface TradeQuery {
  portfolioId: string
  startTime: number
  endTime: number
}

export interface ObservedTrade extends Trade {
  observedId: string
}

export interface TradePage {
  list: ObservedTrade[]
  total: number
  cursor?: string
}

export interface ObservationStatus {
  portfolioId: string
  startedAt: number
  lastSuccessAt: number | null
  lastPositionChangeAt?: number | null
  error: string
}

export class TradeRequestError extends Error {
  readonly status: number
  readonly retryAfterMs: number

  constructor(message: string, status: number, retryAfterMs: number) {
    super(message)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function formatNumber(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? numberFormat.format(value) : '—'
}

export function formatTradeAmount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return (Math.abs(value) > 1 ? twoDecimalFormat : smallAmountFormat).format(value)
}

export function detailUrl(id: string) {
  return `https://www.binance.com/zh-CN/copy-trading/lead-details/${id}`
}

export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeTrade(row: ObservedTrade): ObservedTrade {
  return {
    ...row,
    executedQty: numericValue(row.executedQty),
    avgPrice: numericValue(row.avgPrice),
    quoteQuantity: numericValue(row.quoteQuantity),
    totalPnl: numericValue(row.totalPnl),
    orderTime: numericValue(row.orderTime),
    orderUpdateTime: numericValue(row.orderUpdateTime) ?? NaN,
  }
}

export function parsePortfolioId(input: string) {
  const value = input.trim()
  if (/^\d+$/.test(value)) return value

  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && ['binance.com', 'www.binance.com'].includes(url.hostname)) {
      return url.pathname.match(/\/copy-trading\/lead-details\/(\d+)\/?$/)?.[1]
    }
  } catch {
    return undefined
  }
}

export function tradeDirection({ positionSide, side, executedQty }: Trade) {
  if ((executedQty ?? 0) > 0 && (side === 'BUY' || side === 'SELL')) {
    if (positionSide === 'LONG') return side === 'BUY' ? '开多' : '平多'
    if (positionSide === 'SHORT') return side === 'SELL' ? '开空' : '平空'
  }
}

export function tradeValue(price: number | null, quantity: number | null, quoteQuantity?: number | null) {
  if (quoteQuantity != null) return quoteQuantity
  return price != null && quantity != null ? price * quantity : null
}

export function shanghaiDate(time: number) {
  return new Date(time + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

export function formatTradeTime(time: number) {
  const date = new Date(time + SHANGHAI_OFFSET_MS)
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 19).replace('T', ' ')
    : '—'
}

function retryDelay(header: string | null) {
  if (!header) return 0
  const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return Number.isSafeInteger(delay) ? Math.max(0, delay) : 0
}

async function monitorRequest<T>(url: string, init: RequestInit, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, {
    cache: 'no-store', ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const retryAfterMs = retryDelay(response.headers.get('retry-after'))
  const payload = await response.json().catch(cause => {
    if (cause instanceof SyntaxError) return null
    throw cause
  })
  if (!response.ok) {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
    throw new TradeRequestError(
      message || `查询接口返回 HTTP ${response.status}，请稍后重试。`,
      response.status,
      retryAfterMs,
    )
  }
  return payload as T
}

export async function fetchObservedTrades(query: TradeQuery, cursor?: string, signal?: AbortSignal): Promise<TradePage> {
  const params = new URLSearchParams({ portfolioId: query.portfolioId, startTime: String(query.startTime),
    endTime: String(query.endTime), pageSize: String(PAGE_SIZE) })
  if (cursor) params.set('cursor', cursor)
  const data = await monitorRequest<TradePage>(`/api/monitor/trades?${params}`, {}, signal)
  if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.total) || data.total < 0 ||
    data.list.some(row => typeof row?.observedId !== 'string' || !row.observedId) ||
    (data.cursor != null && (typeof data.cursor !== 'string' || !data.cursor || data.cursor === cursor))) {
    throw new Error('本地成交记录格式无效，请重新查询。')
  }
  return { list: data.list.map(normalizeTrade), total: data.total, cursor: data.cursor ?? undefined }
}

export async function observePortfolios(viewId: string, portfolioIds: string[], signal: AbortSignal) {
  const data = await monitorRequest<{ portfolios: ObservationStatus[] }>('/api/monitor/observe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewId, portfolioIds }),
  }, signal)
  if (!Array.isArray(data?.portfolios)) throw Error('服务未能确认监控状态。')
  return data.portfolios
}

export function releaseObservation(viewId: string) {
  void fetch('/api/monitor/release', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewId }), keepalive: true,
  }).catch(() => { /* An unreachable view expires automatically when its lease ends. */ })
}

export interface ClosedPosition {
  positionId: string
  symbol: string
  side: string
  asset: string
  opened: number | null
  closed: number | null
  avgCost: number | null
  avgClosePrice: number | null
  closedVolume: number | null
  closingPnl: number | null
  roi: number | null
}

export async function fetchClosedPositions(portfolioId: string, pageNumber: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ portfolioId, pageNumber: String(pageNumber), pageSize: String(PAGE_SIZE) })
  const data = await monitorRequest<{ rows: ClosedPosition[]; total: number; pageSize: number }>(
    `/api/monitor/positions?${params}`, {}, signal)
  if (!Array.isArray(data?.rows) || !Number.isSafeInteger(data.total) || data.total < 0 ||
    !Number.isSafeInteger(data.pageSize) || data.pageSize < 1) {
    throw new Error('本地已平仓位记录格式无效，请重新查询。')
  }
  return data
}
