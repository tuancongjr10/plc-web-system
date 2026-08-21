<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">⚙️ Device Registry</h2>
    </div>

    <div class="grid grid-2" style="gap: var(--space-6)">
      <!-- Add PLC Device -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">PLC Device Registration</h3>
        </div>
        
        <form @submit.prevent="addPlc" class="form-group">
          <div class="form-group mb-3">
            <label class="form-label">Device Name</label>
            <input type="text" v-model="plcForm.name" class="form-input" required placeholder="Example: Line 2 - Main PLC" />
          </div>
          
          <div class="grid grid-2 gap-3 mb-3">
            <div class="form-group">
              <label class="form-label">IP Address</label>
              <input type="text" v-model="plcForm.ip_address" class="form-input" required placeholder="192.168.1.100" />
            </div>
            <div class="form-group">
              <label class="form-label">Port</label>
              <input type="number" v-model.number="plcForm.port" class="form-input" required />
            </div>
          </div>
          
          <div class="form-group mb-3">
            <label class="form-label">Protocol</label>
            <select v-model="plcForm.protocol" class="form-select">
              <option value="s7-tcp">Siemens S7-1200 TCP Socket</option>
            </select>
          </div>
          
          <div class="form-group mb-4">
            <label class="form-label">Polling Interval (ms)</label>
            <input type="number" v-model.number="plcForm.poll_interval" class="form-input" min="100" step="100" />
          </div>
          
          <button type="submit" class="btn btn-primary w-full" :disabled="isSubmitting">
            {{ isSubmitting ? 'Adding...' : 'Add Device' }}
          </button>
          
          <div v-if="successMsg" class="alert alert-success mt-3 p-2 text-sm">{{ successMsg }}</div>
          <div v-if="errorMsg" class="alert alert-danger mt-3 p-2 text-sm">{{ errorMsg }}</div>
        </form>
      </div>
      
      <!-- System Info placeholder -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">System Information</h3>
        </div>
        <div class="p-4 bg-tertiary rounded text-sm font-mono text-muted">
          <p>PLC Web Control System</p>
          <p>Version: 1.0.0</p>
          <p>PLC: Siemens S7-1200 TCP 192.168.0.1:2000</p>
          <p>Frontend: Vue 3 + Vite</p>
          <p>Backend: Node.js + Express + SQLite</p>
          <br/>
          <p>JOB=PPPP,RRRR,QQQQ / START=0000 / STOP=0000 / HOME=0000 / RESET=0000</p>
          <p>HOME = homing/reference axis; RESET = reset machine/fault. These commands are independent.</p>
        </div>
      </div>

      <!-- Product master data -->
      <div class="card" style="grid-column: span 2">
        <div class="card-header">
          <h3 class="card-title">Product / Recipe Registry</h3>
        </div>
        <form @submit.prevent="saveProduct" class="grid grid-2 gap-3 mb-4">
          <div class="form-group">
            <label class="form-label">Barcode</label>
            <input v-model="productForm.barcode" class="form-input" required placeholder="PROD-001" />
          </div>
          <div class="form-group">
            <label class="form-label">Product Name</label>
            <input v-model="productForm.name" class="form-input" required />
          </div>
          <div class="form-group">
            <label class="form-label">Product ID (PPPP)</label>
            <div class="technical-note">ID sản phẩm gửi xuống PLC</div>
            <input type="number" v-model.number="productForm.plc_product_id" class="form-input" min="0" max="9999" required />
          </div>
          <div class="form-group">
            <label class="form-label">Recipe ID (RRRR)</label>
            <div class="technical-note">ID công thức vận hành của sản phẩm</div>
            <input type="number" v-model.number="productForm.recipe_id" class="form-input" min="0" max="9999" required />
          </div>
          <div class="form-group">
            <label class="form-label">Target Quantity (QQQQ)</label>
            <div class="technical-note">Số lượng sản phẩm mục tiêu của Job</div>
            <input type="number" v-model.number="productForm.target_qty" class="form-input" min="0" max="9999" required />
          </div>
          <div class="form-group">
            <label class="form-label">Target Revs</label>
            <input type="number" v-model.number="productForm.target_revs" class="form-input" min="0" max="9999" required />
          </div>
          <div class="form-group">
            <label class="form-label">speed_rpm</label>
            <input type="number" v-model.number="productForm.speed_rpm" class="form-input" min="0" required />
          </div>
          <div class="form-group">
            <label class="form-label">Label template</label>
            <select v-model="productForm.label_template_id" class="form-select">
              <option value="">-- Not Selected --</option>
              <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
            </select>
          </div>
          <div class="form-group" style="display:flex;align-items:flex-end">
            <button type="submit" class="btn btn-primary" :disabled="isSavingProduct">
              {{ productForm.id ? 'Update Product' : 'Add Product' }}
            </button>
            <button v-if="productForm.id" type="button" class="btn btn-ghost" style="margin-left:8px" @click="resetProductForm">Cancel</button>
          </div>
        </form>

        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Barcode</th>
                <th>Name</th>
                <th>ProductID</th>
                <th>RecipeID</th>
                <th>TargetQty</th>
                <th>target_revs</th>
                <th>speed_rpm</th>
                <th>Label</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in products" :key="p.id">
                <td class="text-mono">{{ p.barcode }}</td>
                <td>{{ p.name }}</td>
                <td>{{ p.plc_product_id ?? '-' }}</td>
                <td>{{ p.recipe_id ?? '-' }}</td>
                <td>{{ p.target_qty ?? '-' }}</td>
                <td>{{ p.target_revs }}</td>
                <td>{{ p.speed_rpm }}</td>
                <td class="text-xs">{{ p.label_template_name || '-' }}</td>
                <td>
                  <button class="btn btn-ghost btn-sm" @click="editProduct(p)">Edit</button>
                  <button class="btn btn-ghost btn-sm" @click="deleteProduct(p)">Delete</button>
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
import { ref, onMounted } from 'vue'
import api from '@/composables/useApi'

