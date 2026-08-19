<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">📷 Scanner & Barcode Workflow</h2>
      <button class="btn btn-secondary" @click="loadData" :disabled="isLoading">
        🔄 Làm mới
      </button>
    </div>

    <div class="grid grid-2" style="gap: var(--space-6)">
      <!-- Scanner Input Panel & Workflow Controls -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Quét mã vạch</h3>
        </div>

        <div class="scan-area">
          <div class="camera-placeholder mb-4">
             <div class="icon-camera mb-2">📷</div>
             <p class="text-sm text-muted">Tính năng quét qua Camera đang được phát triển.</p>
             <p class="text-xs text-muted">Vui lòng sử dụng máy quét cầm tay hoặc nhập tay bên dưới.</p>
          </div>

          <form @submit.prevent="submitManualScan" class="form-group">
            <label class="form-label">Nhập mã vạch hoặc quét bằng máy quét USB</label>
            <div class="flex gap-2">
              <input 
                type="text" 
                v-model="manualBarcode" 
                class="form-input" 
                placeholder="Quét hoặc gõ mã vào đây..." 
                ref="barcodeInput"
                autofocus
              />
              <button type="submit" class="btn btn-primary" :disabled="!manualBarcode || isScanning">
                {{ isScanning ? 'Đang xử lý...' : 'Xử lý' }}
              </button>
            </div>
          </form>
        </div>
        
        <!-- Last Scan Error Warning -->
        <div v-if="lastScanResult && !lastScanResult.success" class="mt-4 p-3 border border-danger rounded bg-danger-light text-danger text-sm">
          <strong>❌ Lỗi quét mã:</strong> {{ lastScanResult.processResult?.message || 'Không tìm thấy sản phẩm' }}
        </div>

        <!-- Active Production Controls -->
        <div v-if="activeJob && activeProduct" class="mt-6 p-4 border rounded bg-tertiary">
          <div class="flex justify-between items-center mb-3 pb-2 border-b" style="border-bottom: 1px solid var(--color-border)">
            <h4 class="font-semibold text-brand text-sm">📋 Yêu cầu sản xuất hoạt động</h4>
            <span class="badge" :class="getJobStatusBadgeClass(activeJob.status)">{{ activeJob.status.toUpperCase() }}</span>
          </div>
          
          <div class="grid grid-2 text-xs gap-2 mb-4">
            <div><strong>Sản phẩm:</strong> {{ activeProduct.name }}</div>
            <div><strong>Mã vạch:</strong> {{ activeProduct.barcode }}</div>
            <div><strong>Vòng quay mục tiêu:</strong> {{ activeJob.target_revs }}</div>
            <div><strong>Tốc độ động cơ:</strong> {{ activeJob.speed_rpm }} RPM</div>
            <div style="grid-column: span 2"><strong>Mã Job:</strong> <span class="text-mono font-medium">{{ activeJob.job_code }}</span></div>
          </div>
          
          <div class="flex flex-col gap-3">
            <div class="flex gap-2">
              <button 
                class="btn btn-success flex-1 text-xs" 
                :disabled="activeJob.status === 'running' || isControlLoading || !isOperator"
                @click="triggerStart"
              >
                ▶️ START (MOVE)
              </button>
              <button 
                class="btn btn-danger flex-1 text-xs" 
                :disabled="activeJob.status !== 'running' || isControlLoading || !isOperator"
                @click="triggerStop"
              >
                ⏹️ STOP
              </button>
              <button 
                class="btn btn-secondary flex-1 text-xs" 
                :disabled="activeJob.status === 'completed' || isControlLoading || !isOperator"
                @click="triggerHome"
              >
                🏠 HOME (ZERO)
              </button>
            </div>

            <!-- Printer selection and logical label print -->
            <div class="border-t pt-3" style="border-top: 1px solid var(--color-border)">
              <label class="form-label text-xs mb-1">Máy in nhãn Godex</label>
              <div class="flex gap-2">
                <select v-model="selectedPrinterId" class="form-select flex-1 text-xs">
                  <option value="" disabled>-- Chọn máy in --</option>
                  <option v-for="printer in printers" :key="printer.id" :value="printer.id">
                    {{ printer.name }} ({{ printer.connection_status === 'demo' ? 'DEMO' : (printer.connection_status || 'offline').toUpperCase() }})
                  </option>
                </select>
                <button 
                  class="btn btn-primary text-xs" 
                  :disabled="!selectedPrinterId || isPrintingLabel || !isOperator"
                  @click="printJobLabel"
                >
                  🖨️ In nhãn
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Stats -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Thống kê (24h)</h3>
        </div>
        
        <div class="flex flex-col gap-4">
           <div class="stat-card">
            <div class="stat-icon brand">📷</div>
            <div>
              <div class="stat-value text-brand">{{ stats.total || 0 }}</div>
              <div class="stat-label">Tổng lượt quét</div>
            </div>
          </div>
          
          <div>
            <h4 class="text-sm font-semibold mb-2 text-muted">Theo loại mã</h4>
            <div v-if="!stats.byType || stats.byType.length === 0" class="text-sm text-muted">Chưa có dữ liệu</div>
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
          <h3 class="card-title">Lịch sử quét</h3>
        </div>

        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Mã vạch</th>
                <th>Loại</th>
                <th>Nguồn</th>
                <th>Người quét</th>
                <th>Kết quả xử lý</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="history.length === 0">
                <td colspan="6" class="text-center text-muted py-4">Không có dữ liệu</td>
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
import api from '@/composables/useApi'

const authStore = useAuthStore()
const isOperator = computed(() => authStore.isOperator)

const isLoading = ref(false)
const history = ref([])
const stats = ref({})

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

async function loadData() {
  isLoading.value = true
  try {
    await Promise.all([
      loadHistory(),
      loadActiveState(),
      loadPrinters()
    ])
  } catch (err) {
    console.error('Failed to load scanner page data:', err)
  } finally {
    isLoading.value = false
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
    alert('Lỗi gửi lệnh START: ' + (err.response?.data?.error || err.message))
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
    alert('Lỗi gửi lệnh STOP: ' + (err.response?.data?.error || err.message))
  } finally {
    isControlLoading.value = false
  }
}

async function triggerHome() {
  if (!activeJob.value) return
  isControlLoading.value = true
  try {
    const res = await api.post(`/jobs/${activeJob.value.id}/home`)
    if (res.data?.data?.job) {
      activeJob.value = res.data.data.job
    }
  } catch (err) {
    alert('Lỗi gửi lệnh HOME: ' + (err.response?.data?.error || err.message))
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
    })
    alert('Đã gửi lệnh in thành công!')
  } catch (err) {
    alert('Lỗi gửi lệnh in: ' + (err.response?.data?.error || err.message))
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

function formatTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('vi-VN')
}

function getProcessMessage(record) {
  if (!record.process_result) return 'Chưa xử lý'
  try {
    const res = JSON.parse(record.process_result)
    return res.data?.message || res.message || res.action || 'OK'
  } catch {
    return 'Lỗi phân tích'
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
