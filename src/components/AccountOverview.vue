<script setup lang="ts">
import { ref } from 'vue'
import { Lock, Refresh, Wallet } from '@element-plus/icons-vue'
import type { getSpotAccount, FuturesAccount, FuturesSession } from '../futures'
import { formatNumber, formatTradeTime } from '../trades'

const props = defineProps<{
  market: 'spot' | 'futures'
  session: FuturesSession | null
  account?: FuturesAccount
  spotAccount?: Awaited<ReturnType<typeof getSpotAccount>>
  loading: boolean
  error: string
  fetchedAt: number
}>()
const emit = defineEmits<{ connect: []; refresh: [] }>()
const tab = ref<'positions' | 'balances'>(props.market === 'futures' ? 'positions' : 'balances')
</script>

<template>
  <section class="panel account-card" :aria-busy="loading">
    <div class="ledger-heading">
      <div class="section-title">
        <div class="title-icon"><Wallet /></div>
        <h2>{{ market === 'futures' ? '合约账户' : '现货账户' }}</h2>
      </div>
      <button v-if="session" class="btn small" :disabled="loading" @click="emit('refresh')">
        <Refresh />
        {{ loading ? '更新中…' : '刷新账户' }}
      </button>
    </div>
    <div v-if="!session" class="empty-state">
      <span class="empty-icon"><Lock /></span>
      <strong>连接账户以查看{{ market === 'futures' ? '持仓与余额' : '现货余额' }}</strong>
      <button class="text-button" @click="emit('connect')">连接账户</button>
    </div>
    <template v-else>
      <div v-if="market === 'futures'" class="account-tabs">
        <button :class="{ active: tab === 'positions' }" :aria-pressed="tab === 'positions'" @click="tab = 'positions'">
          当前持仓
        </button>
        <button :class="{ active: tab === 'balances' }" :aria-pressed="tab === 'balances'" @click="tab = 'balances'">账户余额</button>
      </div>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <div v-else-if="tab === 'positions'" class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>合约</th>
              <th>持仓方向</th>
              <th class="numeric">数量</th>
              <th class="numeric">开仓均价</th>
              <th class="numeric">标记价格</th>
              <th class="numeric">未实现盈亏</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="position in account?.positions"
              :key="position.symbol + position.positionSide"
            >
              <td>
                <strong>{{ position.symbol }}</strong>
              </td>
              <td>
                {{
                  position.positionSide === 'LONG' ||
                  (position.positionSide === 'BOTH' && Number(position.quantity) > 0)
                    ? '多仓'
                    : '空仓'
                }}
              </td>
              <td class="numeric">{{ formatNumber(Math.abs(Number(position.quantity))) }}</td>
              <td class="numeric">{{ formatNumber(Number(position.entryPrice)) }}</td>
              <td class="numeric">{{ formatNumber(Number(position.markPrice)) }}</td>
              <td
                class="numeric pnl-cell"
                :class="{
                  gain: Number(position.unrealizedPnl) > 0,
                  loss: Number(position.unrealizedPnl) < 0,
                }"
              >
                {{ formatNumber(Number(position.unrealizedPnl)) }}
                <small>{{ position.marginAsset }}</small>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!account?.positions.length" class="blank-row">
          {{ loading ? '正在读取持仓…' : '暂无 U 本位合约持仓' }}
        </p>
      </div>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>资产</th>
              <th class="numeric">{{ market === 'spot' ? '可用余额' : '钱包余额' }}</th>
              <th class="numeric">{{ market === 'spot' ? '冻结金额' : '可用余额' }}</th>
            </tr>
          </thead>
          <tbody v-if="market === 'spot'">
            <tr v-for="balance in spotAccount?.balances" :key="balance.asset">
              <td>
                <strong>{{ balance.asset }}</strong>
              </td>
              <td class="numeric">{{ balance.free }}</td>
              <td class="numeric">{{ balance.locked }}</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="balance in account?.balances" :key="balance.asset">
              <td>
                <strong>{{ balance.asset }}</strong>
              </td>
              <td class="numeric">{{ balance.walletBalance }}</td>
              <td class="numeric">{{ balance.availableBalance }}</td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="!(market === 'spot' ? spotAccount?.balances.length : account?.balances.length)"
          class="blank-row"
        >
          {{ loading ? '正在读取余额…' : '暂无资产余额' }}
        </p>
      </div>
      <div v-if="fetchedAt" class="ledger-footer">
        最近读取 {{ formatTradeTime(fetchedAt) }} UTC+8
      </div>
    </template>
  </section>
</template>
