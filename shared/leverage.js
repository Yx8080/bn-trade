export const MIN_LEVERAGE = 1
export function isAppLeverage(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= MIN_LEVERAGE && value <= maximum
}
