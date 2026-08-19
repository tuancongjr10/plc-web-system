<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">🔌 Giám sát PLC</h2>
      <div class="flex gap-2">
        <select v-model="selectedDeviceId" class="form-select" @change="loadTags" style="min-width: 200px">
          <option value="" disabled>-- Chọn PLC --</option>
          <option v-for="device in devices" :key="device.id" :value="device.id">
            {{ device.name }} ({{ device.ip_address }})
          </option>
        </select>
        <button class="btn btn-secondary" @click="loadData" :disabled="isLoading">
          🔄 Làm mới
        </button>
      </div>
    </div>

    <!-- Empty State -->
    <div v-if="!selectedDeviceId" class="card empty-state" style="margin-top: var(--space-6)">
      <span>🔌</span>
      <p>Vui lòng chọn một PLC để xem chi tiết</p>
    </div>

    <div v-else class="grid grid-2" style="gap: var(--space-6)">
      <div class="card" style="grid-column: span 2">
        <div class="card-header">
          <h3 class="card-title">Lệnh Siemens S7-1200 TCP (MOVE / STOP / ZERO)</h3>
          <span class="badge" :class="selectedDeviceLive?.isDemo ? 'badge-warning' : (selectedDeviceLive?.connected ? 'badge-success' : 'badge-danger')">
            {{ selectedDeviceLive?.isDemo ? 'DEMO' : (selectedDeviceLive?.connected ? 'REAL' : 'OFFLINE') }}
          </span>
        </div>
        <div class="flex gap-3 items-end" style="flex-wrap: wrap">
          <div class="form-group">
            <label class="form-label">target_revs → MOVE=xxxx</label>
            <input type="number" v-model.number="moveRevs" class="form-input" min="0" max="9999" style="width: 140px" />
          </div>
          <button class="btn btn-success" :disabled="isSendingCmd || !isOperator" @click="sendMove">▶️ MOVE</button>
          <button class="btn btn-danger" :disabled="isSendingCmd || !isOperator" @click="sendStop">⏹️ STOP=0000</button>
          <button class="btn btn-secondary" :disabled="isSendingCmd || !isOperator" @click="sendZero">🏠 ZERO=0000</button>
        </div>
        <p v-if="cmdResult" class="text-xs text-mono mt-3">{{ cmdResult }}</p>
      </div>

      <!-- Tag List -->
      <div class="card" style="grid-column: span 2">
        <div class="card-header">
          <h3 class="card-title">Danh sách Tag ({{ tags.length }})</h3>
        </div>

        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Tên Tag</th>
                <th>Địa chỉ</th>
                <th>Mô tả</th>
                <th>Giá trị</th>
                <th>Đơn vị</th>
                <th>Chất lượng</th>
                <th>Hành động</th>
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
                <td>
                  <button 
                    v-if="tag.is_writable && isOperator"
                    class="btn btn-primary btn-sm"
                    @click="openWriteModal(tag)"
                  >
                    Ghi giá trị
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Write Value Modal -->
    <div v-if="showWriteModal" class="modal-backdrop" @click.self="closeWriteModal">
      <div class="modal-content card">
        <div class="card-header">
          <h3 class="card-title">Ghi giá trị Tag</h3>
          <button class="btn btn-ghost btn-icon" @click="closeWriteModal">✕</button>
        </div>
        <div class="modal-body p-4">
          <div class="form-group mb-4">
            <label class="form-label">Tag Name</label>
            <input type="text" class="form-input" :value="selectedTag?.tag_name" disabled />
          </div>
          <div class="form-group mb-4">
            <label class="form-label">Địa chỉ</label>
            <input type="text" class="form-input" :value="selectedTag?.address" disabled />
          </div>
          <div class="form-group mb-6">
            <label class="form-label" for="tagValue">Giá trị mới</label>
            
            <!-- Boolean input -->
            <select v-if="selectedTag?.data_type === 'BOOL'" v-model="writeForm.value" class="form-select">
              <option :value="true">ON (True)</option>
              <option :value="false">OFF (False)</option>
            </select>
            
            <!-- Number input -->
            <input 
              v-else 
              type="number" 
              v-model.number="writeForm.value" 
              class="form-input" 
              :step="selectedTag?.data_type === 'REAL' ? '0.01' : '1'"
              required
            />
          </div>
          <div class="flex justify-end gap-3">
            <button class="btn btn-ghost" @click="closeWriteModal">Hủy</button>
            <button class="btn btn-primary" @click="submitWrite" :disabled="isWriting">
              {{ isWriting ? 'Đang ghi...' : 'Ghi xuống PLC' }}
            </button>
          </div>
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

