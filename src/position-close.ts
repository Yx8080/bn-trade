import type { ClosePositionRules } from './futures'

function units(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(18, '0'))
}

function decimal(value: bigint) {
  const digits = value.toString().padStart(19, '0')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '')
}

export function closePercentQuantity(available: string, percent: number, stepSize: string): string {
  const held = units(available)
  const step = units(stepSize)
  if (!held || !step || !Number.isInteger(percent) || percent < 1 || percent > 100) return ''
  return decimal(held * BigInt(percent) / (100n * step) * step)
}

export function closeQuantityPercent(quantity: string, available: string): string {
  const held = units(available)
  const size = units(quantity)
  return held && size && size <= held ? String(size * 100n / held) : ''
}

export function closeQuantityIssue(quantity: string, available: string, rules: Pick<ClosePositionRules, 'stepSize' | 'minQty' | 'maxQty'>) {
  const size = units(quantity)
  const held = units(available)
  const step = units(rules.stepSize)
  const min = units(rules.minQty)
  const max = rules.maxQty === null ? null : units(rules.maxQty)
  if (!held || !step || min == null || (rules.maxQty !== null && !max)) return '无法核实此合约的可平数量。'
  if (!size) return '请输入大于零的平仓数量。'
  if (size > held) return '平仓数量超过当前持仓。'
  if (size < min) return '单笔平仓数量至少为 ' + rules.minQty + '。'
  if (max !== null && size > max) return '单笔平仓数量最多为 ' + rules.maxQty + '，请分笔平仓。'
  if (size % step !== 0n) return '平仓数量须为 ' + rules.stepSize + ' 的整数倍。'
  return ''
}
