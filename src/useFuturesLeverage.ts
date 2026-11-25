import { ref, watch } from 'vue'
import { isAppLeverage } from '../shared/leverage.js'
import { getFuturesLeverage, type FuturesSession, type SymbolLeverage } from './futures'

export function useFuturesLeverage(symbol: () => string, session: () => FuturesSession | null, token: () => string) {
  const info = ref<SymbolLeverage>()
  const error = ref('')
  const loading = ref(false)
  const revision = ref(0)
  watch([symbol, session, token, revision], async ([pair, identity, credential], _, cleanup) => {
    info.value = undefined
    error.value = ''
    loading.value = Boolean(pair && identity && credential)
    if (!pair || !identity || !credential) return
    const controller = new AbortController()
    cleanup(() => controller.abort())
    try {
      const data = await getFuturesLeverage(credential, pair, controller.signal)
      if (controller.signal.aborted) return
      if (data.symbol !== pair || data.environment !== identity.environment || !isAppLeverage(data.symbolMaxLeverage)
        || !(data.maxLeverage === null || isAppLeverage(data.maxLeverage, data.symbolMaxLeverage))
        || !(data.leverage === null || isAppLeverage(data.leverage)) || !Array.isArray(data.brackets)) {
        throw Error('杠杆档位数据无效。')
      }
      info.value = data
      if (data.maxLeverage == null || data.leverage == null) error.value = '部分账户杠杆或持仓档位暂时无法核实。'
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '暂时无法读取币安杠杆档位。'
    } finally {
      if (!controller.signal.aborted) loading.value = false
    }
  }, { immediate: true })
  return { info, error, loading, refresh: () => { revision.value++ } }
}
