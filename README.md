# 币安交易工作台

Vue 3 + TypeScript 工作台，首页跟踪公开带单组合，合约和现货页使用当前登录用户的币安账户。Node.js 服务在本机或自有服务器上提供页面、读取行情，并向币安签名下单。

## 启动

使用 Node.js 22.21+（22.x）或 24.5+。

```sh
npm ci
npm run dev
```

打开 Vite 打印的本地地址。访客可查看公开带单记录和币安实盘行情。连接账户后，报价和订单使用该账户配置的同一环境。

公开带单查询、账户查询和下单由服务端发出。Windows 上，服务会自动使用当前用户为币安配置的系统代理。开发、预览和生产服务都支持在项目根目录的 `.env.local` 或进程环境中指定 `HTTPS_PROXY`（也可用 `HTTP_PROXY`）及 `NO_PROXY`。显式指定的代理优先。修改代理设置后重启服务即可生效。

## 查看带单员的盈亏

- **成交明细**按组合查询最近 30 天内的公开订单，默认范围为最近 7 天。币安返回的 `totalPnl` 用于显示已成交平多、平空订单的金额。正值为盈利，负值为亏损，明确返回的零为持平，未披露显示为缺失。汇总仅覆盖已加载且已披露的平仓成交，按币种分别计算。
- **已平仓位**读取币安公开仓位历史中的 `closingPnl`。一笔仓位可以分多次平仓，因此逐笔成交和整仓结果各自展示。列表支持按组合查看并翻页。
- **账户持仓**展示币安按标记价格返回的未实现盈亏。合约页的试算器按方向、开仓价、标记价和数量估算线性合约的价格盈亏，不含手续费和资金费。

组合支持输入币安详情链接或数字 ID，并可设备注。关注列表保存在当前浏览器，访客和不同账户使用独立列表。成交时间为北京时间。打开工作台即开始监控，浏览器按顺序轮询各组合，每次请求后至少等待 5 秒，并尊重服务端限流。关闭页面即停止轮询。

## 跟单交易与盈亏
菜单「操作文档」提供组合 ID、连接账户、交易规则及盈亏记录的图文说明。「合约交易 → 跟单交易」可添加公开组合，按每次 USDT 名义金额跟随新成交。每个账户及环境独立保存策略，支持只跟首笔、固定金额有限加仓、同时持仓数量上限和每仓 USDT 浮亏止损。预览并确认后由服务端运行。「暂停新开仓」会保留已有跟单仓位的退出管理。

策略使用单向持仓的 USDT 合约。共享标记价格 WebSocket 只订阅策略持有的交易对。达到止损线时，服务端复核实际持仓后发起仅减仓市价单。周期检查在推送中断时继续工作。服务中断期间无法执行本地止损，成交滑点可能使实际损失超过触发值。带单员首次平掉对应方向的部分或全部仓位时，本策略退出自己跟入的全部数量。

「盈亏情况」按账户和环境记录本平台跟单订单。服务端用交易所订单号核对逐笔成交，按币种汇总已实现盈亏和成交手续费，待核对的订单单独标记。资金费未计入该净额，持仓浮盈亏单独显示。SQLite 将跟单状态、跟单成交及订单防重记录写入同一文件 `.trade-data/orders.sqlite`。

## 配置交易账户

管理员可在 Git 忽略的 `.env.local` 或服务进程的环境中配置以下变量。两个变量都仅在服务端读取。

| 服务端变量 | 用途 |
| --- | --- |
| `BINANCE_FUTURES_ENV` | 默认 `testnet`。显式设为 `live` 后，合约和现货都连接实盘。两个市场的密钥须与所选环境匹配。 |
| `BINANCE_FUTURES_USERS` | JSON 数组。每项为一个用户，包含固定的 `id`、显示用的 `name`、独立且随机的访问 `token`，以及已开通市场的密钥对。 |

本地配置结构示例，替换引号中的占位内容后重启服务。

```dotenv
BINANCE_FUTURES_ENV=testnet
BINANCE_FUTURES_USERS='[{"id":"desk-a","name":"交易员 A","token":"<独立随机工作区令牌>","apiKey":"<合约 API Key>","apiSecret":"<合约 Secret>","spotApiKey":"<现货 API Key>","spotApiSecret":"<现货 Secret>"}]'
```

每个用户单独配置 `token`。可以只配置合约密钥或只配置现货密钥。同一交易密钥只能归属一个用户。用户点击「连接账户」后，仅输入分配给自己的工作区令牌。服务端按令牌选择账户、签名并发送请求。交易所密钥留在服务端，浏览器内的访问令牌在刷新或断开后清除。

## 行情与下单

| 功能 | 币安接口与口径 |
| --- | --- |
| 合约行情 | `/fapi/v2/ticker/price` 读取最新成交价，`/fapi/v1/premiumIndex` 读取标记价。页面优先使用 WebSocket 推送，首屏和推送中断时以 HTTP 获取快照。 |
| 合约持仓、余额 | `/fapi/v3/positionRisk` 读取当前有数量的仓位和未实现盈亏，`/fapi/v3/account` 读取钱包及可用余额。 |
| 合约下单 | `POST /fapi/v1/order` 支持 USDT 合约市价和 GTC 限价单。持仓方向须匹配账户的单向或双向持仓模式。 |
| 现货行情、余额 | `/api/v3/ticker/price` 获取价格快照，页面通过 WebSocket 接收最新价，`/api/v3/account` 读取可用和冻结余额。 |
| 现货买入 | `POST /api/v3/order` 使用 `MARKET BUY` 和 `quoteOrderQty`，按输入的 USDT 金额下单。 |

先预览订单，再按页面显示的账户和环境确认。每次确认使用独立客户订单号，SQLite 在转发前登记该编号。响应超时后可用「查询原订单」对账，币安回执会显示状态、实际成交量和成交均价。

## 构建、部署与维护

```sh
npm test
npm run build
npm start
```

`src/components/` 存放查询、持仓、行情和下单界面。`src/usePortfolioHistory.ts` 管理公开成交的轮询和分页。`src/pnl.ts` 定义盈亏口径。`src/futures.ts` 是浏览器侧交易 API 客户端。`worker/futures.js` 和 `worker/spot.js` 处理对应市场，`worker/trading.js` 统一处理用户身份、签名及订单防重。

从项目根目录运行 `npm start`。Node 服务默认只监听本机，控制台打印访问地址。`HOST` 和 `PORT` 可以更改监听地址和端口。多人通过网络使用时，在服务前配置 HTTPS 反向代理。将 `.trade-data/` 放在持久化磁盘上，以便重启后继续校验已登记的订单号。生产服务与 Vite 开发服务共用 `server/api.js`。

币安接口参考见 [合约 API](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)、[现货交易 API](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints) 和[跟单组合指标](https://www.binance.com/en/support/faq/detail/54aa6d3b43bc4f6eb4a3a6e3aea40acd)。
