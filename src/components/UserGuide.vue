<script setup lang="ts">
import { detailUrl } from '../trades'

const exampleId = '5075281354358777856'
const sections = [
  ['portfolios', '添加组合与查看成交'], ['account', '连接交易账户'],
  ['strategy', '设置与启动跟单'], ['manage', '暂停、止损与异常'],
  ['manual', '手动开仓与平仓'], ['spot', '现货市价买入'], ['pnl', '核对盈亏与成交'],
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
        <p>访客和各账户的组合 ID 分别保存到服务端，备注名称保留在当前浏览器。单个组合只需采集一份公开成交，关注该组合的工作区共用这份本地记录。旧版本只保存在浏览器的自定义组合，可在「管理组合」重新保存，加入后台监控。</p>
        <p>服务开始监控一个组合时，最多同步最近 24 小时的公开成交到 SQLite，之后只要服务运行就会持续采集。「开仓监控」展示开仓和平仓成交，默认看最近 24 小时。日期查询和「加载更早成交」均读取已归档的记录，时间按北京时间显示。</p>
        <p>「已披露平仓盈亏」按结算币种汇总已加载、已披露盈亏的平仓成交。「已平仓位」按组合、交易对和方向归集本地成交，开平数量相等时生成一条记录，开仓均价和平仓均价按成交数量加权。若其中一笔平仓未披露盈亏，整条仓位记录显示「披露不全」。公开成交数据没有独立的手续费字段。</p>
      </section>
      <section id="guide-account" class="panel guide-section">
        <h2>连接交易账户</h2>
        <p>查看公开带单记录可使用访客工作区。要跟单、手动下单或核对自己的盈亏，请在本机地址或 HTTPS 页面连接币安账户。</p>
        <ol>
          <li>在右上角点击「连接账户」，使用币安实盘密钥。</li>
          <li>填写自己的币安实盘 <strong>HMAC API Key</strong> 和配对的 <strong>API Secret</strong>，点击「验证并绑定账户」。即使只交易合约，密钥也需要能读取现货账户，服务用它核实 UID，并单独验证合约访问。连接后请核对 UID 和已验证市场。下单还需对应市场的交易权限。</li>
          <li>要更换密钥，点击「切换账户」。同一环境、同一币安账户的交易记录和策略随 UID 保留。升级前建立的工作区，请先用当时仍有效的密钥连接一次，以便核实旧记录归属。</li>
          <li>API Key 和 Secret 仅在服务内存中使用。页面会话最长 12 小时。刷新页面、会话到期或服务重启后，请重新连接。</li>
        </ol>
        <p>「断开账户」注销当前页面会话。服务进程仍在内存中持有密钥，已启动的跟单可继续执行。更换对应市场的密钥或退出服务进程后，原凭据会被释放。</p>
      </section>
      <section id="guide-strategy" class="panel guide-section">
        <h2>设置与启动跟单</h2>
        <ol>
          <li>打开「合约交易」→「跟单交易」，在「跟单对象」中勾选想跟的带单员。只勾一位即可指定跟单一人，也可以勾选多人。使用「添加组合」可补充详情链接或组合 ID。</li>
          <li>选择「定额跟单」或「定比跟单」，填写每笔保证金金额或总权益比例，再设置单仓止损金额。</li>
          <li>展开「高级设置」。杠杆默认选「默认最高档」，按交易对和预计总仓位选取最高可用杠杆。「自定义档位」按交易对的最高杠杆匹配目标倍数，空白或未列出的档位使用最高可用杠杆。下单前，系统按实际可用杠杆核算数量，并检查 USDT 可用保证金。连接后可点「查询档位」核对上限。</li>
          <li>在「跟单开仓方式」中选「首笔」，每个跟单仓位只开一次。选「自动加仓」可继续跟随同一带单员后续的同向开仓，设置开仓次数时计入首笔。「同时持仓上限」按交易对计数，所有已选组合共用。</li>
          <li>点击「预览跟单设置」，核对已选名单、杠杆、金额和止损。开通合约访问并使用单向持仓模式后，点击「确认启动实盘跟单」。启动后可在「执行状态」查看每个仓位所属的组合。</li>
        </ol>
        <div class="guide-example"><strong>两种模式怎样计算</strong>
          <p>固定保证金为 <strong>10 USDT</strong>、杠杆为 <strong>10 倍</strong> 时，每笔目标合约价值约为 <strong>100 USDT</strong>。</p>
          <p>总权益为 <strong>1,000 USDT</strong>、比例为 <strong>2%</strong> 时，每笔目标保证金为 <strong>20 USDT</strong>。按 10 倍杠杆计算，目标合约价值约为 200 USDT。定比跟单每次开仓或加仓都会重新读取总权益，其中包含未实现盈亏。下单数量受交易步长、成交价和最低下单要求影响。</p>
        </div>
        <p>策略从启动后新披露的成交开始跟随。多人交易同一合约时，由先跟入的组合管理该交易对，持仓期间跳过其他组合在该交易对的信号。所属带单员首次减仓或平仓时，策略按自己的已跟数量整仓退出。</p>
        <p>「已有仓位时」默认为「跳过」。选择「自动加仓」后，系统可对本平台手动开的同向仓位加仓。例如你通过工作台手动做空 0.10 ETH，跟单随后卖出 0.03 ETH，合约账户会显示合计 0.13 ETH 空仓。跟单的止损按新增的 0.03 ETH 及其成交均价计算，跟随平仓也只买回这 0.03 ETH。反向仓位和来源待核实的仓位会跳过。</p>
      </section>
      <section id="guide-manage" class="panel guide-section">
        <h2>暂停、止损与异常</h2>
        <dl class="guide-terms">
          <div><dt>暂停新开仓</dt><dd>在「跟单交易」点击「暂停新开仓」。已经开始提交的订单会继续核对，服务端继续管理已有跟单仓位的止损和平仓。持仓或订单仍待核实时，只能按原设置恢复。更换组合或调整参数前，先暂停并等待仓位与待核实订单全部结清。</dd></div>
          <div><dt>单仓止损</dt><dd>服务端通过标记价推送和周期检查监测浮亏。达到设置的 USDT 金额后，服务端复核实际仓位，再提交仅减仓市价单。止损在服务端执行。滑点、跳价、服务停止或连接故障可能使实际亏损超过设定值。</dd></div>
          <div><dt>离开页面或服务中断</dt><dd>关闭浏览器后，已启动的跟单继续由服务端执行。服务重启后，请重新连接同一实盘账户并核对执行状态。重新连接前，策略无法下单、跟随平仓或执行本地止损。恢复后策略核对已有仓位和可查的平仓信号，跳过中断期间的旧开仓。若提示历史窗口缺失，请到币安核对实际仓位。</dd></div>
          <div><dt>订单待核实</dt><dd>请求超时或回执不确定时，服务端保存原客户订单号并据此查询。可在「执行状态」查看订单号，并与币安合约订单核对。待核实期间，策略等待该订单结果再继续下单。</dd></div>
          <div><dt>手动调整同一交易对</dt><dd>策略会核对方向、数量及开仓均价。如果跟单仓位与账户实仓不匹配，策略会记录异常并停止接管该仓位。可在「合约账户 → 当前持仓」或币安管理剩余仓位。</dd></div>
        </dl>
      </section>
      <section id="guide-manual" class="panel guide-section">
        <h2>手动开仓与平仓</h2>
        <p>打开「合约交易」→「手动交易」，或从带单成交表点击 USDT 合约交易对。连接账户后，面板会自动读取币安当前的持仓模式。选择限价单时，可手动填写委托价格，也可点「最新价」填入当前行情价。未全部成交的限价单会持续有效，直至成交或取消（GTC）。</p>
        <p>市价开仓使用固定保证金。可直接输入 USDT 金额，也可拖动滑杆以可用余额的比例填入金额。限价开仓可选固定保证金、按总权益百分比或合约数量。</p>
        <p>点击杠杆按钮可展开滑块和倍数输入框。留空时沿用当前倍数，调整杠杆会影响同一合约的已有仓位。点击「预览开多」或「预览开空」检查保证金和数量，再确认下单。单向模式下，反向成交先减少现有净仓，超出的数量形成反向仓位。</p>
        <p>在下方「合约账户」的「当前持仓」中点击目标仓位行的「平仓」。默认选中整仓，也可按持仓比例或输入合约数量部分平仓。确认后，服务会复核仓位再提交市价单。双向模式下可分别平多仓和空仓。点击「查看成交」可以核对该合约近期成交及可识别的订单来源。</p>
        <p>点「合约下单」标题旁的「盈亏试算」，选择多空方向，填写开仓价、目标平仓价、保证金和杠杆。试算按目标价整仓退出，未计手续费、资金费和强平。实际持仓的未实现盈亏可在「合约账户」查看。</p>
        <p>订单状态待核实时，点「查询原订单」核对提交结果。</p>
      </section>
      <section id="guide-spot" class="panel guide-section">
        <h2>现货市价买入</h2>
        <p>打开「现货买入」，选择 USDT 交易对，输入要花的 USDT 金额。点击「预览订单」，核对交易对、金额和参考价后，点「确认实盘下单」。实际买到的数量取决于撮合价格。成交后可在「现货账户」查看余额，在「盈亏情况」查看平台成交和买入估值。</p>
      </section>
      <section id="guide-pnl" class="panel guide-section">
        <h2>核对盈亏与成交</h2>
        <p>连接账户后打开「盈亏情况」。平台账本记录工作台发起的跟单、手动合约和现货买入，按币安实际成交核对。「交易所账户参考」可查看币安账户持仓、余额和指定交易对的其他近期成交。</p>
        <ul>
          <li><strong>平台已实现盈亏</strong>按币种汇总，净额等于该币种的已实现盈亏减去成交手续费。使用 BNB 支付的手续费单列。资金费可在币安资金流水核对。</li>
          <li><strong>平台成交记录</strong>可按「合约跟单」或「手动合约与现货」查看。「待结算」表示订单或成交明细仍在核对中，汇总会随已核实的成交更新。</li>
          <li><strong>合约持仓未实现盈亏</strong>按可核实的跟单份额和平台手动持仓估算，来源无法确认时显示待核实。「平台现货买入估值」按平台买入成本、净数量和当前价格估算，外部买卖或充提可能改变实际持有数量和成本。</li>
        </ul>
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
.guide-section p + p, .guide-example + p, .guide-section ul, .guide-section ol, .guide-example { margin-top: 12px; }
.guide-section ol, .guide-section ul { padding-left: 1.6em; margin-bottom: 0; }
.guide-section li + li { margin-top: 7px; }
.guide-section a { color: var(--green); overflow-wrap: anywhere; }
.guide-section code { background: #f0f4f1; padding: 2px 4px; border-radius: 3px; font-size: 0.94em; overflow-wrap: anywhere; }
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
