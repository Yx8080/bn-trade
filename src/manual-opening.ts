import type { OrderInput, Position } from './futures'

export type OpeningSize = { margin: number } | { quantity: number }

export function estimateOpeningMargin(
  size: OpeningSize,
  order: Pick<OrderInput, 'symbol' | 'side' | 'positionSide'>,
  positions: Position[],
  price: number,
  leverage: number | undefined,
): number | null {
  const position = order.positionSide === 'BOTH'
    ? positions.find(row => row.symbol === order.symbol && row.positionSide === 'BOTH')
    : undefined
  const signedQuantity = Number(position?.quantity ?? 0)
  const offset = Math.max(0, order.side === 'BUY' ? -signedQuantity : signedQuantity)
  if ('margin' in size && offset === 0) return size.margin
  if ('quantity' in size && size.quantity <= offset) return 0
  if (!leverage || !Number.isFinite(price) || price <= 0) return null
  return 'margin' in size
    ? Math.max(0, size.margin - offset * price / leverage)
    : (size.quantity - offset) * price / leverage
}
