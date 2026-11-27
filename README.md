# Binance Trading Workbench

Monitor public fills from Binance lead traders, configure futures copy trading, place manual orders, and review the P&L from your own fills in one workspace. The frontend uses Vue 3 and TypeScript. A Node.js service handles account access, strategy execution, and the SQLite ledger.

## Getting started

Use Node.js 22.21 or later in the 22.x series, or Node.js 24.5 or later.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite, which defaults to `http://127.0.0.1:5173`. The app connects to Binance live trading accounts. This README translates the app's Chinese interface labels into English.

1. **Watch public fills.** Open **Lead Trader Monitor → Manage Portfolios → Add Portfolio**. Enter a Binance futures lead trader's portfolio URL or the numeric ID after `/lead-details/`, then click **Save Portfolios**. The server collects fills in the background, and the monitor reads them from SQLite. [Example Binance portfolio](https://www.binance.com/zh-CN/copy-trading/lead-details/5075281354358777856)
2. **Preview copy trading.** Open **Futures Trading → Copy Trading**. Select lead traders, choose an order sizing rule, and review the leverage and stop loss under **Preview Copy Trading Settings**. Guests can preview their settings. Start the strategy from the confirmation dialog after connecting a Binance futures account.
3. **Place manual orders and review fills.** Open **Futures Trading → Manual Trading** for futures entries or **Spot Buy** for spot market buys. **Execution Status** shows copied positions and pending orders. **P&L** shows verified platform fills, P&L, fees, and exchange account activity.

Open **User Guide** in the sidebar for step-by-step instructions.

## Troubleshooting 502 errors on public data requests

If the monitor reports that the server cannot reach Binance, check whether the machine running the Node.js service can reach Binance and whether your proxy is running. On Windows, the service reads the current user's system proxy rules for the destination. In development, preview, and production, you can set `HTTPS_PROXY` (or `HTTP_PROXY`) and `NO_PROXY` in the project root's `.env.local` file or in the process environment. Explicit proxy settings take precedence. Restart the Node.js service after changing them. When Binance is unreachable, you can still browse SQLite history while the workbench service is running.

## Reviewing lead trader P&L

- **Trade History** defaults to the last 24 hours and shows both opening and closing fills. Date and portfolio filters and **Load Older Trades** all read SQLite. Repeated samples are deduplicated, and updates with the same portfolio, symbol, and Binance order ID are merged in the current view. **Reported Closing P&L** sums the `totalPnl` reported on loaded closing fills, grouped by settlement asset.
- **Closed Positions** reconstructs closed positions from archived trades by portfolio, symbol, and direction. A row appears when the recorded opening and closing quantities balance. Entry and exit prices are weighted by executed quantity. The row sums disclosed closing P&L and shows **Incomplete Disclosure** if any closing fill lacks a P&L value. The public data has no separate fee field.

The server stores guest and account portfolio IDs in SQLite and polls each portfolio for all watchlists that include it. A new or restarted collector looks back up to 24 hours. Collection continues while the server is running, including after you close the browser. Date filters only search the archive. Portfolio notes stay in the browser. To register a custom list saved in an older browser-only version, save it again under **Manage Portfolios**. Times are shown in Beijing time (UTC+8).

## Copy trading and P&L

For each live account, you can select one or more lead traders in a single strategy. The strategy follows new fills from the time it starts. The selected portfolios share order sizing, leverage, and the limit on concurrent positions. The portfolio that triggers the first entry for a symbol controls that position. The strategy skips signals for that symbol from other portfolios while the position is open. Copy trading positions and fill records show the portfolio that triggered them.

The background monitor collects each portfolio's public fills and publishes complete batches to its subscribed strategies. When new entries are paused, the monitor continues collecting for portfolios with positions or orders still under strategy management.

New strategies default to **Fixed Amount**. With 10 USDT of margin per order and 10× leverage, the target notional is 100 USDT. If you select **Fixed Ratio**, the margin for each order is total futures account equity multiplied by the configured percentage. With 1,000 USDT of equity, a 2% allocation, and 10× leverage, the target margin is 20 USDT and the notional is about 200 USDT. The strategy refreshes equity every time it opens or adds to a position. It uses Binance's account-level `totalMarginBalance`, which includes unrealized P&L. For futures accounts in Multi-Assets Mode, the service converts that value to USDT using Binance's USDT/USD index. Order quantities are rounded down to the exchange's quantity step. Trading fees are charged separately.

