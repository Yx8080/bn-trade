<script setup lang="ts">
import portfoliosImage from '../assets/guide/portfolios.png'
import connectImage from '../assets/guide/connect.png'
import strategyImage from '../assets/guide/strategy.png'
import { detailUrl } from '../trades'

const exampleId = '5075281354358777856'
const sections = [
  ['portfolios', '添加组合与查看成交'], ['account', '连接交易账户'],
  ['strategy', '设置与启动跟单'], ['manage', '暂停、止损与异常'],
  ['pnl', '核对跟单盈亏'], ['manual', '手动交易与仅减仓'],
]
const envExample = [
  'BINANCE_FUTURES_ENV=testnet',
  "BINANCE_FUTURES_USERS='[{\"id\":\"desk-a\",\"name\":\"我的测试账户\",\"token\":\"<随机工作区令牌>\",\"apiKey\":\"<测试网合约API Key>\",\"apiSecret\":\"<测试网合约Secret>\"}]'",
].join('\n')
</script>

<template>
  <header class="page-heading"><div><h1>操作文档</h1><p>从查看带单员的公开成交，到运行自己的合约跟单策略。</p></div></header>
  <div class="guide-layout">
    <nav class="panel guide-nav" aria-label="操作文档目录">
      <h2>目录</h2>
      <a v-for="([id, title], index) in sections" :key="id" :href="'#guide-' + id"><span>{{ index + 1 }}</span>{{ title }}</a>
    </nav>
    <article class="guide-content">
      <section id="guide-portfolios" class="panel guide-section">
        <h2>添加组合与查看成交</h2>
        <ol>
          <li>在币安打开「跟单交易」，进入<strong>合约跟单</strong>并选择一位带单员，打开其公开组合详情。</li>
          <li>从浏览器地址栏或分享链接中找到 <code>/copy-trading/lead-details/</code> 后面的一串数字。它标识一个带单组合。账户中心显示的用户 UID 用于识别账户，无法代替这个组合 ID。</li>
          <li>进入工作台的「带单监控」→「管理组合」→「添加组合」。在「组合 ID 或带单链接」粘贴完整详情网址或数字，填写可选的备注，点击「保存组合」。也可以逐行粘贴多个组合。</li>
        </ol>
        <div class="guide-example">
          <strong>以熬鹰资本为例</strong>
          <a :href="detailUrl(exampleId)" target="_blank" rel="noopener noreferrer">{{ detailUrl(exampleId) }}</a>
          <p>组合 ID 为 <code>{{ exampleId }}</code>。复制数字时保留所有位数。</p>
        </div>
        <figure><img :src="portfoliosImage" width="510" height="384" alt="管理带单组合弹窗，两行对应组合 ID 和备注，底部有添加组合与保存组合按钮。" loading="lazy" />
          <figcaption>组合列表可以保留多位带单员。访客与每个账户各有独立的浏览器关注列表。</figcaption>
        </figure>
        <p>打开工作台后，浏览器自动轮询已添加组合，页面需要保持打开。成交明细默认显示最近 7 天，可在最近 30 天内选择起止日期并点击「查询」。用「带单组合」筛选记录，下方「已平仓位」可以按组合翻页。时间均按北京时间显示。</p>
        <p>「已披露平仓盈亏」只汇总已加载且带单员公开了盈亏的平仓成交。查询失败时页面会提示原因，等数据恢复后再判断该时段有无成交。</p>
      </section>
      <section id="guide-account" class="panel guide-section">
        <h2>连接交易账户</h2>
        <p>查看公开带单记录可直接使用访客工作区。要在自己的合约账户启动跟单，请向这台服务的管理员取得<strong>工作区访问令牌</strong>。点击右上角「连接账户」，粘贴令牌并提交，核对页面显示的账户名称和「测试网」或「实盘」标识。</p>
        <figure><img :src="connectImage" width="510" height="276" alt="连接交易账户弹窗，包含工作区访问令牌输入框和连接账户按钮。" loading="lazy" />
          <figcaption>此处填写管理员分配的工作区访问令牌。币安 API Key 和 Secret 由管理员保存在服务端。</figcaption>
        </figure>
        <details class="admin-setup"><summary>我是管理员，如何配置账户？</summary>
          <p>在项目根目录的 <code>.env.local</code> 中加入以下配置，把尖括号里的占位符替换为自己的值。为不同用户分配独立令牌和密钥。生产服务也可以用进程环境变量配置。</p>
          <pre><code>{{ envExample }}</code></pre>
          <ol>
            <li>测试使用 <code>testnet</code> 及对应环境的合约密钥。实盘使用 <code>live</code> 及实盘密钥，确认后会向真实账户下单。密钥需能读取对应账户并执行所需交易。</li>
            <li>在对应环境的币安合约持仓模式中选择「单向持仓」。策略使用 USDT 结算合约，同一交易对留给跟单策略独立管理。</li>
            <li>修改配置后重启服务。开发使用 <code>npm run dev</code>，生产构建使用 <code>npm run build</code> 后执行 <code>npm start</code>。向用户分发其工作区令牌，刷新页面或断开账户后需要重新连接。</li>
          </ol>
        </details>
      </section>
      <section id="guide-strategy" class="panel guide-section">
        <h2>设置与启动跟单</h2>
        <ol>
          <li>打开「合约交易」→「跟单交易」，从「带单组合」中选择目标。下拉框旁的「添加组合」可直接新增详情链接或组合 ID 并保存。</li>
          <li>填写每次名义金额、重复开仓方式、单仓开仓次数、同时持仓数和单仓止损。访客可以先调整和预览。每个账户环境同一时间可运行一个带单组合。</li>
          <li>点击「预览跟单设置」。连接账户后再次核对组合、账户、环境和金额，点击「确认启动测试网跟单」或「确认启动实盘跟单」。确认完成后，「执行状态」会显示跟单状态、持仓与执行记录。</li>
        </ol>
        <figure><img :src="strategyImage" width="574" height="633" alt="跟单设置表单示例，每次名义金额 100 USDT，固定金额加仓，每仓最多两次，同时最多两个交易对，单仓止损 5 USDT。" loading="lazy" />
          <figcaption>设置页显示草稿，点击预览后还需要确认启动。</figcaption>
        </figure>
        <div class="guide-example"><strong>100 USDT 如何计算</strong>
          <p>「只跟首笔」会跳过持有该仓位期间的同向加仓。「按固定金额加仓」下，单仓最多 2 次即首笔 100 USDT，再加一次 100 USDT。同时持仓上限为 2 个交易对时，两仓都加满约为 <strong>100 × 2 × 2 = 400 USDT</strong> 的累计开仓名义金额。</p>
          <p>实际占用保证金取决于账户杠杆。市价成交价格、交易数量步长、合约最低下单要求会影响成交数量或使某笔无法执行。仓位市值会随市场变化。</p>
        </div>
        <p>策略从启动后新披露的成交开始跟随。带单员在同一方向首次减仓或平仓时，策略按自己的已跟数量整仓退出，即使带单员只平了一部分。</p>
      </section>
      <section id="guide-manage" class="panel guide-section">
        <h2>暂停、止损与异常</h2>
        <dl class="guide-terms">
          <div><dt>暂停新开仓</dt><dd>在「跟单交易」点击「暂停新开仓」。已经开始提交的订单会继续核对，服务端继续管理已有跟单仓位的止损和平仓。持仓或订单仍待核实时，只能按原设置恢复。更换组合或调整参数前，先暂停并等待仓位与待核实订单全部结清。</dd></div>
          <div><dt>5 USDT 单仓止损</dt><dd>服务端订阅已有跟单仓位的标记价推送，触线后复核账户仓位。周期检查也会检查浮亏，达到 5 USDT 时提交仅减仓市价单。币安端没有因此预挂保护单。滑点、跳价、服务停止或连接故障可能使实际亏损超过 5 USDT。</dd></div>
          <div><dt>离开页面或服务中断</dt><dd>跟单策略在服务端运行，关闭浏览器或退出工作区后仍按原设置执行。服务进程需要持续在线并可连通币安。恢复后策略核对已有仓位和可查的平仓信号，跳过中断期间的旧开仓。若提示历史窗口缺失，请到币安核对实际仓位。</dd></div>
          <div><dt>订单待核实</dt><dd>请求超时或回执不确定时，服务端保存原客户订单号并据此查询。可在「执行状态」查看订单号，并与币安合约订单核对。待核实期间，策略等待该订单结果再继续下单。</dd></div>
          <div><dt>手动调整同一交易对</dt><dd>策略会核对方向、数量及开仓均价。如果跟单仓位与账户实仓不匹配，策略会记录异常并停止接管该仓位。此时请在币安检查并管理剩余仓位。</dd></div>
        </dl>
      </section>
      <section id="guide-pnl" class="panel guide-section">
        <h2>核对跟单盈亏</h2>
        <p>连接账户后点击「盈亏情况」，核对账户与环境。这里记录本平台跟单策略发出的实际开仓、加仓和平仓成交。「刷新盈亏」读取最新账本，可翻页按时间、订单号、交易对及带单组合核对。</p>
        <ul>
          <li><strong>已结算跟单盈亏</strong>按币种分别汇总。每种币的净额等于该币已实现盈亏减去该币成交手续费。资金费请在币安资金流水中另行核对。使用 BNB 支付手续费时，会单列 BNB 金额。</li>
          <li><strong>待结算</strong>表示成交已记录，交易所的成交明细尚待核对。该记录结算后才进入汇总。</li>
          <li><strong>持仓未实现盈亏</strong>按最近一次成功核对的跟单持仓标记估值显示。页面注明估值时间，缺少可靠估值时显示等待状态。</li>
        </ul>
      </section>
      <section id="guide-manual" class="panel guide-section">
        <h2>手动交易与仅减仓</h2>
        <p>打开「合约交易」→「手动交易」，或从带单成交表点击 USDT 合约交易对。选择买卖方向、订单类型、持仓模式及数量，点击「预览订单」后核对账户和环境再确认。手动交易请使用策略管理范围以外的交易对。</p>
        <p>例如在<strong>单向持仓</strong>模式下持有 0.02 BTC 多仓，选择「卖出」、填写 0.01 BTC 并勾选「仅减仓」。全部成交后剩余 0.01 BTC 多仓。仅减仓买入用于平空，卖出用于平多，没有对应持仓时无法成交。关闭仅减仓后，多余的成交数量可能开出反向仓位。</p>
      </section>
    </article>
  </div>
