<template>
  <div>
    <div v-if="loadError" class="card mb-4" style="border-color: var(--color-danger)">
      <div class="text-danger text-sm">Unable to load machine control: {{ loadError }}</div>
    </div>
    <div class="page-header">
      <h2 class="page-title">🔌 Machine Control</h2>
      <div class="flex gap-2">
        <select v-model="selectedDeviceId" class="form-select" @change="loadTags" style="min-width: 200px">
          <option value="" disabled>-- Select PLC --</option>
          <option v-for="device in devices" :key="device.id" :value="device.id">
            {{ device.name }} ({{ device.ip_address }})
          </option>
        </select>
        <button class="btn btn-secondary" @click="loadData" :disabled="isLoading">
          🔄 Refresh
        </button>
      </div>
    </div>

    <!-- Empty State -->
    <div v-if="!selectedDeviceId" class="card empty-state" style="margin-top: var(--space-6)">
      <span>🔌</span>
      <p>Select a PLC to view details</p>
    </div>

    <div v-else class="grid grid-2" style="gap: var(--space-6)">
      <div class="card" style="grid-column: span 2">
        <div class="card-header">
          <h3 class="card-title">Machine Commands</h3>
          <span class="badge" :class="selectedDeviceLive?.isDemo ? 'badge-warning' : (selectedDeviceOnline ? 'badge-success' : 'badge-danger')">
            {{ selectedDeviceLive?.isDemo ? 'Demo / Simulated' : (selectedDeviceOnline ? 'Real / Online' : 'Real / Offline') }}
          </span>
        </div>
        <div class="grid grid-4 mb-4">
          <div v-for="state in machineStates" :key="state.label" class="p-3 bg-tertiary rounded">
            <div class="text-xs text-muted">{{ state.label }}</div>
            <div class="text-mono font-semibold">{{ state.value }}</div>
            <div v-if="state.note" class="technical-note">{{ state.note }}</div>
          </div>
        </div>
        <div class="flex gap-3 items-end" style="flex-wrap: wrap">
          <button class="btn btn-success" :disabled="isSendingCmd || !isOperator || !activeJob || !commandDeviceAvailable" @click="sendStart">CmdStart</button>
          <button class="btn btn-danger" :disabled="isSendingCmd || !isOperator || !activeJob || !commandDeviceAvailable" @click="sendStop">CmdStop</button>
          <button class="btn btn-warning" :disabled="homeDisabled" :title="homeDisabledReason" @click="sendHome">Home</button>
          <button class="btn btn-secondary" :disabled="isSendingCmd || !isOperator || !activeJob || !commandDeviceAvailable" @click="sendReset">Reset</button>
        </div>
        <p v-if="cmdResult" class="text-xs text-mono mt-3">{{ cmdResult }}</p>
      </div>

      <!-- Tag List -->
      <div class="card" style="grid-column: span 2">
        <div class="card-header">
          <h3 class="card-title">Realtime Tags ({{ tags.length }})</h3>
        </div>

        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Tag Name</th>
                <th>Address</th>
                <th>Description</th>
                <th>Value</th>
                <th>Unit</th>
                <th>Quality</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tag in tags" :key="tag.id">
                <td class="font-medium">{{ tag.tag_name }}</td>
                <td class="text-xs text-mono text-muted">{{ tag.address }}</td>
                <td class="text-sm text-muted">{{ tag.description || '-' }}</td>
                <td>
                  <div class="tag-value text-mono font-semibold" :class="getTagValueClass(tag)">
                    {{ formatTagValue(tag) }}
                  </div>
                </td>
                <td class="text-xs text-muted">{{ tag.unit || '-' }}</td>
                <td>
                  <span class="badge" :class="getQualityBadge(tag)">
                    {{ getTagQuality(tag) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePlcStore } from '@/stores/plc'
import { useAuthStore } from '@/stores/auth'
import api from '@/composables/useApi'

const plcStore = usePlcStore()
const authStore = useAuthStore()

const devices = ref([])
const selectedDeviceId = ref('')
const tags = ref([])
const isLoading = ref(false)
const loadError = ref('')

const isOperator = computed(() => authStore.isOperator)

const isSendingCmd = ref(false)
const cmdResult = ref('')
const activeJob = ref(null)

const selectedDeviceLive = computed(() => {
  const d = devices.value.find(x => x.id === selectedDeviceId.value)
  return d?.liveStatus || { connected: d?.connection_status === 'connected', isDemo: false }
})

const selectedDeviceOnline = computed(() => selectedDeviceLive.value?.connected === true && !selectedDeviceLive.value?.isDemo)
const commandDeviceAvailable = computed(() => selectedDeviceLive.value?.isDemo === true || selectedDeviceOnline.value)

const machineStates = computed(() => {
  const fields = ['MachineState', 'JobLoaded', 'ProductID', 'RecipeID', 'TargetQty', 'MachineReady', 'MachineRunning', 'MoveBusy', 'HaltBusy', 'AxisPositioning', 'MachineFault', 'FaultCode']
  const labels = {
    MachineState: 'Machine State', JobLoaded: 'Job Loaded', ProductID: 'Product ID', RecipeID: 'Recipe ID',
    TargetQty: 'Target Quantity', MachineReady: 'Machine Ready', MachineRunning: 'Machine Running',
    MoveBusy: 'Move Busy', HaltBusy: 'Halt Busy', AxisPositioning: 'Axis Positioning',
    MachineFault: 'Machine Fault', FaultCode: 'Fault Code',
  }
  const notes = {
    MachineState: 'Trạng thái hiện tại của máy', JobLoaded: 'Job đã được nạp vào PLC',
    ProductID: 'ID sản phẩm gửi xuống PLC', RecipeID: 'ID công thức vận hành của sản phẩm',
    TargetQty: 'Số lượng sản phẩm mục tiêu của Job', MachineReady: 'Máy đủ điều kiện để bắt đầu',
    MachineRunning: 'Máy đang trong chu trình chạy', MoveBusy: 'Trục đang thực hiện lệnh di chuyển',
    HaltBusy: 'Trục đang thực hiện lệnh dừng', AxisPositioning: 'Trục đang định vị',
    MachineFault: 'Máy đang có lỗi', FaultCode: 'Mã lỗi hiện tại từ PLC',
  }
  return fields.map(label => {
    const tag = tags.value.find(item => item.tag_name.toLowerCase() === label.toLowerCase())
    return { label: labels[label], note: notes[label], value: tag ? formatTagValue(tag) : '—' }
  })
})

function getSafeBooleanTag(tagName) {
  const tag = tags.value.find(item => item.tag_name.toLowerCase() === tagName.toLowerCase())
  if (!tag) return null
  const live = getTagLiveValue(tag)
  if (String(live.quality || '').toLowerCase() !== 'good') return null
  if (live.value === true || live.value === 1 || live.value === '1' || String(live.value).toLowerCase() === 'true') return true
  if (live.value === false || live.value === 0 || live.value === '0' || String(live.value).toLowerCase() === 'false') return false
  return null
}

const homeSafetyState = computed(() => ({
  machineRunning: getSafeBooleanTag('MachineRunning'),
  moveBusy: getSafeBooleanTag('MoveBusy'),
  haltBusy: getSafeBooleanTag('HaltBusy'),
  axisPositioning: getSafeBooleanTag('AxisPositioning'),
}))

const homeAllowed = computed(() => {
  const state = homeSafetyState.value
  return selectedDeviceOnline.value &&
    state.machineRunning === false &&
    state.moveBusy === false &&
    state.haltBusy === false &&
    state.axisPositioning === false
})

const homeDisabled = computed(() => isSendingCmd.value || !isOperator.value || !homeAllowed.value)
const homeDisabledReason = computed(() => homeAllowed.value
  ? ''
  : 'HOME requires REAL / ONLINE PLC and GOOD status: MachineRunning=false, MoveBusy=false, HaltBusy=false, AxisPositioning=false')

async function sendStart() {
  if (!activeJob.value || !commandDeviceAvailable.value) return
  isSendingCmd.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/start`, { deviceId: selectedDeviceId.value })
    cmdResult.value = `${res.data.data.mode}: ${res.data.data.command} → ${res.data.data.response}`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function sendStop() {
  if (!activeJob.value || !commandDeviceAvailable.value) return
  isSendingCmd.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/stop`, { deviceId: selectedDeviceId.value })
    cmdResult.value = `${res.data.data.mode}: ${res.data.data.command} → ${res.data.data.response}`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function sendHome() {
  if (!homeAllowed.value) return
  isSendingCmd.value = true
  try {
    const res = await api.post(`/plc/devices/${selectedDeviceId.value}/home`)
    const result = res.data.data
    cmdResult.value = `${result.mode}: ${result.command} → ${result.result.toUpperCase()} (TCP write callback; PLC ACK not yet received)`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function sendReset() {
  if (!activeJob.value || !commandDeviceAvailable.value) return
  isSendingCmd.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/reset`, { deviceId: selectedDeviceId.value })
    cmdResult.value = `${res.data.data.mode}: ${res.data.data.command} → ${res.data.data.response}`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function loadData() {
  isLoading.value = true
  loadError.value = ''
  try {
    const [deviceRes, jobRes] = await Promise.all([api.get('/plc/devices'), api.get('/jobs/active')])
    devices.value = deviceRes.data.data || []
    activeJob.value = jobRes.data.data || null
    
    // Auto select first device if none selected
    if (!selectedDeviceId.value && devices.value.length > 0) {
      selectedDeviceId.value = devices.value[0].id
      await loadTags()
    } else if (selectedDeviceId.value) {
      await loadTags()
    }
  } catch (err) {
    console.error('Failed to load devices:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load PLC devices'
  } finally {
    isLoading.value = false
  }
}

async function loadTags() {
  if (!selectedDeviceId.value) return
  isLoading.value = true
  try {
    const res = await api.get(`/plc/devices/${selectedDeviceId.value}/tags`)
    tags.value = res.data.data || []
  } catch (err) {
    console.error('Failed to load tags:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load PLC tags'
  } finally {
    isLoading.value = false
  }
}

// Data formatting using realtime data from store if available
function getTagLiveValue(tag) {
  // If realtime data exists in store, use it. Otherwise use the initial value.
  const realtimeTag = plcStore.tagValues[tag.id]
  if (realtimeTag) {
    return realtimeTag
  }
  return tag.currentValue || { value: null, quality: 'unknown' }
}

function formatTagValue(tag) {
  const live = getTagLiveValue(tag)
  const v = live.value
  if (v === null || v === undefined) return '—'
  if (tag.data_type === 'BOOL') return v ? 'ON' : 'OFF'
  if (tag.data_type === 'REAL' && typeof v === 'number') return v.toFixed(2)
  return String(v)
}

function getTagValueClass(tag) {
  const live = getTagLiveValue(tag)
  if (!selectedDeviceLive.value?.isDemo && !selectedDeviceOnline.value) return 'text-muted'
  if (tag.data_type === 'BOOL') {
    return live.value ? 'text-success' : 'text-muted'
  }
  return 'text-brand'
}

function getTagQuality(tag) {
  if (selectedDeviceLive.value?.isDemo) return 'DEMO'
  const live = getTagLiveValue(tag)
  if (!selectedDeviceOnline.value) return live.value === null || live.value === undefined ? 'OFFLINE' : 'OFFLINE / LAST VALUE'
  if (live.value === null || live.value === undefined) return 'UNKNOWN'
  return String(live.quality || 'unknown').toUpperCase()
}

function getQualityBadge(tag) {
  const q = getTagQuality(tag)
  if (q === 'DEMO') return 'badge-warning'
  if (q.startsWith('OFFLINE')) return 'badge-danger'
  if (q === 'GOOD') return 'badge-success'
  if (q === 'BAD') return 'badge-danger'
  return 'badge-neutral'
}


onMounted(loadData)
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.modal-content {
  width: 100%;
  max-width: 500px;
  background: var(--color-bg-secondary);
  box-shadow: var(--shadow-lg);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12) var(--space-4);
  text-align: center;
  color: var(--color-text-muted);
}
.empty-state span { font-size: 3rem; margin-bottom: var(--space-4); }
.technical-note { margin-top: 2px; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 400; line-height: 1.25; }
</style>
