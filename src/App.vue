<script setup lang="ts">
import { computed, defineAsyncComponent, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  ArrowRight,
  Calendar,
  Connection,
  DataAnalysis,
  Document,
  Histogram,
  Money,
  SwitchButton,
  TrendCharts,
  User,
} from '@element-plus/icons-vue'
import { bindAccount, FuturesError, getBindingEnvironment, revokeSession, tradingEnvironment,
  setUnauthorizedHandler, type BoundSession, type CopyConfig } from './futures'
import { loadWatchlist, saveWatchlist, type LeadPortfolio } from './portfolios'
import { fetchMonitoredPortfolios, saveMonitoredPortfolios, shanghaiDate } from './trades'
import { restorePreviousPending } from './components/pendingOrder'
import PortfolioMonitor from './components/PortfolioMonitor.vue'
import CopyPnl from './components/CopyPnl.vue'
import TradingDesk from './components/TradingDesk.vue'
import WatchlistEditor from './components/WatchlistEditor.vue'
import WorkspaceDialog from './components/WorkspaceDialog.vue'

const UserGuide = defineAsyncComponent(() => import('./components/UserGuide.vue'))
const nav = [
  { id: 'monitor', name: '带单监控', icon: DataAnalysis },
  { id: 'futures', name: '合约交易', icon: TrendCharts },
  { id: 'spot', name: '现货买入', icon: Money },
  { id: 'pnl', name: '盈亏情况', icon: Histogram },
  { id: 'guide', name: '操作文档', icon: Document },
] as const
type Section = (typeof nav)[number]['id']
const active = ref<Section>('monitor')
watch(active, () => {
  document.documentElement.scrollTop = 0
})
const symbols = ref({ futures: 'BTCUSDT', spot: 'BTCUSDT' })
const futuresTab = ref<'copy' | 'manual'>('copy')
const copyDraft = ref<CopyConfig | null>(null)
watch(active, section => {
  if (section !== 'futures') futuresTab.value = 'copy'
})
function openQuote(symbol: string) {
  symbols.value.futures = symbol
  futuresTab.value = 'manual'
  active.value = 'futures'
}
const activeName = computed(() => nav.find((item) => item.id === active.value)?.name)
const binding = shallowRef<{ session: BoundSession; token: string }>()
const session = computed(() => binding.value?.session ?? null)
const token = computed(() => binding.value?.token ?? '')
const connectionRevision = ref(0)
const accountNotice = ref('')
const marketLabel = computed(() => session.value?.markets.map(market => market === 'futures' ? '合约' : '现货').join('、'))
const scope = computed(() => session.value ? 'live:owner:' + session.value.id : 'guest')
watch(scope, (_, previous) => {
  if (previous !== 'guest') copyDraft.value = null
})
const entries = ref<LeadPortfolio[]>([])
const revision = ref(0)
const editorOpen = ref(false)
const addingPortfolio = ref(false)
const savingPortfolios = ref(false)
const watchlistError = ref('')
function openEditor(add = false) {
  addingPortfolio.value = add
  watchlistError.value = ''
  editorOpen.value = true
}
const storageNotice = ref('')
watch(
  [scope, () => session.value?.previousWorkspaceId],
  async (_, __, onCleanup) => {
    const local = loadWatchlist(scope.value, session.value?.previousWorkspaceId)
    entries.value = local
    editorOpen.value = false
    storageNotice.value = ''
    const current = new AbortController()
    const previousRevision = revision.value
    onCleanup(() => current.abort())
    try {
      const ids = await fetchMonitoredPortfolios(token.value, current.signal)
      if (!ids || current.signal.aborted || revision.value !== previousRevision) return
      if (ids.length === local.length && ids.every((id, index) => id === local[index].id)) return
      const names = new Map(local.map(({ id, name }) => [id, name]))
      entries.value = ids.map(id => ({ id, name: names.get(id) ?? '' }))
      revision.value++
    } catch {
      // The browser's list remains available when the service cannot be reached.
    }
  },
  { immediate: true },
)
async function save(entriesToSave: LeadPortfolio[]) {
  if (savingPortfolios.value) return
  const owner = scope.value
  savingPortfolios.value = true
  watchlistError.value = ''
  try {
    await saveMonitoredPortfolios(entriesToSave.map(entry => entry.id), token.value || undefined)
    const saved = saveWatchlist(owner, entriesToSave)
    if (scope.value !== owner) return
    entries.value = entriesToSave
    storageNotice.value = saved ? '' : '后台监控已更新，浏览器无法保存组合列表。'
    revision.value++
    editorOpen.value = false
  } catch (cause) {
    if (scope.value === owner) watchlistError.value = cause instanceof Error ? cause.message : '保存后台监控组合失败。'
  } finally {
    savingPortfolios.value = false
  }
}

