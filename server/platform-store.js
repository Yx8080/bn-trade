import { createHash } from 'node:crypto'
import { units } from '../worker/futures-sizing.js'

// Pre-UID records used a key fingerprint. Verified accounts keep the same
// accounting identity through key rotations.
export function ledgerIdentity(ownerId, apiKey) {
  if (!apiKey) return null
  return ownerId.startsWith('uid:') ? ownerId : createHash('sha256').update(apiKey).digest('hex')
}
export const terminalOrder = status => ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(status)
// A client order ID can be reused on the exchange after an earlier order ends.
// Match an unknown venue ID only within the original request's submission window.
export function matchesUnconfirmedOrder(row, market, time, side, type, positionSide) {
  return Number.isSafeInteger(time) && time >= row.time - 1000 && time <= row.time + 120_000
    && row.side === side && row.type === type && (market !== 'futures' || row.positionSide === positionSide)
}
const keyOf = row => [row.environment, row.userId, row.market, row.clientOrderId]
const idWhere = 'environment=? AND user_id=? AND market=? AND client_id=?'
const fields = `environment,user_id AS userId,market,client_id AS clientOrderId,
  key_identity AS keyIdentity,symbol,side,type,position_side AS positionSide,
  order_id AS orderId,status,executed_qty AS executedQty,time,failures`
const scope = `o.environment=? AND o.user_id=? AND (?=0 OR
  (o.market='futures' AND o.key_identity=?) OR (o.market='spot' AND o.key_identity=?))`
const joined = 'platform_orders o JOIN platform_fills f USING(environment,user_id,market,client_id)'

