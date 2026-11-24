CREATE TABLE IF NOT EXISTS order_requests (
  environment TEXT NOT NULL,
  market TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  PRIMARY KEY (environment, market, user_id, client_order_id)
);

CREATE TABLE IF NOT EXISTS copy_strategies (
  environment TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  runnable INTEGER NOT NULL,
  next_check INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, user_id)
);

CREATE TABLE IF NOT EXISTS copy_executions (
  environment TEXT NOT NULL, user_id TEXT NOT NULL, client_id TEXT NOT NULL, order_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL, key_identity TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  kind TEXT NOT NULL, time INTEGER NOT NULL, quantity REAL NOT NULL, price REAL NOT NULL,
  amounts TEXT, next_check INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, user_id, client_id)
);
CREATE INDEX IF NOT EXISTS copy_executions_history ON copy_executions(environment, user_id, time DESC);
CREATE INDEX IF NOT EXISTS copy_executions_unsettled ON copy_executions(environment, next_check) WHERE amounts IS NULL;
