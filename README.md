# Binance Trading Workbench

Monitor public fills from Binance lead traders, configure futures copy trading, place manual orders, and review the P&L from your own fills in one workspace. The frontend uses Vue 3 and TypeScript. A Node.js service handles account access, strategy execution, and the SQLite ledger.

## Getting started

Use Node.js 22.21 or later in the 22.x series, or Node.js 24.5 or later.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite, which defaults to `http://127.0.0.1:5173`. The menu and button names below are English translations of the labels in the app's Chinese interface.

1. **Watch public fills.** The **Lead Trader Monitor** on the home page automatically polls the portfolios you follow. Under **Manage Portfolios → Add Portfolio**, paste a Binance futures lead trader's portfolio URL or enter the numeric ID after `/lead-details/`. For example, use portfolio ID `5075281354358777856`. [Example Binance portfolio](https://www.binance.com/zh-CN/copy-trading/lead-details/5075281354358777856)
2. **Preview your copy trading settings.** Open **Futures Trading → Copy Trading**. Under **Lead Traders**, select one or more traders, choose fixed margin or a percentage of total futures account equity, and set the leverage. Use **Add Portfolio** if a trader is missing. As a guest, you can select **Preview Copy Trading Settings** to review the selected traders, order sizing, and estimated initial margin. Connect an account and confirm the trading environment before starting.
3. **Review your results.** **Copy Trading → Execution Status** shows strategy positions and orders awaiting reconciliation. **P&L** summarizes verified fills and fees from copy trades, manual futures trades, and spot buys placed through the workbench. It also lets you look up other fills on Binance separately. Place manual futures orders under **Futures Trading → Manual Trading** and spot market buys under **Spot Buy**.

Open **User Guide** in the sidebar for screenshots and step-by-step instructions on finding portfolio IDs, connecting an account, setting a stop loss, pausing a strategy, and reviewing P&L.

## Troubleshooting 502 errors on public data requests

If the live monitor reports that the server cannot reach Binance, check whether the machine running the Node.js service can reach Binance and whether your proxy is running. On Windows, the service reads the current user's system proxy rules for the destination. In development, preview, and production, you can set `HTTPS_PROXY` (or `HTTP_PROXY`) and `NO_PROXY` in the project root's `.env.local` file or in the process environment. Explicit proxy settings take precedence. Restart the Node.js service after changing them. While offline, you can still search and browse public fills already stored in SQLite.

## Reviewing lead trader P&L

- **Trade History** filters the public fills captured in SQLite by date and portfolio. **Load Older Trades** also reads from local storage. The workbench uses Binance's reported `totalPnl` to display P&L for fills that close long or short positions and flags missing values. Totals cover only loaded closing fills with reported P&L and are calculated separately by asset.
- **Closed Positions** shows paginated SQLite records by portfolio. When the live monitor detects a closing fill, the service checks the latest position disclosures only if the position or its disclosed fields are missing locally. It tries to match by position ID first. If the fill has no position ID, the symbol, side, and closing time down to the millisecond must uniquely identify the position. The reported `closingPnl` gives the P&L for the whole position. Existing values are preserved, including zero.
- **Account Positions** shows unrealized P&L reported by Binance based on the mark price. The futures calculator estimates price P&L for linear contracts from the side, entry price, mark price, and quantity, before trading fees and funding.

You can add a portfolio by Binance details URL or numeric ID and attach a note. The watchlist is stored in the current browser, with separate lists for guests and each account. Local public fill history is shared by portfolio ID. Times are shown in Beijing time (UTC+8). Collection begins when the monitoring page is visible. Pages watching the same portfolio share one collector. The service samples only the latest page and starts from the current feed on first launch, when you reopen the monitor, or when the network recovers. Gaps in collection are left unfilled. Date filters affect only the locally displayed records.

## Copy trading and P&L

For each account and trading environment, you can select one or more lead traders in a single strategy. The strategy follows new fills from the time it starts. The selected portfolios share order sizing, leverage, and the limit on concurrent positions. The portfolio that triggers the first entry for a symbol controls that position. The strategy skips signals for that symbol from other portfolios while the position is open. Copy trading positions and fill records show the portfolio that triggered them.