const isOperator = computed(() => authStore.isOperator)

// Write Modal
const showWriteModal = ref(false)
const selectedTag = ref(null)
const writeForm = ref({ value: null })
const isWriting = ref(false)
const moveRevs = ref(1500)
const isSendingCmd = ref(false)
const cmdResult = ref('')

const selectedDeviceLive = computed(() => {
  const d = devices.value.find(x => x.id === selectedDeviceId.value)
  return d?.liveStatus || { connected: d?.connection_status === 'connected', isDemo: false }
})

async function sendMove() {
  isSendingCmd.value = true
  try {
    const res = await api.post('/plc/move', { deviceId: selectedDeviceId.value, revs: moveRevs.value })
    cmdResult.value = `${res.data.data.mode}: ${res.data.data.command} → ${res.data.data.response}`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function sendStop() {
  isSendingCmd.value = true
  try {
    const res = await api.post('/plc/stop', { deviceId: selectedDeviceId.value })
    cmdResult.value = `${res.data.data.mode}: ${res.data.data.command} → ${res.data.data.response}`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function sendZero() {
  isSendingCmd.value = true
  try {
    const res = await api.post('/plc/zero', { deviceId: selectedDeviceId.value })
    cmdResult.value = `${res.data.data.mode}: ${res.data.data.command} → ${res.data.data.response}`
  } catch (err) {
    cmdResult.value = err.response?.data?.error || err.message
  } finally {
    isSendingCmd.value = false
  }
}

async function loadData() {
  isLoading.value = true
  try {
    const res = await api.get('/plc/devices')
    devices.value = res.data.data || []
    
    // Auto select first device if none selected
    if (!selectedDeviceId.value && devices.value.length > 0) {
      selectedDeviceId.value = devices.value[0].id
      await loadTags()
    } else if (selectedDeviceId.value) {
      await loadTags()
    }
  } catch (err) {
    console.error('Failed to load devices:', err)
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
  if (tag.data_type === 'BOOL') {
    return live.value ? 'text-success' : 'text-muted'
  }
  return 'text-brand'
}

function getTagQuality(tag) {
  if (selectedDeviceLive.value?.isDemo) return 'DEMO'
  const live = getTagLiveValue(tag)
  if (live.value === null || live.value === undefined) return 'UNKNOWN'
  return String(live.quality || 'unknown').toUpperCase()
}

function getQualityBadge(tag) {
  const q = getTagQuality(tag)
  if (q === 'DEMO') return 'badge-warning'
  if (q === 'GOOD') return 'badge-success'
  if (q === 'BAD') return 'badge-danger'
  return 'badge-neutral'
}

// Write action
function openWriteModal(tag) {
  selectedTag.value = tag
  // Set default value based on type
  writeForm.value.value = tag.data_type === 'BOOL' ? false : 0
  showWriteModal.value = true
}

function closeWriteModal() {
  showWriteModal.value = false
  selectedTag.value = null
}

async function submitWrite() {
  if (!selectedTag.value || writeForm.value.value === null) return
  
  isWriting.value = true
  try {
    // We can use the WebSocket method for faster response, or REST API
    plcStore.writePlcTag(selectedDeviceId.value, selectedTag.value.id, writeForm.value.value)
    
    // Simulate optimistic update or wait for ws response.
    // Assuming success for demo
    setTimeout(() => {
      closeWriteModal()
      isWriting.value = false
    }, 500)
    
  } catch (err) {
    console.error('Failed to write tag:', err)
    isWriting.value = false
  }
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
</style>
