export function createCopyStore(db) {
  const eligible = column => `(? IS NULL OR ${column} IN (SELECT value FROM json_each(?)))`
  const ownerFilter = owners => owners ? [1, JSON.stringify(owners)] : [null, null]
  const matchingOrders = db.prepare(`SELECT order_id AS orderId,
    CASE WHEN COUNT(DISTINCT portfolio_id)=1 THEN MIN(portfolio_id) END AS portfolioId,
    CASE WHEN COUNT(DISTINCT kind)=1 THEN MIN(kind) END AS copyKind,
    CASE WHEN COUNT(DISTINCT direction)=1 THEN MIN(direction) END AS copyDirection
    FROM copy_executions WHERE environment=? AND user_id=? AND key_identity=? AND symbol=?
    AND order_id IN (SELECT value FROM json_each(?)) GROUP BY order_id`)
  const get = db.prepare('SELECT state, revision FROM copy_strategies WHERE environment = ? AND user_id = ?')
  const list = db.prepare(`SELECT user_id FROM copy_strategies WHERE environment = ? AND runnable = 1
    AND next_check <= ? AND lease_until <= ? AND ${eligible('user_id')} ORDER BY next_check LIMIT 4`)
  const exposed = db.prepare(`SELECT user_id AS userId, json_extract(p.value, '$.symbol') AS symbol,
    json_extract(p.value, '$.direction') AS direction, json_extract(p.value, '$.quantity') AS quantity,
    json_extract(p.value, '$.entryPrice') AS entryPrice, json_extract(s.state, '$.config.stopLoss') AS stopLoss
    FROM copy_strategies AS s, json_each(s.state, '$.positions') AS p
    WHERE s.environment = ? AND s.runnable = 1 AND json_extract(s.state, '$.pending') IS NULL
    AND coalesce(json_extract(s.state, '$.retryAt'), 0) <= ? AND ${eligible('s.user_id')}`)
  const wake = db.prepare(`UPDATE copy_strategies SET next_check = 0 WHERE environment = ? AND user_id = ?
    AND runnable = 1 AND lease_until <= ? AND coalesce(json_extract(state, '$.retryAt'), 0) <= ?
    AND json_extract(state, '$.pending') IS NULL AND json_array_length(state, '$.positions') > 0`)
  const insert = db.prepare(`INSERT INTO copy_strategies (environment, user_id, state, revision, runnable)
    VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING`)
  const update = db.prepare(`UPDATE copy_strategies SET state = ?, runnable = ?, revision = revision + 1
    WHERE environment = ? AND user_id = ? AND revision = ?
    AND (? IS NULL OR (lease_owner = ? AND lease_until > ?))`)
  const claim = db.prepare(`UPDATE copy_strategies SET lease_owner = ?, lease_until = ?
    WHERE environment = ? AND user_id = ? AND runnable = 1 AND next_check <= ? AND lease_until <= ?`)
  const renew = db.prepare(`UPDATE copy_strategies SET lease_until = ?
    WHERE environment = ? AND user_id = ? AND lease_owner = ? AND lease_until > ?`)
  const release = db.prepare(`UPDATE copy_strategies SET lease_owner = NULL, lease_until = 0, next_check = ?
    WHERE environment = ? AND user_id = ? AND lease_owner = ?`)
  const execution = db.prepare(`INSERT INTO copy_executions
    (environment, user_id, client_id, order_id, portfolio_id, key_identity, symbol, direction, kind, time, quantity, price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(environment, user_id, client_id) DO UPDATE SET
      quantity = excluded.quantity, price = excluded.price,
      amounts = CASE WHEN excluded.quantity = copy_executions.quantity THEN copy_executions.amounts END,
      next_check = CASE WHEN excluded.quantity = copy_executions.quantity THEN copy_executions.next_check ELSE 0 END
    WHERE excluded.quantity > copy_executions.quantity OR
      (excluded.quantity = copy_executions.quantity AND excluded.price <> copy_executions.price)`)
  const unsettled = db.prepare(`SELECT e.user_id AS userId, key_identity AS keyIdentity, client_id AS clientId,
    order_id AS orderId, symbol, quantity FROM copy_executions AS e JOIN copy_strategies AS s
    ON s.environment = e.environment AND s.user_id = e.user_id WHERE e.environment = ? AND amounts IS NULL
    AND e.next_check <= ? AND coalesce(json_extract(s.state, '$.retryAt'), 0) <= ? AND ${eligible('e.user_id')}
    ORDER BY e.next_check, time LIMIT 2`)
  const defer = db.prepare(`UPDATE copy_executions SET next_check = ? WHERE environment = ? AND user_id = ?
    AND client_id = ? AND amounts IS NULL AND quantity = ? AND next_check <= ?`)
  const settle = db.prepare(`UPDATE copy_executions SET amounts = ? WHERE environment = ? AND user_id = ?
    AND client_id = ? AND quantity = ? AND amounts IS NULL`)
  const counts = db.prepare(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE amounts IS NULL) AS pendingCount
    FROM copy_executions WHERE environment = ? AND user_id = ? AND key_identity = coalesce(?, key_identity)`)
  const totals = db.prepare(`SELECT json_extract(a.value, '$.asset') AS asset,
    SUM(json_extract(a.value, '$.realized')) AS realized, SUM(json_extract(a.value, '$.fees')) AS fees
    FROM copy_executions AS e, json_each(e.amounts) AS a WHERE e.environment = ? AND e.user_id = ?
    AND e.key_identity = coalesce(?, e.key_identity) GROUP BY asset`)
  const history = db.prepare(`SELECT client_id AS clientOrderId, order_id AS orderId, portfolio_id AS portfolioId, symbol, direction,
    kind, time, quantity, price, amounts FROM copy_executions WHERE environment = ? AND user_id = ? AND key_identity = coalesce(?, key_identity)
    ORDER BY time DESC, client_id LIMIT ? OFFSET ?`)
  return {
    orderPortfolios(environment, id, keyIdentity, symbol, ids) {
      return matchingOrders.all(environment, id, keyIdentity, symbol, JSON.stringify(ids))
    },
    read(environment, id) {
      const row = get.get(environment, id)
      return row ? { state: JSON.parse(row.state), revision: row.revision } : null
    },
    ready(environment, now, owners) {
      return list.all(environment, now, now, ...ownerFilter(owners)).map(row => row.user_id)
    },
    exposures: (environment, now, owners) => exposed.all(environment, now, ...ownerFilter(owners)),
    wakeRisk: (environment, id, now) => wake.run(environment, id, now, now).changes === 1,
    claim(environment, id, owner, now) {
      return claim.run(owner, now + 90_000, environment, id, now, now).changes === 1
    },
    renew(environment, id, owner, now) {
      return renew.run(now + 90_000, environment, id, owner, now).changes === 1
    },
    release(environment, id, owner, nextCheck) {
      release.run(nextCheck, environment, id, owner)
    },
    write(environment, id, state, revision, owner = null, fill) {
      const data = JSON.stringify(state)
      const runnable = Number(Boolean(state.enabled || state.positions.length || state.pending))
      if (fill) db.exec('BEGIN IMMEDIATE')
      try {
        const result = revision === 0
          ? insert.run(environment, id, data, runnable)
          : update.run(data, runnable, environment, id, revision, owner, owner, Date.now())
        if (fill && result.changes === 1) execution.run(environment, id, fill.clientOrderId, fill.orderId,
          fill.portfolioId, state.keyIdentity, fill.symbol, fill.direction, fill.kind, fill.time, fill.quantity, fill.price)
        if (fill) db.exec('COMMIT')
        return result.changes === 1
      } catch (error) {
        if (fill) db.exec('ROLLBACK')
        throw error
      }
    },
    settlementsDue: (environment, now, owners) => unsettled.all(environment, now, now, ...ownerFilter(owners)),
    claimSettlement(environment, row, now) {
      return defer.run(now + 60_000, environment, row.userId, row.clientId, row.quantity, now).changes === 1
    },
    delaySettlement(environment, row, until) {
      defer.run(until, environment, row.userId, row.clientId, row.quantity, until)
    },
    settle(environment, row, amounts) {
      settle.run(JSON.stringify(amounts), environment, row.userId, row.clientId, row.quantity)
    },
    pnl(environment, id, page, key = null) {
      const saved = this.read(environment, id)?.state
      const state = key === null || key === saved?.keyIdentity ? saved : null
      const pageSize = 20
      const rows = history.all(environment, id, key, pageSize, (page - 1) * pageSize).map(row => ({
        ...row, settled: row.amounts !== null, amounts: JSON.parse(row.amounts ?? '[]'),
      }))
      return { ...counts.get(environment, id, key), pageSize, rows,
        totals: totals.all(environment, id, key).map(row => ({ ...row, net: row.realized - row.fees })),
        openCount: state?.positions.length ?? 0, unrealized: state?.unrealized ?? null,
        unrealizedAt: state?.unrealizedAt ?? null }
    },
  }
}