export function createPlatformStore(db) {
  const insert = db.prepare(`INSERT INTO platform_orders
    (environment,user_id,market,client_id,key_identity,symbol,side,type,position_side,time,next_check)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  const get = db.prepare('SELECT ' + fields + ' FROM platform_orders WHERE ' + idWhere)
  const next = db.prepare(`SELECT ${fields},next_check AS nextCheck FROM platform_orders
    WHERE environment=? AND next_check <= ? AND (? IS NULL OR user_id IN
      (SELECT value FROM json_each(CASE market WHEN 'spot' THEN ? ELSE ? END)))
    ORDER BY next_check,time LIMIT 4`)
  const claim = db.prepare('UPDATE platform_orders SET next_check=? WHERE ' + idWhere + ' AND next_check=?')
  const ack = db.prepare(`UPDATE platform_orders SET order_id=?,status=?,executed_qty=?,
    next_check=CASE WHEN ? THEN NULL WHEN ? THEN ? WHEN ? THEN min(next_check,?) ELSE next_check END
    WHERE ${idWhere}`)
  const reject = db.prepare(`UPDATE platform_orders SET status='REJECTED',next_check=NULL
    WHERE ${idWhere} AND key_identity=? AND status='UNCONFIRMED' AND order_id IS NULL`)
  const insertFill = db.prepare(`INSERT INTO platform_fills
    (environment,user_id,market,client_id,trade_id,time,quantity,quote,price,realized,realized_asset,fee,fee_asset)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(environment,user_id,market,client_id,trade_id) DO NOTHING`)
  const quantities = db.prepare('SELECT quantity FROM platform_fills WHERE ' + idWhere)
  // Even one very small fill can carry a material realized P&L or commission.
  // Compare the exchange decimals exactly before removing an order from polling.
  const filledUnits = key => {
    let total = 0n
    for (const row of quantities.iterate(...key)) total += units(row.quantity)
    return total
  }
  const scan = db.prepare('SELECT from_id AS fromId FROM platform_fill_scans WHERE ' + idWhere)
  const setScan = db.prepare(`INSERT INTO platform_fill_scans (environment,user_id,market,client_id,from_id) VALUES (?,?,?,?,?)
    ON CONFLICT(environment,user_id,market,client_id) DO UPDATE SET from_id=excluded.from_id`)
  const retry = db.prepare('UPDATE platform_orders SET failures=failures+1,next_check=? WHERE ' + idWhere + ' AND next_check IS NOT NULL')
  const finish = db.prepare('UPDATE platform_orders SET failures=0,next_check=? WHERE ' + idWhere + ' AND next_check IS NOT NULL')
  const known = db.prepare(`SELECT order_id AS id FROM platform_orders WHERE environment=? AND user_id=? AND key_identity=?
    AND market=? AND symbol=? AND order_id IN (SELECT value FROM json_each(?))`)

  const orderAmounts = db.prepare(`SELECT asset,SUM(realized) AS realized,SUM(fees) AS fees,SUM(realized-fees) AS net FROM (
    SELECT realized_asset AS asset,realized,0 AS fees FROM platform_fills WHERE ${idWhere}
    UNION ALL SELECT fee_asset AS asset,0,fee FROM platform_fills WHERE ${idWhere}
    ) GROUP BY asset ORDER BY asset`)
  const totals = db.prepare(`WITH owned AS (SELECT f.* FROM ${joined} WHERE ${scope})
    SELECT asset,SUM(realized) AS realized,SUM(fees) AS fees,SUM(realized-fees) AS net FROM (
    SELECT realized_asset AS asset,realized,0 AS fees FROM owned UNION ALL SELECT fee_asset,0,fee FROM owned
    ) GROUP BY asset ORDER BY asset`)
  const counts = db.prepare(`SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM platform_fills f WHERE
    (f.environment,f.user_id,f.market,f.client_id)=(o.environment,o.user_id,o.market,o.client_id))) AS total,
    count(*) FILTER (WHERE next_check IS NOT NULL) AS pendingCount FROM platform_orders o WHERE ${scope}`)
  const history = db.prepare(`SELECT o.market,o.symbol,o.client_id AS clientOrderId,o.order_id AS orderId,
    o.side,o.type,o.position_side AS positionSide,o.status,max(f.time) AS time,sum(f.quantity) AS quantity,
    sum(f.quote) AS quote,o.next_check IS NULL AS settled FROM ${joined} WHERE ${scope}
    GROUP BY o.market,o.client_id ORDER BY time DESC,o.market,o.client_id LIMIT ? OFFSET ?`)
  const spot = db.prepare(`SELECT o.key_identity AS keyIdentity,o.symbol,
    SUM(f.quantity-CASE WHEN f.fee_asset=substr(o.symbol,1,length(o.symbol)-4) THEN f.fee ELSE 0 END) AS quantity,
    SUM(f.quote+CASE WHEN f.fee_asset='USDT' THEN f.fee ELSE 0 END) AS cost,min(f.time) AS firstBuyTime
    FROM ${joined} WHERE ${scope} AND o.market='spot' GROUP BY o.key_identity,o.symbol`)
  const futuresFills = db.prepare(`SELECT o.key_identity AS keyIdentity,o.symbol,o.side,o.position_side AS positionSide,
    f.quantity,f.price,f.time,f.trade_id AS tradeId FROM ${joined} WHERE ${scope} AND o.market='futures'
    ORDER BY f.time,length(f.trade_id),f.trade_id`)
  const scoped = (environment, userId, keys) => [environment, userId, Number(keys != null), keys?.futures ?? null, keys?.spot ?? null]

  return {
    record(environment, userId, market, clientOrderId, intent) {
      const now = Date.now()
      insert.run(environment, userId, market, clientOrderId, ledgerIdentity(userId, intent.apiKey), intent.symbol,
        intent.side, intent.type, intent.positionSide ?? null, now, now + 5000)
    },
    due(environment, now, owners) {
      const rows = next.all(environment, now, owners ? 1 : null, JSON.stringify(owners?.spot ?? []), JSON.stringify(owners?.futures ?? []))
      return rows.filter(row =>
        claim.run(now + 120_000, ...keyOf(row), row.nextCheck).changes === 1)
    },
    acknowledge(environment, userId, market, apiKey, receipt, venueTime, lookup = false, positionSide) {
      const key = [environment, userId, market, receipt.clientOrderId]
      const identity = ledgerIdentity(userId, apiKey)
      // The receipt might arrive while a poll in another process reconciles
      // this order. Never replace a newer cumulative or terminal receipt.
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = get.get(...key)
        const qty = /^\d+(\.\d+)?$/.test(receipt.executedQty) ? units(receipt.executedQty) : -1n
        const prior = row ? units(row.executedQty) : 0n
        const terminal = terminalOrder(receipt.status)
        const valid = row && row.keyIdentity === identity && row.symbol === receipt.symbol
          && row.side === receipt.side && row.type === receipt.type && (!row.orderId || row.orderId === receipt.orderId)
          && (!lookup || market !== 'futures' || positionSide === row.positionSide)
          && (!lookup || row.orderId || matchesUnconfirmedOrder(row, market, venueTime, receipt.side, receipt.type, positionSide))
          && qty >= prior && (receipt.status !== 'FILLED' || qty > 0n)
          && (!terminalOrder(row.status) || row.status === receipt.status)
        if (valid) {
          const now = Date.now()
          ack.run(receipt.orderId, receipt.status, receipt.executedQty, Number(terminal && !qty), Number(qty > prior),
            now, Number(!lookup), now, ...key)
        }
        db.exec('COMMIT')
        return Boolean(valid)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    reject(environment, userId, market, clientOrderId, apiKey) {
      reject.run(environment, userId, market, clientOrderId, ledgerIdentity(userId, apiKey))
    },
    latest(row) { return get.get(...keyOf(row)) },
    fillProgress(row) {
      const key = keyOf(row)
      return { units: filledUnits(key), fromId: scan.get(...key)?.fromId ?? '0' }
    },
    retry(row, deadline) { retry.run(deadline, ...keyOf(row)) },
    saveFills(row, fills, now) {
      const key = keyOf(row)
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = get.get(...key)
        if (!current?.orderId || current.orderId !== row.orderId) throw Error('Order identity changed')
        for (const f of fills) insertFill.run(...key, f.id, f.time, f.quantity, f.quote, f.price, f.realized, f.realizedAsset, f.fee, f.feeAsset)
        const filled = filledUnits(key)
        const expected = units(current.executedQty)
        const equal = filled === expected
        if (terminalOrder(current.status) && filled > expected) throw Error('Inconsistent cumulative fill quantity')
        // If the venue's trade list is temporarily missing an older ID, an
        // empty tail must restart the scan. Persist full-page progress so large
        // orders advance across polls, and de-duplicate replayed fills by ID.
        if (!equal && fills.length < 1000) setScan.run(...key, '0')
        else if (fills.length) {
          const highest = fills.reduce((max, fill) => BigInt(fill.id) > max ? BigInt(fill.id) : max, 0n)
          setScan.run(...key, String(highest + 1n))
        }
        const finished = equal && terminalOrder(current.status)
        finish.run(finished ? null : now + (fills.length >= 1000 ? 1000 : 15_000), ...key)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    orderIds(environment, userId, keyIdentity, market, symbol, ids) {
      return new Set(known.all(environment, userId, keyIdentity, market, symbol, JSON.stringify([...ids])).map(row => row.id))
    },
    futuresFills(environment, userId, keys) {
      return futuresFills.all(...scoped(environment, userId, keys)).map(row => ({ ...row, quantity: Number(row.quantity) }))
    },
    report(environment, userId, page = 1, keys) {
      const params = scoped(environment, userId, keys)
      const pageSize = 20
      db.exec('BEGIN')
      try {
        const rows = history.all(...params, pageSize, (page - 1) * pageSize).map(row => {
          const key = [environment, userId, row.market, row.clientOrderId]
          return { ...row, settled: Boolean(row.settled), amounts: orderAmounts.all(...key, ...key) }
        })
        const report = { ...counts.get(...params), pageSize, rows, totals: totals.all(...params), spot: spot.all(...params) }
        db.exec('COMMIT')
        return report
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}
