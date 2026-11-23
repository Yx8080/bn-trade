# Binance Copy Trading History

View filled opening and closing orders from multiple public Binance lead portfolios in one table. Built with Vue 3, Vite, and Element Plus.

## Getting started

Requires Node.js 22.21 or later in the 22.x series, or Node.js 24.5 or later.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The page starts with the public portfolio IDs for Aoying Capital and Btc Xingchen. Edit the list directly, entering one Binance lead portfolio URL or ID per line. The default range is the last seven days in Beijing time. You can select dates within the last 30 days available on Binance.

Run a query to merge trades from the selected portfolios and sort them by most recent update. Use the button below the table to load older trades from portfolios with another page. Each row shows the trader's Binance nickname or the portfolio ID when the nickname is unavailable.

```sh
npm run build
npm run preview
```

The Vite development and preview servers proxy requests to the Binance website. If you use an HTTP proxy, Node.js honors the `HTTPS_PROXY` and `NO_PROXY` environment variables. If you host `dist` separately, provide proxy routes at `/api/binance/latest-records` and `/api/binance/portfolio-detail`.

## Sites deployment

`npm run build:sites` generates the Sites Worker entry point at `dist/server/index.js`. The Worker serves the Vue app and proxies trade and nickname lookups on the same site. The browser polls while the page is open.

## Monitoring

Start monitoring to poll portfolios in the order entered and refresh the first page of each portfolio's trades from the last seven days. The browser waits five seconds after each portfolio before querying the next. With three portfolios, each refresh cycle takes about 15 seconds plus request time.

During temporary service or network errors, the app keeps the last results for the affected portfolio and continues polling at the same interval. It honors `Retry-After` and pauses polling if Binance denies access or returns a rate limit without a retry time. Stop monitoring or close the page to end polling.

## Data coverage

Trades and nicknames come from `lead-portfolio/order-history` and `lead-portfolio/detail`, the endpoints used by Binance's lead portfolio pages. Binance determines the available records and how the date filter is applied.

The app shows hedge-mode orders with a nonzero filled quantity. `LONG` + `BUY` opens or adds to a long position, and `SHORT` + `SELL` opens or adds to a short position. `LONG` + `SELL` reduces or closes a long position, and `SHORT` + `BUY` reduces or closes a short position. One-way mode records marked `BOTH` lack the fields needed to classify them as opening or closing trades.

The table shows order update times in Beijing time (UTC+8). Request duration runs from the browser sending the trade query to finishing response parsing. When a trade appears depends on when Binance publishes it and when the browser polls next.
