import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createCopyStore } from '../server/copy-store.js'
import { createPlatformStore, matchesUnconfirmedOrder } from '../server/platform-store.js'
import { createBoundAccounts } from '../server/bound-accounts.js'
import { createObservedTrades } from '../server/observed-trades.js'
import { createObservedPositions } from '../server/observed-positions.js'

export function createLocalOrderDb(filename) {
  const database = new DatabaseSync(filename)
  database.exec('PRAGMA busy_timeout = 3000')
  database.exec('PRAGMA secure_delete = ON')
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
  let removedVault = false
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(schema)
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bound_accounts'").get()) {
      database.exec(`INSERT INTO legacy_account_owners(environment,key_hash,user_id,scopes)
        SELECT environment,key_hash,user_id,scopes FROM bound_accounts;
        DROP TABLE IF EXISTS bound_sessions;
        DROP TABLE bound_accounts;`)
      removedVault = true
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    database.close()
    throw error
  }
  // A restored installation may have enabled WAL. Copy the scrubbed pages
  // back and truncate old frames when there are no remaining reader locks.
  if (removedVault) database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const insert = database.prepare(
    'INSERT INTO order_requests (environment, market, user_id, client_order_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
  const requestScope = `FROM order_requests r
    LEFT JOIN platform_orders p ON p.environment=r.environment AND p.market=r.market AND p.user_id=r.user_id AND p.client_id=r.client_order_id
    LEFT JOIN copy_executions c ON r.market='futures' AND c.environment=r.environment AND c.user_id=r.user_id AND c.client_id=r.client_order_id
    WHERE r.environment=? AND r.market=? AND r.user_id=?
    AND (p.client_id IS NULL OR (p.key_identity=? AND p.symbol=?))
    AND (c.client_id IS NULL OR (c.key_identity=? AND c.symbol=?))`
  const unlinked = database.prepare('SELECT 1 ' + requestScope +
    " AND c.order_id IS NULL AND p.order_id IS NULL AND coalesce(p.status, 'UNCONFIRMED')='UNCONFIRMED' LIMIT 1")
  const knownClients = database.prepare(`SELECT r.client_order_id AS id,coalesce(c.order_id,p.order_id) AS orderId,
    p.time,p.status,p.side,p.type,p.position_side AS positionSide ` + requestScope +
    ' AND r.client_order_id IN (SELECT value FROM json_each(?))')
  const claimSymbol = database.prepare(`INSERT INTO futures_symbol_leases (environment, user_id, symbol, owner, expires_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(environment, user_id, symbol) DO UPDATE SET
    owner = excluded.owner, expires_at = excluded.expires_at WHERE expires_at <= ?`)
  const releaseSymbol = database.prepare('DELETE FROM futures_symbol_leases WHERE environment = ? AND user_id = ? AND symbol = ? AND owner = ?')
  const platform = createPlatformStore(database)
  const accounts = createBoundAccounts(database)
  return {
    accounts,
    copy: createCopyStore(database),
    observedTrades: createObservedTrades(database),
    observedPositions: createObservedPositions(database),
    platform,
    reserve(environment, market, userId, clientOrderId, intent) {
      if (!intent) return insert.run(environment, market, userId, clientOrderId).changes === 1
      database.exec('BEGIN IMMEDIATE')
      try {
        const reserved = insert.run(environment, market, userId, clientOrderId).changes === 1
        if (reserved) platform.record(environment, userId, market, clientOrderId, intent)
        database.exec('COMMIT')
        return reserved
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    hasUnlinkedRequests(environment, market, userId, key, symbol) {
      return Boolean(unlinked.get(environment, market, userId, key, symbol, key, symbol))
    },
    reservedOrderIds(environment, market, userId, key, symbol, orders) {
      const ids = JSON.stringify(orders.map(o => o.clientOrderId))
      const requests = new Map(knownClients.all(environment, market, userId, key, symbol, key, symbol, ids).map(r => [r.id, r]))
      const matches = new Set()
      for (const order of orders) {
        const request = requests.get(order.clientOrderId)
        if (!request) continue
        // Legacy reservations have only a local client ID. Match those using
        // the authenticated exchange's mapping from client ID to venue ID.
        const linked = request.orderId ? request.orderId === order.orderId : request.time == null
          || (request.status === 'UNCONFIRMED' && matchesUnconfirmedOrder(request, market,
            order.time, order.side, order.type, order.positionSide))
        if (linked) matches.add(order.orderId)
      }
      return matches
    },
    claimFuturesSymbol(environment, userId, symbol, owner, expiresAt, now) {
      return claimSymbol.run(environment, userId, symbol, owner, expiresAt, now).changes === 1
    },
    releaseFuturesSymbol(environment, userId, symbol, owner) {
      releaseSymbol.run(environment, userId, symbol, owner)
    },
    close() { accounts.clear(); database.close() },
  }
}
