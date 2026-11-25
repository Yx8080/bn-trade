<script setup lang="ts">
import portfoliosImage from '../assets/guide/portfolios.png'
import connectImage from '../assets/guide/connect.png'
import strategyImage from '../assets/guide/strategy.png'
import { detailUrl } from '../trades'

const exampleId = '5075281354358777856'
const sections = [
  ['portfolios', '添加组合与查看成交'], ['account', '连接交易账户'],
  ['strategy', '设置与启动跟单'], ['manage', '暂停、止损与异常'],
  ['pnl', '核对平台盈亏'], ['manual', '手动开仓与平仓'],
]
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
        <p>保持「带单监控」页面可见，工作台会把从现在开始观察到的新成交写入本地 SQLite。首次监控前、无人查看或断线期间错过的成交会留空。返回监控页后从当前时刻继续记录。</p>
        <p>「查询」和「加载更早成交」只读取本地记录，可按北京时间的日期和带单组合筛选。「已披露平仓盈亏」只汇总已加载且披露了盈亏的平仓成交。</p>
        <p>只有实时监控到对应的平仓成交，「已平仓位」才会补录缺少的仓位或披露字段。已有数值会保留，包括零盈亏。翻页只读取本地 SQLite。</p>
      </section>
      <section id="guide-account" class="panel guide-section">
        <h2>连接交易账户</h2>
        <p>查看公开带单记录可使用访客工作区。要跟单、手动下单或核对自己的盈亏，请在本机地址或 HTTPS 页面连接币安账户。</p>
        <ol>
          <li>在右上角选「测试网」或「实盘」，再点击旁边的「连接账户」。核对弹窗显示的环境，填写该环境的币安密钥。</li>
          <li>填写自己的<strong>币安 API Key</strong> 和配对的 <strong>API Secret</strong>，点击「验证并绑定账户」。连接后请核对币安返回的 UID、环境和已验证市场。下单还需开通对应市场的交易权限。</li>
          <li>要更换密钥，点击「切换账户」。同一环境、同一币安账户的交易记录和策略随 UID 保留。升级前建立的工作区，请先用当时仍有效的密钥连接一次，以便核实旧记录归属。</li>
          <li>API Key 和 Secret 仅在服务内存中使用。刷新页面、会话到期或服务重启后，需重新连接。币安合约模拟盘和现货测试网各自识别 UID，分别保存记录。</li>
        </ol>
        <figure><img :src="connectImage" width="510" height="400" alt="连接交易账户弹窗显示测试网、模拟资金、币安 API Key 和 API Secret 输入框。" loading="lazy" />
          <figcaption>「断开账户」注销当前页面会话。服务进程仍在内存中持有密钥，已启动的跟单可继续执行。更换对应市场的密钥或退出服务进程后，原凭据会被释放。</figcaption>
        </figure>
      </section>
      <section id="guide-strategy" class="panel guide-section">
        <h2>设置与启动跟单</h2>
        <ol>
          <li>打开「合约交易」→「跟单交易」，在「跟单对象」中勾选想跟的带单员。只勾一位即可指定跟单一人，也可以勾选多人。使用「添加组合」可补充详情链接或组合 ID。</li>
          <li>选择「固定保证金」或「按总权益百分比」，通过滑块或数字框设置跟单杠杆。在「查询交易对的最高杠杆」中输入 USDT 合约并点击「查询档位」，即可核对该合约最高杠杆、当前持仓档位和预计开仓后的上限。策略会按每次信号的实际交易对核对档位，设置超限时会跳过该笔开仓。</li>
          <li>选择「只跟首笔」后，单仓最多开仓次数会显示为 1。选择「按相同规则加仓」后可填写包含首笔在内的总次数。再设定所有已选组合共用的同时持仓上限和每个仓位的止损金额。跟单账户需使用单向持仓模式。</li>
          <li>点击「预览跟单设置」，核对已选名单、杠杆、金额和预计初始保证金。连接账户并确认环境后，点击「确认启动测试网跟单」或「确认启动实盘跟单」。启动后可在「执行状态」查看每个仓位所属的组合。</li>
        </ol>
        <figure><img :src="strategyImage" width="590" height="936" alt="跟单设置示例，已选两位带单员，每笔 10 USDT 保证金、10 倍杠杆，并显示 BTCUSDT 的模拟杠杆档位。" loading="lazy" />
          <figcaption>图中使用模拟测试网数据。两位带单员共用两个交易对的持仓上限，实际杠杆档位以当前账户查询结果为准。</figcaption>
        </figure>
        <div class="guide-example"><strong>两种模式怎样计算</strong>
          <p>固定保证金为 <strong>10 USDT</strong>、杠杆为 <strong>10 倍</strong> 时，每笔目标合约价值约为 <strong>100 USDT</strong>。</p>
          <p>总权益为 <strong>1,000 USDT</strong>、比例为 <strong>2%</strong> 时，每笔目标保证金为 <strong>20 USDT</strong>。选择 10 倍杠杆，目标合约价值约为 200 USDT。每次跟单加仓都会重新读取合约账户总权益，其中包含未实现盈亏。下单数量受交易步长、成交价和最低下单要求影响。</p>
        </div>
        <p>策略从启动后新披露的成交开始跟随。多人交易同一合约时，由先跟入的组合管理该交易对，持仓期间跳过其他组合在该交易对的信号。所属带单员首次减仓或平仓时，策略按自己的已跟数量整仓退出。</p>
        <p>「已有平台手动同向仓位时」默认跳过。选择「跟随加仓」后，例如你通过工作台手动做空 0.10 ETH，跟单随后卖出 0.03 ETH，合约账户会显示合计 0.13 ETH 空仓。跟单的止损按新增的 0.03 ETH 及其成交均价计算，跟随平仓也只买回这 0.03 ETH。反向仓位和来源待核实的仓位会跳过。</p>
      </section>
      <section id="guide-manage" class="panel guide-section">
        <h2>暂停、止损与异常</h2>
        <dl class="guide-terms">
          <div><dt>暂停新开仓</dt><dd>在「跟单交易」点击「暂停新开仓」。已经开始提交的订单会继续核对，服务端继续管理已有跟单仓位的止损和平仓。持仓或订单仍待核实时，只能按原设置恢复。更换组合或调整参数前，先暂停并等待仓位与待核实订单全部结清。</dd></div>
          <div><dt>5 USDT 单仓止损</dt><dd>服务端订阅已有跟单仓位的标记价推送，触线后复核账户仓位。周期检查也会检查浮亏，达到 5 USDT 时提交仅减仓市价单。币安端没有因此预挂保护单。滑点、跳价、服务停止或连接故障可能使实际亏损超过 5 USDT。</dd></div>
          <div><dt>离开页面或服务中断</dt><dd>关闭浏览器后，已启动的跟单继续由服务端执行。服务重启后，请在原环境重新连接同一账户并核对执行状态。重新连接前，策略无法下单、跟随平仓或执行本地止损。恢复后策略核对已有仓位和可查的平仓信号，跳过中断期间的旧开仓。若提示历史窗口缺失，请到币安核对实际仓位。</dd></div>
          <div><dt>订单待核实</dt><dd>请求超时或回执不确定时，服务端保存原客户订单号并据此查询。可在「执行状态」查看订单号，并与币安合约订单核对。待核实期间，策略等待该订单结果再继续下单。</dd></div>
          <div><dt>手动调整同一交易对</dt><dd>策略会核对方向、数量及开仓均价。如果跟单仓位与账户实仓不匹配，策略会记录异常并停止接管该仓位。可在「合约账户 → 当前持仓」或币安管理剩余仓位。</dd></div>
        </dl>
      </section>
      <section id="guide-pnl" class="panel guide-section">
        <h2>核对平台盈亏</h2>
        <p>连接账户后点击「盈亏情况」，核对账户与环境。SQLite 账本记录从工作台发起的跟单、手动合约和现货买入，按交易所实际成交核对。直接在币安下的单可以在交易所成交列表查看，其金额和费用排除在平台汇总之外。</p>
        <ul>
          <li><strong>平台已实现盈亏</strong>按币种分别汇总。每种币的净额等于该币已实现盈亏减去该币成交手续费。资金费请在币安资金流水中另行核对。使用 BNB 支付手续费时，会单列 BNB 金额。</li>
          <li><strong>待结算</strong>表示订单或其成交明细仍在核对中。平台按已核实的成交与手续费更新汇总。</li>
          <li><strong>持仓未实现盈亏</strong>与已实现盈亏分开显示。现货买入金额计入成本，系统按能够匹配的平台持仓估值。外部买卖或转账导致仓位归属不清时，页面会提示待核对。</li>
        </ul>
      </section>
      <section id="guide-manual" class="panel guide-section">
        <h2>手动开仓与平仓</h2>
        <p>交易区下方的「合约账户」汇总持仓和余额。在持仓行点「查看成交」可核对这份合约的订单来源。跟单成交显示带单组合，交易所其他成交可能来自币安客户端或其他 API 工具。</p>
        <p>打开「合约交易」→「手动交易」，或从带单成交表点击 USDT 合约交易对。连接账户后，面板会自动读取币安当前的持仓模式。选择限价单时，可手动填写委托价格，也可点「最新价」填入当前行情价。未全部成交的限价单会持续有效，直至成交或取消（GTC）。</p>
        <p>市价开仓使用固定保证金。可直接输入 USDT 金额，或拖动滑杆按可用余额的比例填写。限价开仓还可选择按总权益百分比或合约数量下单。</p>
        <p>点击杠杆按钮，可展开滑块和倍数输入框。留空时沿用当前倍数，调整杠杆会影响同一合约的已有仓位。点击「预览开多」或「预览开空」检查保证金和数量，确认后提交。</p>
        <p>单向模式按净仓位成交。持有多仓时选择「预览开空」，成交会先抵减现有多仓，超出部分才形成空仓。持空仓时开多同理。</p>
        <p>平仓时，在下方「合约账户」的「当前持仓」中找到目标多仓或空仓，点击该行的「平仓」。默认选中整仓，也可按持仓比例或输入合约数量部分平仓。确认交易对、方向和数量后，系统会提交市价平仓单。</p>
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
.guide-section p + p, .guide-section ul, .guide-section ol, .guide-section figure, .guide-example { margin-top: 12px; }
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
.guide-terms { display: grid; gap: 12px; }
.guide-terms dt { font-weight: 630; }
.guide-terms dd { margin-top: 2px; }
@media (max-width: 930px) {
  .guide-layout { grid-template-columns: 1fr; gap: 12px; }
  .guide-nav { position: static; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .guide-nav h2 { grid-column: 1 / -1; }
}
</style>
