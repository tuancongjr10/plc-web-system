<template>
  <div>
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
          <h3 class="card-title">🔌 Trạng thái PLC</h3>
          <div class="flex gap-2 items-center">
            <div class="status-dot" :class="plcStore.wsConnected ? 'online' : 'offline'"></div>
            <span class="text-xs text-muted">{{ plcStore.wsConnected ? 'WebSocket Live' : 'Offline' }}</span>
          </div>
        </div>

        <div v-if="devices.length === 0" class="empty-state">
          <span>🔌</span>
          <p>Chưa có PLC nào được cấu hình</p>
        </div>

        <div v-for="device in devices" :key="device.id" class="device-row" v-else>
          <div class="status-dot" :class="device.liveStatus?.isDemo ? 'warning' : (device.connection_status === 'connected' ? 'online' : 'offline')"></div>
          <div class="device-info">
            <span class="font-medium text-sm">{{ device.name }}</span>
            <span class="text-xs text-muted">{{ device.ip_address }}:{{ device.port }} · {{ device.protocol || 's7-tcp' }}</span>
          </div>
          <div class="badge" :class="device.liveStatus?.isDemo ? 'badge-warning' : (device.connection_status === 'connected' ? 'badge-success' : 'badge-danger')">
            {{ device.liveStatus?.isDemo ? 'DEMO / SIMULATED' : (device.connection_status === 'connected' ? 'Kết nối' : 'Mất kết nối') }}
          </div>
        </div>
      </div>

      <!-- Recent Alarms -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">⚠️ Cảnh báo gần đây</h3>
          <span class="badge badge-danger" v-if="plcStore.alarms.length > 0">{{ plcStore.alarms.length }}</span>
        </div>

        <div v-if="plcStore.alarms.length === 0" class="empty-state">
          <span>✅</span>
          <p class="text-success">Không có cảnh báo</p>
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
          <h3 class="card-title">📊 Giá trị Tag thời gian thực</h3>
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
          <h3 class="card-title">🖨️ Lệnh in gần đây</h3>
          <router-link to="/printer" class="btn btn-ghost btn-sm">Xem tất cả →</router-link>
        </div>

        <div v-if="recentJobs.length === 0" class="empty-state">
          <span>🖨️</span>
          <p>Chưa có lệnh in nào</p>
        </div>

        <div class="table-container" v-else>
          <table class="table">
            <thead>
              <tr>
                <th>Tên job</th>
                <th>Printer</th>
                <th>Trạng thái</th>
                <th>Thời gian</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in recentJobs" :key="job.id">
                <td class="text-sm">{{ job.job_name }}</td>
                <td class="text-sm text-muted">{{ job.printer_name || 'N/A' }}</td>
                <td>
                  <span class="badge" :class="getPrintJobMode(job) === 'DEMO' && job.status === 'completed' ? 'badge-warning' : getJobStatusClass(job.status)">{{ getPrintJobMode(job) === 'DEMO' && job.status === 'completed' ? 'DEMO COMPLETED' : job.status }}</span>
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

const plcStore = usePlcStore()
const devices = ref([])
const recentJobs = ref([])
const updateCount = ref(0)

const stats = computed(() => [
  {
    icon: '🔌',
    value: `${devices.value.filter(d => d.connection_status === 'connected' && !d.liveStatus?.isDemo).length}/${devices.value.length}`,
    label: 'PLC Kết nối',
    color: 'success',
    textColor: 'success',
  },
  {
    icon: '⚠️',
    value: plcStore.alarms.filter(a => !a.resolved).length,
    label: 'Cảnh báo',
    color: 'warning',
    textColor: 'warning',
  },
  {
    icon: '🖨️',
    value: recentJobs.value.filter(j => j.status === 'completed').length,
    label: 'Lệnh in hôm nay',
    color: 'brand',
    textColor: 'brand',
  },
  {
    icon: '📷',
    value: Object.keys(plcStore.tagValues).length,
    label: 'Tags đang theo dõi',
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
  try {
    const [devRes, jobRes] = await Promise.all([
      api.get('/plc/devices'),
      api.get('/printers/jobs?limit=5'),
    ])
    devices.value = devRes.data.data || []
    recentJobs.value = jobRes.data.data || []
  } catch (err) {
    console.error('Dashboard load error:', err)
  }
}

function formatTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatTagValue(tagData) {
  const v = tagData.value
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF'
  if (typeof v === 'number') return v.toFixed(2)
  return String(v)
}

function getTagValueClass(tagData) {
  if (typeof tagData.value === 'boolean') {
    return tagData.value ? 'text-success' : 'text-muted'
  }
  return 'text-brand'
}

function getTagQuality(tagData) {
  if (devices.value.some(device => device.liveStatus?.isDemo)) return 'DEMO'
  return String(tagData.quality || 'unknown').toUpperCase()
}

function getTagQualityClass(tagData) {
  const quality = getTagQuality(tagData)
  if (quality === 'DEMO') return 'text-warning'
  if (quality === 'GOOD') return 'text-success'
  return 'text-muted'
}

function getJobStatusClass(status) {
  const map = {
    completed: 'badge-success',
    failed: 'badge-danger',
    printing: 'badge-warning',
    pending: 'badge-neutral',
  }
  return map[status] || 'badge-neutral'
}

function getPrintJobMode(job) {
  try {
    return String(JSON.parse(job.metadata || '{}').mode || 'UNKNOWN').toUpperCase()
  } catch {
    return 'UNKNOWN'
  }
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