</template>

<style scoped>
.guide-layout { display: grid; grid-template-columns: minmax(170px, 210px) minmax(0, 1fr); align-items: start; gap: 18px; }
.guide-nav { padding: 17px 13px; position: sticky; top: 12px; }
.guide-nav h2 { margin: 0 8px 10px; }
.guide-nav a { display: flex; gap: 9px; align-items: baseline; padding: 8px; color: var(--green); text-decoration: none; font-size: 13px; border-radius: 5px; }
.guide-nav a:hover { background: #eff5ef; }
.guide-nav span { font-variant-numeric: tabular-nums; color: var(--muted); }
.guide-content { display: grid; gap: 14px; min-width: 0; }
.guide-section { padding: clamp(16px, 2.3vw, 29px); min-width: 0; scroll-margin-top: 15px; font-size: 14px; line-height: 1.8; }
.guide-section h2 { font-size: 19px; margin-bottom: 12px; }
.guide-section p + p, .guide-section ul, .guide-section ol, .guide-section details, .guide-section figure, .guide-example { margin-top: 12px; }
.guide-section ol, .guide-section ul { padding-left: 1.6em; margin-bottom: 0; }
.guide-section li + li { margin-top: 7px; }
.guide-section a { color: var(--green); overflow-wrap: anywhere; }
.guide-section code { background: #f0f4f1; padding: 2px 4px; border-radius: 3px; font-size: 0.94em; overflow-wrap: anywhere; }
.guide-section figure { margin-inline: 0; margin-bottom: 14px; }
.guide-section img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 9px; }
.guide-section figcaption { color: var(--muted); font-size: 12px; margin-top: 5px; }
.guide-example { padding: 12px 15px; background: #f2f6f0; border-left: 3px solid #7da88c; border-radius: 4px; margin-bottom: 12px; }
.guide-example > strong, .guide-example > a { display: block; }
.guide-example p + p { margin-top: 5px; }
.admin-setup { padding: 10px 13px; border: 1px solid var(--line); border-radius: 7px; }
.admin-setup summary { cursor: pointer; font-weight: 620; color: var(--green); }
.admin-setup[open] summary { margin-bottom: 7px; }
.admin-setup pre { margin: 9px 0; background: #f0f4f1; padding: 10px 12px; border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.admin-setup pre code { padding: 0; }
.guide-terms { display: grid; gap: 12px; }
.guide-terms dt { font-weight: 630; }
.guide-terms dd { margin-top: 2px; }
@media (max-width: 930px) {
  .guide-layout { grid-template-columns: 1fr; gap: 12px; }
  .guide-nav { position: static; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .guide-nav h2 { grid-column: 1 / -1; }
}
</style>
