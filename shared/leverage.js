export const MIN_LEVERAGE = 1
export const COPY_LEVERAGE_TIERS = Object.freeze([150, 100, 75, 50, 25, 20])

export function isAppLeverage(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= MIN_LEVERAGE && value <= maximum
}

export function isCopyLeverageOverrides(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, leverage]) =>
      COPY_LEVERAGE_TIERS.some(tier => String(tier) === key && isAppLeverage(leverage, tier)))
}
