export const MIN_LEVERAGE: number
export const COPY_LEVERAGE_TIERS: readonly [150, 100, 75, 50, 25, 20]
export type CopyLeverageTier = typeof COPY_LEVERAGE_TIERS[number]
export type CopyLeverageOverrides = Partial<Record<CopyLeverageTier, number>>
export function isAppLeverage(value: unknown, maximum?: number): value is number
export function isCopyLeverageOverrides(value: unknown): value is CopyLeverageOverrides
