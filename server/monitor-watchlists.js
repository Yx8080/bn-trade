import { defaultLeadPortfolios } from '../shared/lead-portfolios.js'
import { ApiError } from '../worker/trading.js'

const guest = 'guest'
const defaults = defaultLeadPortfolios.map(({ id }) => id)
const maxPortfolios = 2_000

export function validMonitorIds(ids, limit = maxPortfolios) {
  return Array.isArray(ids) && ids.length <= limit && ids.every(id => typeof id === 'string' && /^\d{1,30}$/.test(id))
}

export function createMonitorWatchlists(db) {
  const all = db.prepare('SELECT owner_id AS owner, portfolio_ids AS ids FROM monitor_watchlists')
  const read = db.prepare('SELECT portfolio_ids AS ids FROM monitor_watchlists WHERE owner_id = ?')
  const save = db.prepare(`INSERT INTO monitor_watchlists (owner_id, portfolio_ids) VALUES (?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET portfolio_ids = excluded.portfolio_ids`)

  function ids() {
    const lists = all.all()
    const portfolios = new Set(lists.some(list => list.owner === guest) ? [] : defaults)
    for (const list of lists) for (const id of JSON.parse(list.ids)) portfolios.add(id)
    return [...portfolios]
  }

  function write(owner, portfolioIds) {
    db.exec('BEGIN IMMEDIATE')
    try {
      save.run(owner ?? guest, JSON.stringify([...new Set(portfolioIds)]))
      if (ids().length > maxPortfolios) throw new ApiError(409, 'MONITOR_LIMIT', '服务端监控组合已达到上限，请先移除不再关注的组合。')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return { ids, save: write, get(owner) { return JSON.parse(read.get(owner ?? guest)?.ids ?? 'null') } }
}