Expand **Advanced Settings** to configure leverage, entry rules, and position limits. **First Entry Only** follows only the first entry per position. **Auto Add** under **Copy Entry Mode** follows later same-direction entries from the owning portfolio up to the configured count, including the first entry. The concurrent-position limit applies across all selected portfolios and counts symbols.

New strategies default to **Highest Available Leverage**, which selects the maximum for the symbol and projected total position size. **Custom Tiers** sets the target according to the symbol's maximum leverage. Blank or unlisted tiers use the highest available leverage. The service caps the target at the allowed leverage and recalculates quantity at that leverage before checking available USDT margin and exchange order limits. Connected accounts can use **Look Up Leverage Tiers** to inspect a symbol's limits. Earlier strategies may still show their saved notional and leverage settings in the preview.

The strategy trades USDT-margined futures using the Binance account's active position mode. In Hedge Mode, long and short positions can be copied and closed independently on the same symbol, count as one symbol toward the limit, and share leverage. A shared mark-price WebSocket subscribes only to symbols held by the strategy. When the stop-loss threshold is reached, the service verifies the actual position and submits a market order to close the copied quantity. Periodic checks continue if the WebSocket stream is interrupted. Local stop losses require the service to be running, and slippage can push the actual loss past the trigger value. The first time the lead trader closes any part of the corresponding position, the strategy exits its entire copied quantity.

**When a Position Already Exists** defaults to **Skip**. Select **Auto Add** in that setting to allow a first copy entry against an existing same-direction position when fill records verify that it came entirely from manual workbench orders. In Hedge Mode, this setting checks the side being opened. The strategy calculates stop loss using the copied quantity and its average entry price, and requests a close for that quantity. Binance settles using the combined average entry price. The workbench reads realized P&L and fees from Binance's fill confirmations.

An active strategy keeps running on the Node.js service after you close the browser. After a service restart, reconnect the same live account so the strategy can resume processing new signals, following closures, and executing local stop losses. **Pause New Entries** leaves stop losses and copied exits active for existing positions and continues reconciling submitted orders. To change portfolios or strategy settings, pause first and wait until all copied positions are closed and pending orders are reconciled.

The **P&L** ledger covers only automated copy trades, manual futures trades, and spot buys placed through the workbench. The SQLite file is `.trade-data/orders.sqlite`. The service reconciles actual fills by account, environment, market, symbol, and order identifier, then totals realized P&L and fees by asset. Spot buy amounts are recorded as cost, and unrealized P&L is shown separately. Existing copy trading history remains available. The order identifiers used to prevent duplicate manual orders in earlier versions contain too little information to reconstruct those fills and costs. Other exchange fills and account positions are fetched from Binance on demand and shown separately. If a current position cannot be matched to workbench fills, its unrealized P&L is marked as pending verification. Check funding fees separately in your Binance transaction history.

## Connecting a Binance account

1. Click **Connect Account** in the upper-right corner and enter your live Binance **HMAC API Key and API Secret**. For local access, you can use localhost or 127.0.0.1 directly. Use HTTPS when accessing the workbench over a network.
2. Click **Verify and Connect Account**. The service reads the UID from the signed Spot account endpoint, including when you plan to use only futures trading. It checks futures access separately. Once connected, check the displayed UID and verified markets. Placing orders requires the relevant spot or futures trading permissions.
3. Reconnect after refreshing the page or when your session expires to access the ledger and strategies. If you replace an API key, Binance must verify that it belongs to the same account for you to access the same records. **Disconnect Account** ends the current session. Active copy trading strategies continue in the background. Click **Pause New Entries** before disconnecting if you want to stop following new entries.

The connection dialog first checks whether the backend supports in-memory credentials and UID verification. If it reports an incompatible backend version, restart the Node.js service with the updated code and click **Retry** to display the credential fields.

The workbench supports live trading. Existing testnet rows are archived in their original SQLite scope. Older fixed-token configurations are accepted only if explicitly marked `BINANCE_FUTURES_ENV=live`. If you upgraded from a version that used key-based workspaces, connect once with the original, still-valid live key so the service can verify the UID associated with your historical records.

