export interface LeadPortfolio {
  id: string
  name: string
}

const initialPortfolios: LeadPortfolio[] = [
  { id: '5075281354358777856', name: '熬鹰资本' },
  { id: '4751838302089254401', name: 'Btc星辰' },
]

function storageKey(userId: string) {
  return `bn-trade:watchlist:v1:${encodeURIComponent(userId)}`
}

function normalize(value: unknown[]) {
  const seen = new Set<string>()
  const entries: LeadPortfolio[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('id' in item)) continue
    const { id } = item
    if (typeof id !== 'string' || !/^\d+$/.test(id) || seen.has(id)) continue
    const name = 'name' in item && typeof item.name === 'string' ? item.name.trim() : ''
    entries.push({ id, name })
    seen.add(id)
  }
  return entries
}

export function loadWatchlist(userId: string, previousLiveId?: string): LeadPortfolio[] {
  try {
    const current = localStorage.getItem(storageKey(userId))
    const canRestore = userId.startsWith('live:owner:') && previousLiveId && /^bound-[a-f0-9]{64}$/.test(previousLiveId)
    const saved = current ?? (canRestore ? localStorage.getItem(storageKey('live:user:' + previousLiveId)) : null)
    if (saved !== null) {
      const entries: unknown = JSON.parse(saved)
      if (Array.isArray(entries)) {
        const normalized = normalize(entries)
        if (current === null) saveWatchlist(userId, normalized)
        return normalized
      }
    }
  } catch {
    // Browsers can deny storage access, including when a saved preference is read.
  }
  return initialPortfolios.map(portfolio => ({ ...portfolio }))
}

export function saveWatchlist(userId: string, entries: LeadPortfolio[]): boolean {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(normalize(entries)))
    return true
  } catch {
    return false
  }
}