New strategies use fixed margin by default. With 10 USDT of margin per order and 10× leverage, the target notional is 100 USDT. If you select **Percentage of Total Equity**, the margin for each order is total futures account equity multiplied by the configured percentage. With 1,000 USDT of equity, a 2% allocation, and 10× leverage, the target margin is 20 USDT and the notional is about 200 USDT. The strategy refreshes equity every time it opens or adds to a position. It uses Binance's account-level `totalMarginBalance`, which includes unrealized P&L. For futures accounts in Multi-Assets Mode, the service converts that value to USDT using Binance's USDT/USD index. Order quantities are rounded down to the exchange's quantity step. Trading fees are charged separately.

**Copy Only the First Entry** skips subsequent entries in the same direction while the position is open. **Add Using the Same Rules** recalculates margin with the selected sizing rule. The per-position entry count includes the first order. For older strategies, the preview shows the original notional and leverage settings. After connecting a futures account, you can look up Binance leverage brackets for a symbol. Lead traders can trade multiple contracts, so before every entry or addition, the service checks the actual symbol and the projected total position size. It skips orders that would exceed the bracket limit and records why.

The strategy trades USDT-margined futures in One-Way Mode. A shared mark-price WebSocket subscribes only to symbols held by the strategy. When the stop-loss threshold is reached, the service verifies the actual position and submits a reduce-only market order. Periodic checks continue if the WebSocket stream is interrupted. Local stop losses require the service to be running, and slippage can push the actual loss past the trigger value. The first time the lead trader closes any part of the corresponding position, the strategy exits its entire copied quantity.

By default, the strategy skips a signal if a manual position placed through the workbench already exists in the same direction. If you select **Copy as an Addition**, it follows the new signal only when fill records verify that the entire existing position was opened manually through the workbench. The strategy calculates its stop loss using its own filled quantity and average entry price and submits reduce-only orders for its own copied quantity. The combined position shares one leverage setting. Binance settles using the combined average entry price, and the workbench reads realized P&L and fees from the fill confirmations. The strategy skips positions on the opposite side, positions whose source is still being verified, and positions already copied from another portfolio.

An active strategy keeps running on the Node.js service after you close the browser. After a service restart, reconnect the same account in its original environment so the strategy can resume processing new signals, following closures, and executing local stop losses. **Pause New Entries** leaves stop losses and copied exits active for existing positions and continues reconciling submitted orders. To change portfolios or strategy settings, pause first and wait until all copied positions are closed and pending orders are reconciled.

The **P&L** ledger covers only automated copy trades, manual futures trades, and spot buys placed through the workbench. The SQLite file is `.trade-data/orders.sqlite`. The service reconciles actual fills by account, environment, market, symbol, and order identifier, then totals realized P&L and fees by asset. Spot buy amounts are recorded as cost, and unrealized P&L is shown separately. Existing copy trading history remains available. The order identifiers used to prevent duplicate manual orders in earlier versions contain too little information to reconstruct those fills and costs. Other exchange fills and account positions are fetched from Binance on demand and shown separately. If a current position cannot be matched to workbench fills, its unrealized P&L is marked as pending verification. Check funding fees separately in your Binance transaction history.

## Connecting a Binance account

1. Select **Testnet** or **Live** in the upper-right corner, then click **Connect Account**. Enter the Binance **HMAC API Key and API Secret** for that environment. Testnet is selected on first launch. For local access, you can use localhost or 127.0.0.1 directly. Use HTTPS when accessing the workbench over a network.
2. Click **Verify and Connect Account**. The service sends signed, read-only requests to Binance to verify the UID and accessible markets. Once connected, check the UID and markets displayed in the app. Placing orders requires the relevant spot or futures trading permissions.
3. Reconnect after refreshing the page or when your session expires to access the ledger and strategies. If you replace an API key within the same environment, Binance must verify that it belongs to the same account for you to access the same records. Live trading, Futures Demo Trading, and Spot Testnet have separate UID verification and ledgers. **Disconnect Account** ends the current session. Active copy trading strategies continue in the background. Click **Pause New Entries** before disconnecting if you want to stop following new entries.

The connection dialog first checks whether the backend supports in-memory credentials and UID verification. If it reports an incompatible backend version, restart the Node.js service with the updated code and click **Retry** to display the credential fields.