API keys and secrets entered through the workbench are held only in memory. The browser clears the input fields after a successful connection. The session credential held in page memory lasts up to 12 hours. The service keeps each verified market's credentials in memory after you disconnect, until you replace them or the service process exits. After a service restart, reconnect the Binance accounts whose strategies need to run.

SQLite persists account UIDs, strategies, orders, and P&L records. Upgrading clears encrypted credentials stored by earlier versions from the current database. Database backups and decrypted files created before upgrading retain their original contents.

## Market data and order placement

| Feature | Binance API and behavior |
| --- | --- |
| Futures market data | `/fapi/v2/ticker/price` returns the latest trade price, and `/fapi/v1/premiumIndex` returns the mark price. The page uses WebSocket updates and fetches HTTP snapshots on first load or when the stream is interrupted. |
| Futures positions and balances | `/fapi/v3/positionRisk` returns nonzero positions and unrealized P&L. `/fapi/v3/account` returns wallet and available balances. |
| Futures leverage and orders | `GET /fapi/v1/leverageBracket` returns the account's notional brackets and maximum leverage for the contract. The current position determines the applicable bracket. `/fapi/v1/symbolConfig` returns the configured leverage. The service sets leverage with `POST /fapi/v1/leverage`, then submits the order with `POST /fapi/v1/order`. |
| Spot market data and balances | `/api/v3/ticker/price` returns a price snapshot, and the page receives the latest price by WebSocket. `/api/v3/account` returns available and locked balances. |
| Spot buys | `POST /api/v3/order` uses `MARKET BUY` with `quoteOrderQty` to place an order for the entered USDT amount. |

For a manual futures entry, the workbench reads the current position mode from Binance. **Market** uses a fixed USDT margin. The available-balance slider fills in that amount. **Limit** accepts a limit price and a size in fixed USDT margin, a percentage of total futures equity, or contract quantity. Limit orders stay open until filled or canceled (GTC). Click **Preview Long Entry** or **Preview Short Entry** to check the account, price, and quantity before confirming. In One-Way Mode, a fill on the opposite side first reduces the existing net position. Any excess opens a position on the opposite side.

To close a position manually, go to **Futures Account → Current Positions** and click **Close** on the relevant row. Choose the full position, a percentage, or a contract quantity. The workbench checks that the position still matches before sending the market order. In Hedge Mode, you can manage long and short positions independently. **View Fills** on a position row opens recent fills for that contract and their sources where available.

Open **Futures Orders → P&L Calculator** to estimate futures P&L and return using the direction, entry price, target exit price, margin, and leverage. The estimate assumes a full exit at the target and excludes trading fees, funding, and liquidation. **Futures Account** displays Binance's mark-price-based unrealized P&L for actual positions.

Each confirmation uses a unique client order ID, which the service records in SQLite before forwarding the order. For position closes, the workbench automatically checks the original order when the result is pending and refreshes the positions when confirmed. For futures entries and spot buys, select **Look Up Original Order** if the request times out. The Binance response shows the status, filled quantity, and average fill price.

## Build, deployment, and maintenance

```sh
npm test
npm run build
npm start
```

`src/components/` contains the interfaces for lookups, positions, market data, and order placement. `server/portfolio-monitor.js` collects public fills, and `src/usePortfolioHistory.ts` reads monitor status and paginates archived fills. `src/futures.ts` is the browser-side trading API client. `worker/futures.js` and `worker/spot.js` handle their respective markets, and `worker/trading.js` handles identity, request signing, and duplicate order prevention.

Run `npm start` from the project root to serve the app at `http://127.0.0.1:3000` by default. Use `HOST` and `PORT` to change the bind address and port. For shared access over a network, put the service behind an HTTPS reverse proxy. Store `.trade-data/` on persistent storage so strategies, order reconciliation records, and the P&L ledger survive restarts. The production server and the Vite development server share `server/api.js`.

Binance references are available for [USDⓈ-M Futures](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info), [Spot trading endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints), and [copy trading portfolio metrics](https://www.binance.com/en/support/faq/detail/54aa6d3b43bc4f6eb4a3a6e3aea40acd).