const connecting = ref(false)
const loginOpen = ref(false)
const apiKey = ref('')
const apiSecret = ref('')
const secureOrigin = window.isSecureContext
const serviceEnvironment = ref<BoundSession['environment'] | null>(null)
const environmentError = ref('')
const localProduction = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname) && window.location.port === '3000'
const environmentRetry = ref(0)
const loginError = ref('')
let bindAttempt = 0

watch([loginOpen, environmentRetry], async ([open], _, onCleanup) => {
  serviceEnvironment.value = null
  environmentError.value = ''
  if (!open || !secureOrigin) return
  const current = new AbortController()
  onCleanup(() => current.abort())
  try {
    const verified = await getBindingEnvironment(current.signal)
    if (current.signal.aborted) return
    serviceEnvironment.value = verified
  } catch (error) {
    if (!current.signal.aborted) environmentError.value = error instanceof FuturesError && error.code === 'INCOMPATIBLE_BINDING'
      ? error.message : '暂时无法确认实盘连接，请检查交易服务。'
  }
})

function closeLogin() {
  bindAttempt++
  connecting.value = false
  loginOpen.value = false
  apiKey.value = ''
  apiSecret.value = ''
  loginError.value = ''
}

async function retire(oldToken: string) {
  if (!oldToken) return
  try {
    await revokeSession(oldToken)
  } catch {
    accountNotice.value = '服务端暂未确认旧会话注销。该会话到期后会自动失效。'
  }
}