The environment switch updates market data, account information, and P&L immediately in the current tab. Connect each environment separately. When you switch back within the same tab, you can continue using a valid session. Active strategies continue in their original environments when you switch views or disconnect. Confirm the selected environment each time you place an order or start a strategy.

If you upgraded from a version that used key-based workspaces, connect once with the original, still-valid key so the service can verify the UID associated with your historical records. Revoked keys can no longer be verified by Binance. For accounts accessed through an older fixed token, the service also needs to verify the UID associated with the underlying key. Older API clients that omit the environment use `BINANCE_FUTURES_ENV`, which defaults to `testnet`.

API keys and secrets entered through the workbench are held only in memory. The browser clears the input fields after a successful connection. The session credential held in page memory lasts up to 12 hours. The service keeps each verified market's credentials in memory after you disconnect, until you replace them or the service process exits. After a service restart, reconnect the Binance accounts whose strategies need to run in each environment.

SQLite persists account UIDs, strategies, orders, and P&L records. Upgrading clears encrypted credentials stored by earlier versions from the current database. Database backups and decrypted files created before upgrading retain their original contents.

## Market data and order placement

| Feature | Binance API and behavior |
| --- | --- |
| Futures market data | `/fapi/v2/ticker/price` returns the latest trade price, and `/fapi/v1/premiumIndex` returns the mark price. The page uses WebSocket updates and fetches HTTP snapshots on first load or when the stream is interrupted. |
| Futures positions and balances | `/fapi/v3/positionRisk` returns nonzero positions and unrealized P&L. `/fapi/v3/account` returns wallet and available balances. |
| Futures leverage and orders | `GET /fapi/v1/leverageBracket` returns the account's notional brackets and maximum leverage for the contract. The current position determines the applicable bracket. `/fapi/v1/symbolConfig` returns the configured leverage. The service sets leverage with `POST /fapi/v1/leverage`, then submits the order with `POST /fapi/v1/order`. |
| Spot market data and balances | `/api/v3/ticker/price` returns a price snapshot, and the page receives the latest price by WebSocket. `/api/v3/account` returns available and locked balances. |
| Spot buys | `POST /api/v3/order` uses `MARKET BUY` with `quoteOrderQty` to place an order for the entered USDT amount. |

When you open a position manually, the workbench reads the current position mode from your Binance futures account. For a market entry, specify the margin in USDT or select a percentage of your available balance. Click **Preview Long Entry** or **Preview Short Entry** and check the account, environment, and quantity before confirming. In One-Way Mode, a fill on the opposite side first reduces the existing position in that contract. Any excess opens a position on the opposite side.

To close a position manually, go to **Futures Account → Current Positions**. Click **Close** at the end of the relevant row to close the full position, choose a percentage, or enter a contract quantity. Once confirmed, the workbench submits a market order to close the selected amount. In Hedge Mode, you can manage long and short positions independently.

Each confirmation uses a unique client order ID, which the service records in SQLite before forwarding the order. If the request times out, select **Look Up Original Order** to reconcile it. The Binance response shows the status, filled quantity, and average fill price.

## Build, deployment, and maintenance

```sh
npm test
npm run build
npm start
```

`src/components/` contains the interfaces for lookups, positions, market data, and order placement. `src/usePortfolioHistory.ts` manages polling and pagination for public fills. `src/pnl.ts` defines how P&L is calculated. `src/futures.ts` is the browser-side trading API client. `worker/futures.js` and `worker/spot.js` handle their respective markets, and `worker/trading.js` handles identity, request signing, and duplicate order prevention.

Run `npm start` from the project root to serve the app at `http://127.0.0.1:3000` by default. Use `HOST` and `PORT` to change the bind address and port. For shared access over a network, put the service behind an HTTPS reverse proxy. Store `.trade-data/` on persistent storage so strategies, order reconciliation records, and the P&L ledger survive restarts. The production server and the Vite development server share `server/api.js`.

Binance references are available for [USDⓈ-M Futures](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info), [Spot trading endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints), and [copy trading portfolio metrics](https://www.binance.com/en/support/faq/detail/54aa6d3b43bc4f6eb4a3a6e3aea40acd).
