export const DAY_MS = 86_400_000

const PAGE_SIZE = 10
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })

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

export interface TradePage {
  list: Trade[]
  total: number
  cursor?: string
}

interface BinanceResponse<T> {
  success: boolean
  code: string
  message?: string | null
  data?: T | null
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

export function detailUrl(id: string) {
  return `https://www.binance.com/zh-CN/copy-trading/lead-details/${id}`
}

export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeTrade(row: Trade): Trade {
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

export function tradeKey(trade: Trade) {
  return [
    trade.orderTime, trade.orderUpdateTime, trade.symbol, trade.side, trade.type, trade.positionSide,
    trade.avgPrice, trade.executedQty, trade.quoteQuantity, trade.totalPnl,
  ].join('|')
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

async function fetchBinanceJson<T>(url: string, init: RequestInit, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const retryAfterMs = retryDelay(response.headers.get('retry-after'))
  const payload = await response.json().catch(cause => {
    if (cause instanceof SyntaxError) return null
    throw cause
  }) as BinanceResponse<T> | null
  if (response.status !== 200) {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
    throw new TradeRequestError(
      message || `查询接口返回 HTTP ${response.status}，请稍后重试。`,
      response.status,
      retryAfterMs,
    )
  }
  if (payload?.code === '11012005') {
    throw new TradeRequestError('币安查询繁忙，请稍后重试。', 200, retryAfterMs)
  }
  if (payload?.success === false) {
    throw new TradeRequestError(payload.message || `币安查询失败（${payload.code}）。`, 200, retryAfterMs)
  }
  if (payload?.code !== '000000') {
    throw new Error('币安返回的数据格式有变化，请检查官网页面。')
  }
  return payload.data
}

export async function fetchBinanceTradePage(
  query: TradeQuery,
  indexValue?: string,
  signal?: AbortSignal,
): Promise<TradePage> {
  const data = await fetchBinanceJson<{ list: Trade[]; total: number; indexValue?: string }>('/api/binance/latest-records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...query, pageSize: PAGE_SIZE, indexValue }),
  }, signal)
  if (!Array.isArray(data?.list) || typeof data.total !== 'number') {
    throw new Error('币安返回的数据格式有变化，请检查官网页面。')
  }

  const { list, total, indexValue: cursor } = data
  return { list: list.map(normalizeTrade), total, cursor: cursor === '-1' ? undefined : cursor }
}

export async function fetchBinancePortfolioName(portfolioId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ portfolioId })
  const data = await fetchBinanceJson<{ nickname?: string }>(
    `/api/binance/portfolio-detail?${params}`, { cache: 'no-store' }, signal,
  )
  return typeof data?.nickname === 'string' ? data.nickname.trim() : undefined
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
  const data = await fetchBinanceJson<{ list: Record<string, unknown>[]; total: number }>('/api/binance/position-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portfolioId, pageNumber, pageSize: PAGE_SIZE }),
  }, signal)
  if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.total) || data.total < 0) {
    throw new Error('币安返回的仓位历史格式有变化。')
  }
  const rows: ClosedPosition[] = []
  for (const row of data.list) {
    if (!row || row.status !== 'All Closed' || typeof row.symbol !== 'string' || typeof row.positionId !== 'string') continue
    const asset = typeof row.marginAsset === 'string' ? row.marginAsset
      : row.type === 'UM' ? row.symbol.match(/(USDT|USDC)$/)?.[1] ?? '' : ''
    rows.push({
      positionId: row.positionId, symbol: row.symbol, side: String(row.side ?? ''), asset,
      opened: numericValue(row.opened), closed: numericValue(row.closed),
      avgCost: numericValue(row.avgCost), avgClosePrice: numericValue(row.avgClosePrice),
      closedVolume: numericValue(row.closedVolume), closingPnl: numericValue(row.closingPnl), roi: numericValue(row.roi),
    })
  }
  return { rows, total: data.total, pageSize: PAGE_SIZE }
}