async function connect() {
  if (connecting.value || !secureOrigin || serviceEnvironment.value !== tradingEnvironment || !apiKey.value.trim() || !apiSecret.value.trim()) return
  const attempt = ++bindAttempt
  connecting.value = true
  loginError.value = ''
  try {
    const connected = await bindAccount({ environment: serviceEnvironment.value, apiKey: apiKey.value.trim(), apiSecret: apiSecret.value.trim() })
    if (attempt !== bindAttempt) {
      // The dialog may close while the server issues a session. Revoke the returned token.
      void retire(connected.token)
      return
    }
    const oldToken = token.value
    const { token: newToken, ...identity } = connected
    restorePreviousPending(identity)
    binding.value = { session: identity, token: newToken }
    connectionRevision.value++
    accountNotice.value = ''
    closeLogin()
    if (oldToken !== newToken) void retire(oldToken)
  } catch (cause) {
    if (attempt === bindAttempt) loginError.value = cause instanceof Error ? cause.message : '连接账户失败。'
  } finally {
    if (attempt === bindAttempt) connecting.value = false
  }
}
function disconnect() {
  const oldToken = token.value
  closeLogin()
  binding.value = undefined
  accountNotice.value = ''
  void retire(oldToken)
}
function expireSession(expired: string) {
  if (!expired || token.value !== expired) return
  binding.value = undefined
  accountNotice.value = '交易会话已失效，请重新连接账户。'
}
setUnauthorizedHandler(expireSession)
watch(binding, (connected, _, onCleanup) => {
  if (!connected) return
  let timer: number
  const checkExpiry = () => {
    window.clearTimeout(timer)
    const remaining = connected.session.expiresAt - Date.now()
    if (remaining <= 0) expireSession(connected.token)
    else timer = window.setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647))
  }
  checkExpiry()
  document.addEventListener('visibilitychange', checkExpiry)
  onCleanup(() => {
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', checkExpiry)
  })
})
onUnmounted(() => {
  bindAttempt++
  setUnauthorizedHandler()
  void retire(token.value)
})
const today = shanghaiDate(Date.now())
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <b></b>
          <b></b>
          <b></b>
        </span>
        <span class="brand-name">
          <b>Trade</b>
          <span class="brand-light">Desk</span>
        </span>
      </div>
      <nav class="app-nav" aria-label="工作台导航">
        <button
          v-for="item in nav"
          :key="item.id"
          :class="{ selected: active === item.id }"
          :aria-current="active === item.id ? 'page' : undefined"
          @click="active = item.id"
        >
          <component :is="item.icon" />
          <span>{{ item.name }}</span>
        </button>
      </nav>
      <div class="identity">
        <span class="identity-avatar"><User /></span>
        <div>
          <strong>{{ session ? 'UID ' + session.uid : '访客工作区' }}</strong>
          <small>
            {{
              session ? '实盘 · 已验证' + marketLabel : '公开数据'
            }}
          </small>
        </div>
        <button
          v-if="session"
          class="sidebar-icon"
          aria-label="断开账户"
          title="断开账户"
          @click="disconnect"
        >
          <SwitchButton />
        </button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumb">
          <span>交易工作台</span>
          <ArrowRight />
          <strong>{{ activeName }}</strong>
        </div>
        <div class="topbar-tools">
          <span class="today">
            <Calendar />
            {{ today.replaceAll('-', '.') }}
          </span>
          <button class="btn account-button" type="button" @click="loginOpen = true">
            <component :is="session ? User : Connection" aria-hidden="true" />
            {{ session ? '切换账户' : '连接账户' }}
          </button>
        </div>
      </header>
      <main class="main-content">
        <p v-if="storageNotice" class="notice warning" role="status">{{ storageNotice }}</p>
        <p v-if="accountNotice" class="notice warning" role="status">{{ accountNotice }}</p>
        <p v-if="session" class="mobile-account-status" role="status">UID {{ session.uid }} · 实盘 · 已验证{{ marketLabel }}访问</p>
        <p v-if="session && (active === 'futures' || active === 'spot') && !session.markets.includes(active)" class="notice warning" role="status">
          当前密钥已验证{{ marketLabel }}访问。如需{{ active === 'futures' ? '合约' : '现货' }}交易，请切换到可访问该市场的密钥。
        </p>
        <div v-show="active === 'monitor'">
          <PortfolioMonitor
            :key="scope + ':' + revision"
            :entries="entries"
            :visible="active === 'monitor'"
            @edit="openEditor()"
            @quote="openQuote"
          />
        </div>
        <TradingDesk
          v-if="active === 'futures' || active === 'spot'"
          :key="[scope, connectionRevision, active].join(':')"
          v-model:symbol="symbols[active === 'spot' ? 'spot' : 'futures']"
          v-model:futures-tab="futuresTab"
          v-model:copy-draft="copyDraft"
          :entries="entries"
          :market="active"
          :environment="tradingEnvironment"
          :session="session"
          :token="token"
          @connect="loginOpen = true"
          @edit="openEditor(true)"
        />
        <CopyPnl v-if="active === 'pnl'" :key="[scope, connectionRevision].join(':')"
          :session="session" :token="token" :entries="entries" @connect="loginOpen = true" />
        <UserGuide v-if="active === 'guide'" />
      </main>
    </div>
    <WatchlistEditor
      v-if="editorOpen"
      :portfolios="entries"
      :adding="addingPortfolio"
      :saving="savingPortfolios"
      :save-error="watchlistError"
      @close="editorOpen = false"
      @save="save"
    />
    <WorkspaceDialog
      v-if="loginOpen"
      :title="session ? '切换交易账户' : '连接交易账户'"
      @close="closeLogin"
    >
      <p v-if="serviceEnvironment" class="dialog-description">
        服务向币安验证账户 UID 和市场权限。API Key 和 Secret 仅在内存中使用，服务重启后需重新连接。更换密钥后仍可查看同一 UID 的交易记录。
      </p>
      <div v-if="session" class="current-identity">
        <span>当前账户 · UID {{ session.uid }}<small class="verified-markets">实盘 · 已验证{{ marketLabel }}访问</small></span>
        <button class="text-button" @click="disconnect">断开账户</button>
      </div>
      <p v-if="!secureOrigin" class="notice error" role="alert">请在 HTTPS 或本机 localhost 地址打开工作台后再绑定密钥。</p>
      <p v-else-if="environmentError" class="notice error" role="alert">
        {{ environmentError }}
        <a v-if="localProduction" class="text-button" href="http://127.0.0.1:5173/">打开本机开发版（5173）</a>
        <button type="button" class="text-button" @click="environmentRetry++">重试</button>
      </p>
      <p v-else-if="!serviceEnvironment" class="ticket-hint" role="status">正在确认实盘连接和密钥保存方式…</p>
      <form v-else class="binding-form" autocomplete="off" @submit.prevent="connect">
        <div class="binding-environment">
          <TrendCharts aria-hidden="true" />
          <span>当前交易环境 <strong>实盘</strong></span>
          <small>真实资金</small>
        </div>
        <label class="field"><span>币安 API Key</span>
          <input v-model="apiKey" type="password" required autocomplete="off" spellcheck="false" autocapitalize="none"
            :disabled="connecting" placeholder="输入实盘 API Key" />
        </label>
        <label class="field"><span>币安 API Secret</span>
          <input v-model="apiSecret" type="password" required autocomplete="off" spellcheck="false" autocapitalize="none"
            :disabled="connecting" placeholder="输入与 API Key 配对的 Secret" />
        </label>
        <p v-if="loginError" class="notice error" role="alert">{{ loginError }}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="closeLogin">取消</button>
          <button type="submit" class="btn primary" :disabled="connecting || !apiKey.trim() || !apiSecret.trim()">
            {{ connecting ? '正在验证…' : '验证并绑定账户' }}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  </div>
</template>

<style scoped>
.binding-form { display: grid; gap: 12px; }
.binding-form .dialog-actions { margin-top: 4px; }
.binding-environment { display: flex; align-items: center; gap: 9px; color: #87521a; background: #fff4e4; border: 1px solid #efdbbb; border-radius: 8px; padding: 11px 13px; font-size: 12px; }
.binding-environment > svg { width: 17px; height: 17px; }
.binding-environment strong { margin-left: 4px; font-size: 14px; }
.binding-environment small { margin-left: auto; font-size: 12px; }
.verified-markets { display: block; color: var(--muted); margin-top: 4px; }
.mobile-account-status { display: none; }
@media (max-width: 820px) {
  .mobile-account-status { display: block; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
}
</style>
