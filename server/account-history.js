import { createHash } from 'node:crypto'
import { ApiError } from '../worker/trading.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const marketBits = { spot: 1, futures: 2 }
const historyConflict = () => new ApiError(409, 'ACCOUNT_HISTORY_CONFLICT',
  '旧工作区和 UID 工作区存在重叠记录，已保留原数据。请核对旧策略及订单后再迁移。')

export function createAccountHistory(db) {
  const legacyOwner = db.prepare('SELECT user_id AS id, scopes FROM legacy_account_owners WHERE environment=? AND key_hash=?')
  // Old configured tokens could create orders before a binding table existed.
  // Their journals already carry the independently verifiable key fingerprint.
  const journalOwners = db.prepare(`SELECT user_id AS id FROM platform_orders
    WHERE environment=:environment AND market=:market AND key_identity=:fingerprint
    UNION SELECT user_id FROM copy_executions WHERE :market='futures' AND environment=:environment AND key_identity=:fingerprint
    UNION SELECT user_id FROM copy_strategies WHERE :market='futures' AND environment=:environment
      AND json_extract(state,'$.keyIdentity')=:fingerprint`)
  const knownOwner = db.prepare('SELECT 1 FROM uid_accounts WHERE environment=? AND user_id=?')
  const register = db.prepare('INSERT INTO uid_accounts(environment,user_id) VALUES (?,?) ON CONFLICT DO NOTHING')
  // A configured pre-UID user_id could have been any string, even one that
  // happens to equal a new canonical ID. Never grant access on a name match.
  const ownerTables = ['order_requests', 'copy_strategies', 'copy_executions', 'platform_orders',
    'platform_fills', 'platform_fill_scans', 'futures_symbol_leases', 'legacy_account_owners']
  const occupied = db.prepare(ownerTables.map(table =>
    'SELECT 1 FROM ' + table + ' WHERE environment=:environment AND user_id=:id').join(' UNION ALL ') + ' LIMIT 1')

  function prepare(sql) {
    const query = db.prepare(sql)
    query.setAllowUnknownNamedParameters(true)
    return query
  }
  const old = 'environment=:environment AND user_id=:oldId'
  const order = 'SELECT client_id FROM platform_orders WHERE ' + old + ' AND market=:market AND key_identity=:fingerprint'
  const execution = 'SELECT client_id FROM copy_executions WHERE ' + old + ' AND key_identity=:fingerprint'
  const strategyScope = old + " AND (json_extract(state,'$.keyIdentity')=:fingerprint OR (:exclusive AND json_extract(state,'$.keyIdentity') IS NULL))"
  const pending = "SELECT json_extract(state,'$.pending.clientOrderId') FROM copy_strategies WHERE " + strategyScope

  const reserved = prepare(`UPDATE order_requests SET user_id=:id WHERE ${old} AND market=:market AND
    (:exclusive OR client_order_id IN (${order}) OR
      (:market='futures' AND (client_order_id IN (${execution}) OR client_order_id IN (${pending}))))`)
  const children = ['platform_fills', 'platform_fill_scans'].map(table => prepare(
    `UPDATE ${table} SET user_id=:id WHERE ${old} AND market=:market AND client_id IN (${order})`))
  const orders = prepare(`UPDATE platform_orders SET user_id=:id,key_identity=:id WHERE ${old} AND market=:market AND key_identity=:fingerprint`)
  const strategy = prepare(`UPDATE copy_strategies SET user_id=:id,state=json_set(state,'$.keyIdentity',:id),
    revision=revision+1, lease_until=0, lease_owner=NULL WHERE ${strategyScope}`)
  const executions = prepare(`UPDATE copy_executions SET user_id=:id,key_identity=:id WHERE ${old} AND key_identity=:fingerprint`)
  const busy = prepare(`SELECT 1 FROM copy_strategies WHERE ${strategyScope} AND lease_until>:now
    UNION ALL SELECT 1 FROM futures_symbol_leases WHERE ${old} AND expires_at>:now LIMIT 1`)
  const expiredLeases = prepare(`DELETE FROM futures_symbol_leases WHERE ${old} AND expires_at<=:now`)

  return {
    bindingMarkets(environment, apiKey) {
      const prior = legacyOwner.get(environment, sha256(apiKey))
      if (!prior || prior.id === 'bound-' + sha256(environment + '\0' + apiKey)) return null
      return Object.keys(marketBits).filter(market => prior.scopes & marketBits[market])
    },

    claim(environment, id, issuer, apiKey, configuredOwner) {
      const fingerprint = sha256(apiKey)
      const derived = 'bound-' + sha256(environment + '\0' + apiKey)
      const markets = issuer === 'live' ? ['futures', 'spot'] : issuer === 'demo' ? ['futures'] : ['spot']
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!knownOwner.get(environment, id) && occupied.get({ environment, id })) throw historyConflict()
        const prior = legacyOwner.get(environment, fingerprint)
        for (const market of markets) {
          const matches = journalOwners.all({ environment, market, fingerprint })
          const candidates = new Set([derived, prior?.id, configuredOwner?.id, ...matches.map(row => row.id)])
          for (const oldId of candidates) {
            if (!oldId) continue
            if (oldId.startsWith('uid:')) throw historyConflict()
            const args = { environment, id, oldId, fingerprint, market, exclusive: Number(oldId === derived), now: Date.now() }
            if (market === 'futures' && busy.get(args)) throw new ApiError(409, 'ACCOUNT_HISTORY_BUSY',
              '旧工作区有正在执行的交易任务，请等待该任务完成后再绑定。')
            // Child ownership must be proved before moving its parent. For
            // mixed pre-UID workspaces a shared user_id alone proves nothing.
            reserved.run(args)
            for (const child of children) child.run(args)
            orders.run(args)
            if (market === 'futures') {
              strategy.run(args)
              executions.run(args)
              expiredLeases.run(args)
            }
          }
        }
        register.run(environment, id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        if (error.errcode === 1555 || error.errcode === 2067) throw historyConflict()
        throw error
      }
      return derived
    },
  }
}
