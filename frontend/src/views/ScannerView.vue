<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">📷 Scan & TraceCode</h2>
      <button class="btn btn-secondary" @click="loadData" :disabled="isLoading">
        🔄 Refresh
      </button>
    </div>

    <div v-if="loadError" class="card mb-4" style="border-color: var(--color-danger)">
      <div class="text-danger text-sm">Unable to load scanner data: {{ loadError }}</div>
    </div>

    <div class="grid grid-2" style="gap: var(--space-6)">
      <!-- Scanner Input Panel & Workflow Controls -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Barcode Input</h3>
        </div>

        <div class="scan-area">
          <div class="camera-placeholder mb-4">
             <div class="icon-camera mb-2">📷</div>
             <p class="text-sm text-muted">Camera scanning is not enabled.</p>
             <p class="text-xs text-muted">Use a USB barcode scanner or manual input.</p>
          </div>

          <form @submit.prevent="submitManualScan" class="form-group">
            <label class="form-label">Scan barcode or enter code manually</label>
            <div class="flex gap-2">
              <input 
                type="text" 
                v-model="manualBarcode" 
                class="form-input" 
                placeholder="Scan or enter code here..."
                ref="barcodeInput"
                autofocus
              />
              <button type="submit" class="btn btn-primary" :disabled="!manualBarcode || isScanning">
                {{ isScanning ? 'Processing...' : 'Process' }}
              </button>
            </div>
          </form>
        </div>
        
        <!-- Last Scan Error Warning -->
        <div v-if="lastScanResult && !lastScanResult.success" class="mt-4 p-3 border border-danger rounded bg-danger-light text-danger text-sm">
          <strong>❌ Scan error:</strong> {{ lastScanResult.processResult?.message || 'Product not found' }}
        </div>

        <!-- Active Production Controls -->
        <div v-if="activeJob && activeProduct" class="mt-6 p-4 border rounded bg-tertiary">
          <div class="flex justify-between items-center mb-3 pb-2 border-b" style="border-bottom: 1px solid var(--color-border)">
            <h4 class="font-semibold text-brand text-sm">📋 Active Production Job</h4>
            <span class="badge" :class="getJobStatusBadgeClass(activeJob.status)">{{ formatStatus(activeJob.status) }}</span>
          </div>
          
          <div class="grid grid-2 text-xs gap-2 mb-4">
            <div><strong>Product:</strong> {{ activeProduct.name }}</div>
            <div><strong>Barcode:</strong> {{ activeProduct.barcode }}</div>
            <div><strong>Target Revs:</strong> {{ activeJob.target_revs }}</div>
            <div><strong>Speed RPM:</strong> {{ activeJob.speed_rpm }} RPM</div>
            <div style="grid-column: span 2"><strong>Job Code:</strong> <span class="text-mono font-medium">{{ activeJob.job_code }}</span></div>
          </div>
          
          <div class="flex flex-col gap-3">
            <div class="flex gap-2">
              <button 
                class="btn btn-success flex-1 text-xs" 
                :disabled="activeJob.status === 'running' || isControlLoading || !isOperator"
                @click="triggerStart"
              >
                CmdStart
              </button>
              <button 
                class="btn btn-danger flex-1 text-xs" 
                :disabled="activeJob.status !== 'running' || isControlLoading || !isOperator"
                @click="triggerStop"
              >
                CmdStop
              </button>
              <button
                class="btn btn-warning flex-1 text-xs"
                :disabled="homeDisabled"
                :title="homeDisabledReason"
                @click="triggerHome"
              >
                Home
              </button>
              <button 
                class="btn btn-secondary flex-1 text-xs" 
                :disabled="activeJob.status === 'completed' || isControlLoading || !isOperator"
                @click="triggerReset"
              >
                Reset
              </button>
            </div>

            <!-- Printer selection and logical label print -->
            <div class="border-t pt-3" style="border-top: 1px solid var(--color-border)">
              <label class="form-label text-xs mb-1">Print Queue</label>
              <div class="flex gap-2">
                <select v-model="selectedPrinterId" class="form-select flex-1 text-xs">
                  <option value="" disabled>-- Select Printer --</option>
                  <option v-for="printer in printers" :key="printer.id" :value="printer.id">
                    {{ printer.name }} ({{ printer.connection_status === 'demo' ? 'DEMO' : (printer.connection_status || 'offline').toUpperCase() }})
                  </option>
                </select>
                <button 
                  class="btn btn-primary text-xs" 
                  :disabled="!selectedPrinterId || isPrintingLabel || !isOperator"
                  @click="printJobLabel"
                >
                  🖨️ Print Label
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Stats -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Scan Statistics (24h)</h3>
        </div>
        
        <div class="flex flex-col gap-4">
           <div class="stat-card">
            <div class="stat-icon brand">📷</div>
            <div>
              <div class="stat-value text-brand">{{ stats.total || 0 }}</div>
              <div class="stat-label">Total Scans</div>
            </div>
          </div>
          
          <div>
            <h4 class="text-sm font-semibold mb-2 text-muted">By Barcode Type</h4>
            <div v-if="!stats.byType || stats.byType.length === 0" class="text-sm text-muted">No Data</div>
            <div v-else class="flex flex-col gap-2">
              <div v-for="type in stats.byType" :key="type.barcode_type" class="flex justify-between items-center bg-tertiary p-2 rounded text-sm">
                <span>{{ type.barcode_type }}</span>
                <span class="font-bold">{{ type.count }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Scan History -->
      <div class="card" style="grid-column: span 2">
        <div class="card-header">
          <h3 class="card-title">Scan History</h3>
        </div>

        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Barcode</th>
                <th>Type</th>
                <th>Source</th>
                <th>Operator</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="history.length === 0">
                <td colspan="6" class="text-center text-muted py-4">No Data</td>
              </tr>
              <tr v-for="record in history" :key="record.id">
                <td class="text-xs text-muted">{{ formatTime(record.created_at) }}</td>
                <td class="font-medium text-brand">{{ record.barcode_data }}</td>
                <td class="text-xs">{{ record.barcode_type }}</td>
                <td class="text-xs">{{ record.scan_source }}</td>
                <td class="text-sm">{{ record.username || 'System' }}</td>
                <td class="text-xs text-muted truncate" style="max-width: 200px" :title="getProcessMessage(record)">
                  {{ getProcessMessage(record) }}
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
import { useAuthStore } from '@/stores/auth'
import { usePlcStore } from '@/stores/plc'
import api, { interactivePrintRequestConfig } from '@/composables/useApi'

const authStore = useAuthStore()
const plcStore = usePlcStore()
const isOperator = computed(() => authStore.isOperator)

const isLoading = ref(false)
const history = ref([])
const stats = ref({})
const loadError = ref('')

const manualBarcode = ref('')
const isScanning = ref(false)
const lastScanResult = ref(null)
const barcodeInput = ref(null)

// Workflow details
const activeJob = ref(null)
const activeProduct = ref(null)
const printers = ref([])
const selectedPrinterId = ref('')
const isControlLoading = ref(false)
const isPrintingLabel = ref(false)
const plcDevices = ref([])
const plcTags = ref([])
const selectedDeviceId = ref('')

const selectedDeviceLive = computed(() => {
  const device = plcDevices.value.find(item => item.id === selectedDeviceId.value)
  return device?.liveStatus || { connected: device?.connection_status === 'connected', isDemo: false }
})

const selectedDeviceOnline = computed(() => selectedDeviceLive.value?.connected === true && !selectedDeviceLive.value?.isDemo)

function getTagLiveValue(tag) {
  return plcStore.tagValues[tag.id] || tag.currentValue || { value: null, quality: 'unknown' }
}

function getSafeBooleanTag(tagName) {
  const tag = plcTags.value.find(item => item.tag_name.toLowerCase() === tagName.toLowerCase())
  if (!tag) return null
  const live = getTagLiveValue(tag)
  if (String(live.quality || '').toLowerCase() !== 'good') return null
  if (live.value === true || live.value === 1 || live.value === '1' || String(live.value).toLowerCase() === 'true') return true
  if (live.value === false || live.value === 0 || live.value === '0' || String(live.value).toLowerCase() === 'false') return false
  return null
}

const homeBusyTagExists = computed(() => plcTags.value.some(item => item.tag_name.toLowerCase() === 'homebusy'))
const homeSafetyState = computed(() => ({
  machineRunning: getSafeBooleanTag('MachineRunning'),
  moveBusy: getSafeBooleanTag('MoveBusy'),
  haltBusy: getSafeBooleanTag('HaltBusy'),
  axisPositioning: getSafeBooleanTag('AxisPositioning'),
  homeBusy: getSafeBooleanTag('HomeBusy'),
}))

const homeAllowed = computed(() => {
  const state = homeSafetyState.value
  return selectedDeviceOnline.value &&
    state.machineRunning === false &&
    state.moveBusy === false &&
    state.haltBusy === false &&
    state.axisPositioning === false &&
    (!homeBusyTagExists.value || state.homeBusy === false)
})

const homeDisabled = computed(() => isControlLoading.value || !isOperator.value || !homeAllowed.value)
const homeDisabledReason = computed(() => homeAllowed.value
  ? ''
  : 'HOME requires REAL / ONLINE PLC with realtime GOOD/false status: MachineRunning, MoveBusy, HaltBusy, AxisPositioning, HomeBusy (if present)')

async function loadData() {
  isLoading.value = true
  loadError.value = ''
  try {
    await Promise.all([
      loadHistory(),
      loadActiveState(),
      loadPrinters(),
      loadPlcState()
    ])
  } catch (err) {
    console.error('Failed to load scanner page data:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load scanner data'
  } finally {
    isLoading.value = false
  }
}

async function loadPlcState() {
  try {
    const deviceRes = await api.get('/plc/devices')
    plcDevices.value = deviceRes.data.data || []
    const device = plcDevices.value.find(item => item.is_active) || plcDevices.value[0]
    selectedDeviceId.value = device?.id || ''
    if (!selectedDeviceId.value) {
      plcTags.value = []
      return
    }
    const tagRes = await api.get(`/plc/devices/${selectedDeviceId.value}/tags`)
    plcTags.value = tagRes.data.data || []
  } catch (err) {
    plcDevices.value = []
    plcTags.value = []
    selectedDeviceId.value = ''
    console.error('Failed to load PLC state for HOME:', err)
    throw err
  }
}

async function loadHistory() {
  try {
    const [histRes, statRes] = await Promise.all([
      api.get('/scanner/records?limit=20'),
      api.get('/scanner/stats')
    ])
    history.value = histRes.data.data || []
    stats.value = statRes.data.data || {}
  } catch (err) {
    console.error('Failed to load scanner history:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load scan history'
    throw err
  }
}

async function loadActiveState() {
  try {
    const res = await api.get('/jobs/active')
    if (res.data?.data) {
      activeJob.value = res.data.data
      const prodRes = await api.get(`/products/barcode/${res.data.data.product_barcode}`)
      activeProduct.value = prodRes.data.data
    } else {
      activeJob.value = null
      activeProduct.value = null
    }
  } catch (err) {
    console.error('Failed to load active job:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load active job'
    throw err
  }
}

async function loadPrinters() {
  try {
    const res = await api.get('/printers')
    printers.value = res.data.data || []
    if (printers.value.length > 0) {
      selectedPrinterId.value = printers.value[0].id
    }
  } catch (err) {
    console.error('Failed to load printers:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load printers'
    throw err
  }
}

async function submitManualScan() {
  if (!manualBarcode.value.trim()) return
  
  isScanning.value = true
  const data = manualBarcode.value.trim()
  
  try {
    const res = await api.post('/scanner/scan', {
      barcodeData: data,
      barcodeType: determineType(data),
      scanSource: 'usb'
    })
    
    lastScanResult.value = {
      success: true,
      ...res.data.data
    }

    if (res.data.data?.processResult?.data) {
      activeJob.value = res.data.data.processResult.data.job
      activeProduct.value = res.data.data.processResult.data.product
    }
    
    manualBarcode.value = ''
    await loadHistory()
    
    setTimeout(() => {
      if (barcodeInput.value) barcodeInput.value.focus()
    }, 100)
    
  } catch (err) {
    lastScanResult.value = {
      success: false,
      barcodeData: data,
      processResult: { message: err.response?.data?.error || err.message }
    }
  } finally {
    isScanning.value = false
  }
}

async function triggerStart() {
  if (!activeJob.value) return
  isControlLoading.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/start`)
    if (res.data?.data?.job) {
      activeJob.value = res.data.data.job
    }
  } catch (err) {
    alert('Unable to send START command: ' + (err.response?.data?.error || err.message))
  } finally {
    isControlLoading.value = false
  }
}

async function triggerStop() {
  if (!activeJob.value) return
  isControlLoading.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/stop`)
    if (res.data?.data?.job) {
      activeJob.value = res.data.data.job
    }
  } catch (err) {
    alert('Unable to send STOP command: ' + (err.response?.data?.error || err.message))
  } finally {
    isControlLoading.value = false
  }
}

async function triggerHome() {
  if (!homeAllowed.value) return
  isControlLoading.value = true
  try {
    const res = await api.post(`/plc/devices/${selectedDeviceId.value}/home`)
    const result = res.data.data
    alert(`${result.mode}: ${result.command} → ${result.result.toUpperCase()} (TCP write callback; PLC ACK not yet received)`)
  } catch (err) {
    alert('Unable to send HOME command: ' + (err.response?.data?.error || err.message))
  } finally {
    isControlLoading.value = false
  }
}

async function triggerReset() {
  if (!activeJob.value) return
  isControlLoading.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/reset`)
    if (res.data?.data?.job) {
      activeJob.value = res.data.data.job
    }
  } catch (err) {
    alert('Unable to send RESET command: ' + (err.response?.data?.error || err.message))
  } finally {
    isControlLoading.value = false
  }
}

async function printJobLabel() {
  if (!activeJob.value || !activeProduct.value || !selectedPrinterId.value) return
  isPrintingLabel.value = true
  try {
    await api.post(`/jobs/${activeJob.value.id}/print`, {
      printerId: selectedPrinterId.value,
      copies: 1
    }, interactivePrintRequestConfig)
    alert('Print command submitted successfully.')
  } catch (err) {
    alert('Unable to submit print command: ' + (err.response?.data?.error || err.message))
  } finally {
    isPrintingLabel.value = false
  }
}

function determineType(data) {
  if (data.startsWith('{') && data.endsWith('}')) return 'qr_code'
  if (/^\d{13}$/.test(data)) return 'ean_13'
  if (/^LOT-/.test(data)) return 'code_128'
  return 'unknown'
}

function formatStatus(status) {
  const value = String(status || 'unknown').toLowerCase()
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('en-US')
}

function getProcessMessage(record) {
  if (!record.process_result) return 'Not Processed'
  try {
    const res = JSON.parse(record.process_result)
    return res.data?.message || res.message || res.action || 'OK'
  } catch {
    return 'Parse Error'
  }
}

function getJobStatusBadgeClass(status) {
  const map = {
    created: 'badge-neutral',
    running: 'badge-success',
    stopped: 'badge-warning',
    completed: 'badge-success',
    failed: 'badge-danger'
  }
  return map[status] || 'badge-neutral'
}

onMounted(() => {
  loadData()
  if (barcodeInput.value) {
    barcodeInput.value.focus()
  }
})
</script>

<style scoped>
.camera-placeholder {
  background: var(--color-bg-tertiary);
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8) var(--space-4);
  text-align: center;
}
.icon-camera {
  font-size: 3rem;
  opacity: 0.5;
}
.border-success { border-color: var(--color-success); }
.border-danger { border-color: var(--color-danger); }
.bg-tertiary { background: var(--color-bg-tertiary); }
.bg-danger-light { background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.1); }
</style>
