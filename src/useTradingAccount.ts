import { computed, ref, shallowRef, watch } from 'vue'
import { getAccount, getSpotAccount, type FuturesAccount, type FuturesSession } from './futures'
import { availableUsdt, type OpeningFunds } from './opening-funds'

export function useTradingAccount(market: () => 'spot' | 'futures', session: () => FuturesSession | null, token: () => string) {
  const account = shallowRef<FuturesAccount>()
  const spotAccount = shallowRef<Awaited<ReturnType<typeof getSpotAccount>>>()
  const fetchedAt = ref(0)
  const loading = ref(false)
  const error = ref('')
  let pending: AbortController | undefined

  function clearSnapshot() {
    account.value = undefined
    spotAccount.value = undefined
    fetchedAt.value = 0
  }
  async function refreshAccount() {
    const environment = session()?.environment
    if (!environment || !token()) return
    pending?.abort()
    const request = new AbortController()
    pending = request
    loading.value = true
    error.value = ''
    try {
      const result = market() === 'futures' ? await getAccount(token(), request.signal) : await getSpotAccount(token(), request.signal)
      if (request.signal.aborted) return
      if (result.environment !== environment) throw Error('返回账户的交易环境与当前选择不一致，请重新读取。')
      if ('positions' in result) account.value = result
      else spotAccount.value = result
      fetchedAt.value = Date.now()
    } catch (cause) {
      if (request.signal.aborted) return
      clearSnapshot()
      error.value = cause instanceof Error ? cause.message : '账户查询失败。'
    } finally {
      if (!request.signal.aborted) loading.value = false
    }
  }
  watch([market, session, token], (_, __, cleanup) => {
    clearSnapshot()
    loading.value = false
    error.value = ''
    if (!session() || !token()) return
    void refreshAccount()
    // Copy fills may arrive without any action in this tab.
    const refreshIfDue = () => {
      if (!document.hidden && !loading.value && !error.value && Date.now() - fetchedAt.value >= 60_000) void refreshAccount()
    }
    let timer: number | undefined
    if (market() === 'futures') {
      timer = window.setInterval(refreshIfDue, 60_000)
      document.addEventListener('visibilitychange', refreshIfDue)
    }
    cleanup(() => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshIfDue)
      pending?.abort()
    })
  }, { immediate: true, flush: 'sync' })

  const funds = computed<OpeningFunds>(() => {
    const available = account.value ? availableUsdt(account.value.balances) : null
    const state = !session() ? 'disconnected'
      : loading.value ? 'loading' : available == null ? 'error' : 'ready'
    return { state, available, updatedAt: fetchedAt.value }
  })
  return { account, spotAccount, fetchedAt, loading, error, funds, refreshAccount }
}
