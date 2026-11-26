import { ref, watch } from 'vue'
import { isAppLeverage } from '../shared/leverage.js'
import { getFuturesLeverage, getPublicFuturesLeverage, type Environment, type FuturesSession, type SymbolLeverage } from './futures'

export function useFuturesLeverage(symbol: () => string, session: () => FuturesSession | null, token: () => string,
  publicEnvironment: () => Environment | undefined = () => undefined) {
  const info = ref<SymbolLeverage>()
  const publicMaxLeverage = ref<number>()
  const error = ref('')
  const loading = ref(false)
  const revision = ref(0)
  watch([symbol, session, token, publicEnvironment, revision], async ([pair, identity, credential, market], _, cleanup) => {
    info.value = undefined
    publicMaxLeverage.value = undefined
    error.value = ''
    loading.value = false
    if (!pair || (identity && (!credential || (market && market !== identity.environment)))) return
    if (!identity && !market) return
    const controller = new AbortController()
    cleanup(() => controller.abort())
    loading.value = true
    try {
      if (!identity && market) {
        const data = await getPublicFuturesLeverage(pair, market, controller.signal)
        if (controller.signal.aborted) return
        if (data.symbol !== pair || data.environment !== market || !isAppLeverage(data.symbolMaxLeverage)) {
          throw Error('杠杆档位数据无效。')
        }
        publicMaxLeverage.value = data.symbolMaxLeverage
        return
      }
      if (!identity) return
      const data = await getFuturesLeverage(credential, pair, controller.signal, identity.environment)
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
  return { info, publicMaxLeverage, error, loading, refresh: () => { revision.value++ } }
}
