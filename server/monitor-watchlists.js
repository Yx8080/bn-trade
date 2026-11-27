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

export function createMonitorSamplerStore(db) {
  const lease = db.prepare(`INSERT INTO portfolio_monitor_lease (id, owner, expires_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE owner = excluded.owner OR expires_at <= ? RETURNING next_at AS nextAt`)
  const schedule = db.prepare('UPDATE portfolio_monitor_lease SET next_at = ? WHERE id = 1 AND owner = ?')
  const release = db.prepare('UPDATE portfolio_monitor_lease SET expires_at = 0 WHERE id = 1 AND owner = ?')
  const status = db.prepare('SELECT payload FROM portfolio_monitor_status WHERE portfolio_id = ?')
  const save = db.prepare(`INSERT INTO portfolio_monitor_status (portfolio_id, payload) VALUES (?, ?)
    ON CONFLICT(portfolio_id) DO UPDATE SET payload = excluded.payload`)
  const remove = db.prepare('DELETE FROM portfolio_monitor_status WHERE portfolio_id = ?')
  return {
    claim: (owner, now, expires) => lease.get(owner, expires, now),
    schedule: (owner, nextAt) => schedule.run(nextAt, owner),
    release: owner => release.run(owner),
    status: id => JSON.parse(status.get(id)?.payload ?? 'null'),
    save: value => save.run(value.portfolioId, JSON.stringify(value)),
    remove: id => remove.run(id),
  }
}
