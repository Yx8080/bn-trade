import { ApiError, binanceRequest, invalidData, isDecimal, isPositiveDecimal } from './trading.js'
import { decimal, scale, sizedNotional, units } from './futures-sizing.js'

// V2 reports the equity and its denomination mode in the same account snapshot.
async function equityInUsdt(env, base, account) {
  const balance = account.totalMarginBalance
  if (!isDecimal(balance) || typeof account.multiAssetsMargin !== 'boolean') throw invalidData()
  let value = units(balance.replace(/^-/, ''))
  if (account.multiAssetsMargin) {
    const rate = await binanceRequest(env, base, '/fapi/v1/assetIndex', { params: { symbol: 'USDTUSD' } })
    if (rate.symbol !== 'USDTUSD' || !isPositiveDecimal(rate.index)) throw invalidData()
    value = value * scale / units(rate.index)
  }
  const scaled = Number(value / (scale / 100_000_000n))
  if (!Number.isSafeInteger(scaled)) throw invalidData()
  return (balance.startsWith('-') ? -scaled : scaled) / 1e8
}

export async function getFuturesEquity(env, base, user) {
  const account = await binanceRequest(env, base, '/fapi/v2/account', { credentials: user })
  return { equity: await equityInUsdt(env, base, account), asset: 'USDT', time: Date.now() }
}

function closingNotional(positions, order) {
  if (!order || order.positionSide !== 'BOTH') return 0n
  if (!Array.isArray(positions)) throw invalidData()
  const position = positions.find(row => row.symbol === order.symbol && row.positionSide === 'BOTH')
  if (!position) return 0n
  if (!isDecimal(position.positionAmt)) throw invalidData()
  const short = position.positionAmt.startsWith('-')
  if (short !== (order.side === 'BUY')) return 0n
  return units(position.positionAmt.replace(/^-/, '')) * units(order.price) / scale
}

export async function fundedOpeningNotional(env, base, user, mode, amount, leverage, order) {
  // Legacy fixed-notional strategies inherit the exchange leverage for each symbol.
  if (mode === 'notional' && leverage == null) return { notional: sizedNotional(mode, amount), equity: null }

  const account = await binanceRequest(env, base, '/fapi/v2/account', { credentials: user })
  const equity = mode === 'equityPercent' ? await equityInUsdt(env, base, account) : null
  const notional = sizedNotional(mode, amount, leverage, equity)
  const opening = notional - closingNotional(account.positions, order)
  if (opening > 0n) {
    const available = Array.isArray(account.assets) && account.assets.find(asset => asset?.asset === 'USDT')?.availableBalance
    if (!isDecimal(available)) throw new ApiError(502, 'FUTURES_BALANCE_UNAVAILABLE', '无法读取合约账户的 USDT 可用余额。')
    const multiplier = BigInt(leverage)
    if (available.startsWith('-') || opening > units(available) * multiplier) {
      const margin = decimal((opening + multiplier - 1n) / multiplier)
      throw new ApiError(409, 'INSUFFICIENT_AVAILABLE_MARGIN', '开仓所需保证金约 ' + margin + ' USDT，当前可用余额为 ' + available + ' USDT。')
    }
  }
  return { notional, equity }
}