const isSubmitting = ref(false)
const successMsg = ref('')
const errorMsg = ref('')

const plcForm = ref({
  name: '',
  ip_address: '192.168.0.1',
  port: 2000,
  protocol: 's7-tcp',
  poll_interval: 1000
})

const products = ref([])
const templates = ref([])
const isSavingProduct = ref(false)
const productForm = ref({
  id: '',
  barcode: '',
  name: '',
  plc_product_id: 1,
  recipe_id: 1,
  target_qty: 1,
  target_revs: 1500,
  speed_rpm: 600,
  label_template_id: ''
})

async function addPlc() {
  isSubmitting.value = true
  successMsg.value = ''
  errorMsg.value = ''
  
  try {
    await api.post('/plc/devices', plcForm.value)
    successMsg.value = 'PLC device added successfully.'
    plcForm.value = { name: '', ip_address: '192.168.0.1', port: 2000, protocol: 's7-tcp', poll_interval: 1000 }
    
    setTimeout(() => { successMsg.value = '' }, 3000)
  } catch (err) {
    errorMsg.value = err.response?.data?.error || 'Unable to add PLC device'
  } finally {
    isSubmitting.value = false
  }
}

async function loadProducts() {
  try {
    const [pRes, tRes] = await Promise.all([
      api.get('/products'),
      api.get('/printers/templates')
    ])
    products.value = pRes.data.data || []
    templates.value = tRes.data.data || []
  } catch (err) {
    console.error('Load products error:', err)
  }
}

function resetProductForm() {
  productForm.value = { id: '', barcode: '', name: '', plc_product_id: 1, recipe_id: 1, target_qty: 1, target_revs: 1500, speed_rpm: 600, label_template_id: '' }
}

function editProduct(p) {
  productForm.value = {
    id: p.id,
    barcode: p.barcode,
    name: p.name,
    plc_product_id: p.plc_product_id,
    recipe_id: p.recipe_id,
    target_qty: p.target_qty,
    target_revs: p.target_revs,
    speed_rpm: p.speed_rpm,
    label_template_id: p.label_template_id || ''
  }
}

async function saveProduct() {
  isSavingProduct.value = true
  try {
    const payload = { ...productForm.value }
    if (!payload.label_template_id) payload.label_template_id = null
    if (payload.id) {
      await api.put(`/products/${payload.id}`, payload)
    } else {
      await api.post('/products', payload)
    }
    resetProductForm()
    await loadProducts()
  } catch (err) {
    alert(err.response?.data?.error || err.message)
  } finally {
    isSavingProduct.value = false
  }
}

async function deleteProduct(p) {
  if (!confirm(`Delete product ${p.barcode}?`)) return
  try {
    await api.delete(`/products/${p.id}`)
    await loadProducts()
  } catch (err) {
    alert(err.response?.data?.error || err.message)
  }
}

onMounted(loadProducts)
</script>

<style scoped>
.bg-tertiary { background: var(--color-bg-tertiary); }
.technical-note { margin-top: 2px; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 400; line-height: 1.25; }
</style>
