import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createCopyStore } from '../server/copy-store.js'

export function createLocalOrderDb(filename) {
  const database = new DatabaseSync(filename)
  database.exec('PRAGMA busy_timeout = 3000')
  database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
  const insert = database.prepare(
    'INSERT INTO order_requests (environment, market, user_id, client_order_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
  return {
    copy: createCopyStore(database),
    reserve(environment, market, userId, clientOrderId) {
      return insert.run(environment, market, userId, clientOrderId).changes === 1
    },
    close: () => database.close(),
  }
}
