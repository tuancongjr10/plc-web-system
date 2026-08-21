<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">📋 Traceability</h2>
      <button class="btn btn-secondary" @click="loadLogs" :disabled="isLoading">
        🔄 Refresh
      </button>
    </div>

    <div v-if="loadErrors.length" class="card mb-4" style="border-color: var(--color-danger)">
      <div class="text-danger text-sm" v-for="message in loadErrors" :key="message">{{ message }}</div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">PLC Tag History</h3>
      </div>
      
      <div class="flex gap-4 mb-4">
        <select v-model="filters.deviceId" class="form-select" style="max-width: 200px" @change="loadLogs">
          <option value="">-- All PLC Devices --</option>
          <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </div>

      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Device</th>
              <th>Tag Name</th>
              <th>Value</th>
              <th>Quality</th>
              <th>Source / Mode</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="logs.length === 0">
              <td colspan="6" class="text-center text-muted py-4">
                <span v-if="isLoading">Loading...</span>
                <span v-else>No Data</span>
              </td>
            </tr>
            <tr v-for="log in logs" :key="log.id">
              <td class="text-xs text-muted text-mono">{{ formatTime(log.timestamp) }}</td>
              <td class="text-sm font-medium">{{ log.device_name }}</td>
              <td class="text-sm text-brand">{{ log.tag_name }}</td>
              <td class="text-sm font-semibold text-mono">
                {{ formatValue(log.value, log.data_type) }} <span class="text-xs text-muted font-normal">{{ log.unit || '' }}</span>
              </td>
              <td>
                <span class="badge" :class="getTagQuality(log) === 'DEMO' ? 'badge-warning' : (getTagQuality(log) === 'GOOD' ? 'badge-success' : 'badge-neutral')">
                  {{ getTagQuality(log) }}
                </span>
              </td>
              <td><span class="badge" :class="getTagMode(log) === 'DEMO' ? 'badge-warning' : 'badge-neutral'">{{ getTagMode(log) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <div class="flex justify-between items-center mt-4">
        <span class="text-sm text-muted">Showing {{ logs.length }} latest tag records.</span>
      </div>
    </div>

    <div class="card" style="margin-top: var(--space-6)">
      <div class="card-header">
        <h3 class="card-title">Production Traceability (SCAN / START / STOP / RESET / PRINT)</h3>
      </div>
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Job</th>
              <th>Product</th>
              <th>Action</th>
              <th>Command</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="prodLogs.length === 0">
              <td colspan="7" class="text-center text-muted py-4">No Data</td>
            </tr>
            <tr v-for="log in prodLogs" :key="'p'+log.id">
              <td class="text-xs text-muted text-mono">{{ formatTime(log.created_at) }}</td>
              <td class="text-xs text-mono">{{ log.job_code }}</td>
              <td class="text-sm">{{ log.product_name || log.product_barcode }}</td>
              <td class="font-medium">{{ displayProductionAction(log.action) }}</td>
              <td class="text-xs text-mono">{{ log.command_sent || '-' }}</td>
              <td><span class="badge" :class="log.status === 'success' ? 'badge-success' : 'badge-danger'">{{ log.status }}</span></td>
              <td class="text-xs text-muted">{{ log.details }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top: var(--space-6)">
      <div class="card-header">
        <h3 class="card-title">PLC Communication Log (plc_events)</h3>
      </div>
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Message</th>
              <th>Command</th>
              <th>Response</th>
              <th>Source / Mode</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="plcEvents.length === 0">
              <td colspan="6" class="text-center text-muted py-4">No Data</td>
            </tr>
            <tr v-for="ev in plcEvents" :key="'e'+ev.id">
              <td class="text-xs text-muted text-mono">{{ formatTime(ev.created_at) }}</td>
              <td>{{ ev.event_type }}</td>
              <td class="text-sm">{{ ev.message }}</td>
              <td class="text-xs text-mono">{{ ev.command_sent || '-' }}</td>
              <td class="text-xs text-mono">{{ ev.response || '-' }}</td>
              <td><span class="badge" :class="getEventMode(ev) === 'DEMO' ? 'badge-warning' : 'badge-neutral'">{{ getEventMode(ev) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import api from '@/composables/useApi'

const isLoading = ref(false)
const logs = ref([])
const prodLogs = ref([])
const plcEvents = ref([])
const devices = ref([])
const filters = ref({ deviceId: '' })
const loadErrors = ref([])

async function loadLogs() {
  isLoading.value = true
  loadErrors.value = []
  try {
    let url = '/plc/logs?limit=100'
    if (filters.value.deviceId) url += `&deviceId=${filters.value.deviceId}`
    
    const results = await Promise.allSettled([
      api.get(url),
      devices.value.length === 0 ? api.get('/plc/devices') : Promise.resolve({ data: { data: devices.value } }),
      api.get('/jobs/logs?limit=50'),
      api.get('/plc/events?limit=50'),
    ])

    const labels = ['Tag Values', 'PLC Devices', 'Production Logs', 'PLC Events']
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const detail = result.reason?.response?.data?.error || result.reason?.message || 'Unknown error'
        loadErrors.value.push(`${labels[index]}: ${detail}`)
      }
    })

    if (results[0].status === 'fulfilled') logs.value = results[0].value.data?.data || []
    if (results[1].status === 'fulfilled' && devices.value.length === 0) devices.value = results[1].value.data?.data || []
    if (results[2].status === 'fulfilled') prodLogs.value = results[2].value.data?.data || []
    if (results[3].status === 'fulfilled') plcEvents.value = results[3].value.data?.data || []
  } catch (err) {
    console.error('Failed to load logs:', err)
    loadErrors.value.push(err.response?.data?.error || err.message || 'Unable to load traceability data')
  } finally {
    isLoading.value = false
  }
}

function formatTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
  })
}

function formatValue(value, type) {
  if (type === 'BOOL') return value === 'true' ? 'ON' : 'OFF'
  if (type === 'REAL') return parseFloat(value).toFixed(2)
  return value
}

function displayProductionAction(action) {
  return action === 'HOME' ? 'RESET' : action
}

function getDeviceForLog(log) {
  return devices.value.find(device => device.name === log.device_name)
}

function getTagMode(log) {
  const suppliedMode = log.mode || log.source
  if (suppliedMode) return String(suppliedMode).toUpperCase()
  if (getDeviceForLog(log)?.liveStatus?.isDemo) return 'DEMO'
  return 'UNKNOWN'
}

function getTagQuality(log) {
  if (getTagMode(log) === 'DEMO') return 'DEMO'
  if (log.value === null || log.value === undefined) return 'UNKNOWN'
  return String(log.quality || 'unknown').toUpperCase()
}

function getEventMode(event) {
  const suppliedMode = event.mode || event.source
  if (suppliedMode) return String(suppliedMode).toUpperCase()
  if (String(event.message || '').includes('[DEMO]')) return 'DEMO'
  if (event.event_type === 'COMMAND') return 'COMMANDED'
  return 'UNKNOWN'
}

onMounted(loadLogs)
</script>
