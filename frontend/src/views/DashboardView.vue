<template>
  <div>
    <div v-if="loadError" class="card mb-4" style="border-color: var(--color-danger)">
      <div class="text-danger text-sm">Unable to load dashboard: {{ loadError }}</div>
    </div>
    <!-- Stats Row -->
    <div class="grid grid-4" style="margin-bottom: var(--space-6)">
      <div class="stat-card" v-for="stat in stats" :key="stat.label">
        <div class="stat-icon" :class="stat.color">{{ stat.icon }}</div>
        <div>
          <div class="stat-value" :class="`text-${stat.textColor || 'primary'}`">{{ stat.value }}</div>
          <div class="stat-label">{{ stat.label }}</div>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="gap: var(--space-6)">
      <!-- PLC Device Status -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🔌 Machine Status</h3>
          <div class="flex gap-2 items-center">
            <div class="status-dot" :class="plcStore.wsConnected ? 'online' : 'offline'"></div>
            <span class="text-xs text-muted">{{ plcStore.wsConnected ? 'WebSocket Live' : 'Offline' }}</span>
          </div>
        </div>

        <div v-if="!loadError && devices.length === 0" class="empty-state">
          <span>🔌</span>
          <p>No PLC devices configured</p>
        </div>

        <div v-for="device in devices" :key="device.id" class="device-row" v-else>
          <div class="status-dot" :class="device.liveStatus?.isDemo ? 'warning' : (isDeviceOnline(device) ? 'online' : 'offline')"></div>
          <div class="device-info">
            <span class="font-medium text-sm">{{ device.name }}</span>
            <span class="text-xs text-muted">{{ device.ip_address }}:{{ device.port }} · {{ device.protocol || 's7-tcp' }}</span>
          </div>
          <div class="badge" :class="device.liveStatus?.isDemo ? 'badge-warning' : (isDeviceOnline(device) ? 'badge-success' : 'badge-danger')">
            {{ device.liveStatus?.isDemo ? 'Demo / Simulated' : (isDeviceOnline(device) ? 'Real / Online' : 'Real / Offline') }}
          </div>
        </div>
      </div>

      <!-- Recent Alarms -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">⚠️ Recent Alerts</h3>
          <span class="badge badge-danger" v-if="plcStore.alarms.length > 0">{{ plcStore.alarms.length }}</span>
        </div>

        <div v-if="plcStore.alarms.length === 0" class="empty-state">
          <span>✅</span>
          <p class="text-success">No active alerts</p>
        </div>

        <div v-for="alarm in plcStore.alarms.slice(0, 6)" :key="alarm.id" class="alarm-row">
          <div class="status-dot warning"></div>
          <div class="alarm-detail">
            <span class="text-sm">{{ alarm.message || alarm.tagName }}</span>
            <span class="text-xs text-muted">{{ formatTime(alarm.timestamp) }}</span>
          </div>
          <div class="badge badge-warning">{{ alarm.type }}</div>
        </div>
      </div>

      <!-- Live Tag Values -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📊 Realtime Tags</h3>
          <span class="text-xs text-muted text-mono">{{ updateCount }} updates</span>
        </div>

        <div class="tag-grid">
          <div v-for="(tagData, tagId) in displayTags" :key="tagId" class="tag-item">
            <div class="tag-name">{{ tagData.tagName }}</div>
            <div class="tag-value" :class="getTagValueClass(tagData)">
              {{ formatTagValue(tagData) }}
            </div>
            <div class="tag-unit text-xs text-muted">{{ tagData.unit || '' }}</div>
            <div class="tag-quality" :class="getTagQualityClass(tagData)">
              {{ getTagQuality(tagData) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Print Jobs -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🖨️ Recent Print Jobs</h3>
          <router-link to="/printer" class="btn btn-ghost btn-sm">View All →</router-link>
        </div>

        <div v-if="recentJobs.length === 0" class="empty-state">
          <span>🖨️</span>
          <p>No print jobs</p>
        </div>

        <div class="table-container" v-else>
          <table class="table">
            <thead>
              <tr>
                <th>Job Name</th>
                <th>Printer</th>
                <th>Status</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in recentJobs" :key="job.id">
                <td class="text-sm">{{ job.job_name }}</td>
                <td class="text-sm text-muted">{{ job.printer_name || 'N/A' }}</td>
                <td>
                  <span class="badge" :class="isDemoCompletedJob(job) ? 'badge-warning' : getPrintJobStatusClass(job.status)">{{ isDemoCompletedJob(job) ? `DEMO · ${getPrintJobStatusLabel(job.status)}` : getPrintJobStatusLabel(job.status) }}</span>
                </td>
                <td class="text-xs text-muted text-mono">{{ formatTime(job.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { usePlcStore } from '@/stores/plc'
import api from '@/composables/useApi'
import { getPrintJobStatusClass, getPrintJobStatusLabel, normalizePrintJobStatus } from '@/utils/printJobStatus'

const plcStore = usePlcStore()
const devices = ref([])
const recentJobs = ref([])
const updateCount = ref(0)
const loadError = ref('')

const stats = computed(() => [
  {
    icon: '🔌',
    value: loadError.value && devices.value.length === 0
      ? '—/—'
      : `${devices.value.filter(d => d.connection_status === 'connected' && !d.liveStatus?.isDemo).length}/${devices.value.length}`,
    label: 'PLC / Line Status',
    color: 'success',
    textColor: 'success',
  },
  {
    icon: '⚠️',
    value: plcStore.alarms.filter(a => !a.resolved).length,
    label: 'Alerts',
    color: 'warning',
    textColor: 'warning',
  },
  {
    icon: '🖨️',
    value: recentJobs.value.filter(j => normalizePrintJobStatus(j.status) === 'completed').length,
    label: 'Print Jobs Today',
    color: 'brand',
    textColor: 'brand',
  },
  {
    icon: '📷',
    value: Object.keys(plcStore.tagValues).length,
    label: 'Realtime Tags',
    color: 'brand',
    textColor: 'primary',
  },
])

const displayTags = computed(() => {
  const values = plcStore.tagValues
  const entries = Object.entries(values).slice(0, 8)
  return Object.fromEntries(entries)
})

// Watch for tag updates to count
watch(() => plcStore.tagValues, () => {
  updateCount.value++
}, { deep: true })

async function loadData() {
  loadError.value = ''
  try {
    const [devRes, jobRes] = await Promise.all([
      api.get('/plc/devices'),
      api.get('/printers/jobs?limit=5'),
    ])
    devices.value = devRes.data.data || []
    recentJobs.value = jobRes.data.data || []
  } catch (err) {
    console.error('Dashboard load error:', err)
    loadError.value = err.response?.data?.error || err.message || 'Unable to load data'
  }
}

function formatTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatTagValue(tagData) {
  const v = tagData.value
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF'
  if (typeof v === 'number') return v.toFixed(2)
  return String(v)
}

function getTagValueClass(tagData) {
  if (areRealDevicesOffline()) return 'text-muted'
  if (typeof tagData.value === 'boolean') {
    return tagData.value ? 'text-success' : 'text-muted'
  }
  return 'text-brand'
}

function isDeviceOnline(device) {
  if (device.liveStatus) return !device.liveStatus.isDemo && device.liveStatus.connected === true
  return device.connection_status === 'connected'
}

function areRealDevicesOffline() {
  return devices.value.length > 0 && !devices.value.some(isDeviceOnline) && !devices.value.some(device => device.liveStatus?.isDemo)
}

function getTagQuality(tagData) {
  if (devices.value.some(device => device.liveStatus?.isDemo)) return 'DEMO'
  if (areRealDevicesOffline()) return tagData.value === null || tagData.value === undefined ? 'OFFLINE' : 'OFFLINE / LAST VALUE'
  return String(tagData.quality || 'unknown').toUpperCase()
}

function getTagQualityClass(tagData) {
  const quality = getTagQuality(tagData)
  if (quality === 'DEMO') return 'text-warning'
  if (quality.startsWith('OFFLINE')) return 'text-danger'
  if (quality === 'GOOD') return 'text-success'
  return 'text-muted'
}

function getPrintJobMode(job) {
  try {
    return String(JSON.parse(job.metadata || '{}').mode || 'UNKNOWN').toUpperCase()
  } catch {
    return 'UNKNOWN'
  }
}

function isDemoCompletedJob(job) {
  return getPrintJobMode(job) === 'DEMO' && normalizePrintJobStatus(job.status) === 'completed'
}

onMounted(loadData)
</script>

<style scoped>
.device-row, .alarm-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-border);
}

.device-row:last-child, .alarm-row:last-child { border-bottom: none; }

.device-info, .alarm-detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.tag-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

.tag-item {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tag-name {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.tag-value {
  font-family: var(--font-mono);
  font-size: var(--text-lg);
  font-weight: 600;
  line-height: 1;
}

.tag-quality {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.empty-state span { font-size: 2rem; }
</style>
