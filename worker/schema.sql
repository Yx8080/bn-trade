CREATE TABLE IF NOT EXISTS order_requests (
  environment TEXT NOT NULL,
  market TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  PRIMARY KEY (environment, market, user_id, client_order_id)
);

CREATE TABLE IF NOT EXISTS futures_symbol_leases (
  environment TEXT NOT NULL, user_id TEXT NOT NULL, symbol TEXT NOT NULL,
  owner TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (environment, user_id, symbol)
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
CREATE INDEX IF NOT EXISTS copy_executions_order_ids ON copy_executions(environment, user_id, key_identity, symbol, order_id);
CREATE INDEX IF NOT EXISTS copy_executions_unsettled ON copy_executions(environment, next_check) WHERE amounts IS NULL;

CREATE TABLE IF NOT EXISTS platform_orders (
  environment TEXT NOT NULL, user_id TEXT NOT NULL, market TEXT NOT NULL, client_id TEXT NOT NULL,
  key_identity TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, type TEXT NOT NULL, position_side TEXT,
  order_id TEXT, status TEXT NOT NULL DEFAULT 'UNCONFIRMED', executed_qty TEXT NOT NULL DEFAULT '0',
  time INTEGER NOT NULL, next_check INTEGER, failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, user_id, market, client_id),
  UNIQUE (environment, user_id, market, key_identity, symbol, order_id)
);
CREATE INDEX IF NOT EXISTS platform_orders_due ON platform_orders(environment, next_check) WHERE next_check IS NOT NULL;
CREATE TABLE IF NOT EXISTS platform_fills (
  environment TEXT NOT NULL, user_id TEXT NOT NULL, market TEXT NOT NULL, client_id TEXT NOT NULL,
  trade_id TEXT NOT NULL, time INTEGER NOT NULL, quantity TEXT NOT NULL, quote REAL NOT NULL, price REAL NOT NULL,
  realized REAL NOT NULL, realized_asset TEXT NOT NULL, fee REAL NOT NULL, fee_asset TEXT NOT NULL,
  PRIMARY KEY (environment, user_id, market, client_id, trade_id)
);
CREATE TABLE IF NOT EXISTS platform_fill_scans (
  environment TEXT NOT NULL, user_id TEXT NOT NULL, market TEXT NOT NULL, client_id TEXT NOT NULL,
  from_id TEXT NOT NULL, PRIMARY KEY (environment, user_id, market, client_id)
);

CREATE TABLE IF NOT EXISTS uid_accounts (
  environment TEXT NOT NULL, user_id TEXT NOT NULL,
  PRIMARY KEY(environment, user_id)
);

-- Only pre-UID workspaces populate this table. An original, verified key
-- can still identify its old journal without retaining its encrypted secret.
CREATE TABLE IF NOT EXISTS legacy_account_owners (
  environment TEXT NOT NULL, key_hash TEXT NOT NULL, user_id TEXT NOT NULL, scopes INTEGER NOT NULL,
  PRIMARY KEY(environment, key_hash)
);

CREATE TABLE IF NOT EXISTS monitor_watchlists (
  owner_id TEXT PRIMARY KEY, portfolio_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS copy_signal_samples (
  portfolio_id TEXT PRIMARY KEY,
  start_time INTEGER,
  end_time INTEGER,
  recovered_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS copy_signals (
  portfolio_id TEXT NOT NULL,
  id TEXT NOT NULL,
  time INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (portfolio_id, id)
);
CREATE INDEX IF NOT EXISTS copy_signals_by_portfolio_time ON copy_signals (portfolio_id, time);
CREATE INDEX IF NOT EXISTS copy_signals_by_time ON copy_signals (time);

CREATE TABLE IF NOT EXISTS portfolio_monitor_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS portfolio_monitor_status (
  portfolio_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observed_trades (
  revision INTEGER PRIMARY KEY, portfolio_id TEXT NOT NULL, trade_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL, payload TEXT NOT NULL, superseded_at_revision INTEGER
);
CREATE INDEX IF NOT EXISTS observed_trades_current ON observed_trades(portfolio_id, trade_key)
  WHERE superseded_at_revision IS NULL;
CREATE INDEX IF NOT EXISTS observed_trades_page ON observed_trades(portfolio_id, updated_at DESC, revision DESC);
