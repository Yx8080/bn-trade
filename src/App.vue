<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
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
import { getSession, type CopyConfig, type FuturesSession } from './futures'
import { loadWatchlist, saveWatchlist, type LeadPortfolio } from './portfolios'
import { shanghaiDate } from './trades'
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
const futuresSymbol = ref('BTCUSDT')
const futuresTab = ref<'copy' | 'manual'>('copy')
const copyDraft = ref<CopyConfig | null>(null)
watch(active, section => {
  if (section !== 'futures') futuresTab.value = 'copy'
})
function openQuote(symbol: string) {
  futuresSymbol.value = symbol
  futuresTab.value = 'manual'
  active.value = 'futures'
}
const activeName = computed(() => nav.find((item) => item.id === active.value)?.name)
const session = ref<FuturesSession | null>(null)
const token = ref('')
const scope = computed(() => (session.value ? 'user:' + session.value.id : 'guest'))
watch([scope, () => session.value?.environment], (_, [oldScope]) => {
  if (oldScope !== 'guest') copyDraft.value = null
})
const entries = ref<LeadPortfolio[]>([])
const revision = ref(0)
const editorOpen = ref(false)
const addingPortfolio = ref(false)
function openEditor(add = false) {
  addingPortfolio.value = add
  editorOpen.value = true
}
const storageNotice = ref('')
watch(
  scope,
  () => {
    entries.value = loadWatchlist(scope.value)
    editorOpen.value = false
    storageNotice.value = ''
  },
  { immediate: true },
)
function save(entriesToSave: LeadPortfolio[]) {
  entries.value = entriesToSave
  storageNotice.value = saveWatchlist(scope.value, entriesToSave)
    ? ''
    : '浏览器存储不可用，本次会话已应用组合列表。'
  revision.value++
  editorOpen.value = false
}

const connecting = ref(false)
const loginOpen = ref(false)
const tokenInput = ref('')
const loginError = ref('')
let loginController: AbortController | undefined
function closeLogin() {
  loginController?.abort()
  loginController = undefined
  connecting.value = false
  loginOpen.value = false
  tokenInput.value = ''
  loginError.value = ''
}
async function connect() {
  if (connecting.value || !tokenInput.value.trim()) return
  const credential = tokenInput.value.trim()
  const controller = new AbortController()
  loginController = controller
  connecting.value = true
  loginError.value = ''
  try {
    const identity = await getSession(credential, controller.signal)
    if (controller.signal.aborted) return
    token.value = credential
    session.value = identity
    closeLogin()
  } catch (cause) {
    if (!controller.signal.aborted)
      loginError.value = cause instanceof Error ? cause.message : '连接账户失败。'
  } finally {
    if (loginController === controller) connecting.value = false
  }
}
function disconnect() {
  closeLogin()
  token.value = ''
  session.value = null
}
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
          <strong>{{ session?.name || '访客工作区' }}</strong>
          <small>
            {{
              session ? (session.environment === 'live' ? '实盘账户' : '测试网账户') : '公开数据'
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
          <button class="btn account-button" @click="loginOpen = true">
            <Connection />
            {{ session ? '切换账户' : '连接账户' }}
          </button>
        </div>
      </header>
      <main class="main-content">
        <p v-if="storageNotice" class="notice warning" role="status">{{ storageNotice }}</p>
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
          :key="[scope, session?.environment, active].join(':')"
          :initial-symbol="active === 'futures' ? futuresSymbol : 'BTCUSDT'"
          v-model:futures-tab="futuresTab"
          v-model:copy-draft="copyDraft"
          :entries="entries"
          :market="active"
          :session="session"
          :token="token"
          @connect="loginOpen = true"
          @edit="openEditor(true)"
        />
        <CopyPnl v-if="active === 'pnl'" :key="scope + ':' + session?.environment"
          :session="session" :token="token" :entries="entries" @connect="loginOpen = true" />
        <UserGuide v-if="active === 'guide'" />
      </main>
    </div>
    <WatchlistEditor
      v-if="editorOpen"
      :portfolios="entries"
      :adding="addingPortfolio"
      @close="editorOpen = false"
      @save="save"
    />
    <WorkspaceDialog
      v-if="loginOpen"
      :title="session ? '切换交易账户' : '连接交易账户'"
      @close="closeLogin"
    >
      <p class="dialog-description">
        使用管理员分配的工作区访问令牌连接个人交易账户。令牌仅在本次页面会话中使用。
      </p>
      <div v-if="session" class="current-identity">
        <span>当前账户 · {{ session.name }}</span>
        <button class="text-button" @click="disconnect">断开账户</button>
      </div>
      <form @submit.prevent="connect">
        <label class="field">
          <span>工作区访问令牌</span>
          <input
            v-model="tokenInput"
            type="password"
            required
            autocomplete="off"
            spellcheck="false"
            placeholder="输入访问令牌"
            :disabled="connecting"
          />
        </label>
        <p v-if="loginError" class="notice error" role="alert">{{ loginError }}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="closeLogin">取消</button>
          <button type="submit" class="btn primary" :disabled="connecting || !tokenInput.trim()">
            {{ connecting ? '正在验证…' : '连接账户' }}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  </div>
</template>
