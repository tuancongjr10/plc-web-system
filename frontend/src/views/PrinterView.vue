<template>
  <div>
    <div class="page-header"><h2 class="page-title">🖨️ Quản lý Máy in Godex</h2><button class="btn btn-secondary" @click="loadData">🔄 Làm mới</button></div>
    <div class="grid" style="grid-template-columns: 1fr 2fr; gap: var(--space-6)">
      <div class="card">
        <div class="card-header"><h3 class="card-title">Máy in</h3></div>
        <select v-model="selectedPrinterId" class="form-select" @change="loadJobs"><option v-for="p in printers" :key="p.id" :value="p.id">{{ p.name }} ({{ displayStatus(p) }})</option></select>
        <div v-if="selectedPrinter" class="printer-details mt-4">
          <div class="sys-info-item"><span class="sys-label">Hãng</span><span class="sys-val">{{ selectedPrinter.manufacturer }}</span></div>
          <div class="sys-info-item"><span class="sys-label">Model</span><span class="sys-val">{{ selectedPrinter.model || 'Chưa cấu hình' }}</span></div>
          <div class="sys-info-item"><span class="sys-label">IP / Port</span><span class="sys-val">{{ selectedPrinter.ip_address }}:{{ selectedPrinter.port }}</span></div>
          <div class="sys-info-item"><span class="sys-label">Command language</span><span class="sys-val">{{ selectedPrinter.command_language || 'Chưa cấu hình' }}</span></div>
          <div class="sys-info-item"><span class="sys-label">Trạng thái</span><span class="badge" :class="statusClass(displayStatus(selectedPrinter))">{{ displayStatus(selectedPrinter) }}</span></div>
          <button class="btn btn-secondary mt-4" :disabled="isPrinting || !isOperator" @click="testPrint">In thử</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title">In từ mẫu nhãn</h3></div>
        <select v-model="selectedTemplateName" class="form-select" @change="onTemplateChange"><option value="" disabled>-- Chọn mẫu --</option><option v-for="t in templates" :key="t.id" :value="t.name">{{ t.name }}</option></select>
        <div v-for="key in templateVariables" :key="key" class="form-group mt-3"><label class="form-label">{{ key }}</label><input v-model="printVariables[key]" class="form-input" /></div>
        <div class="form-group mt-3"><label class="form-label">Số bản</label><input v-model.number="copies" type="number" min="1" max="1000" class="form-input" /></div>
        <button class="btn btn-primary mt-4" :disabled="isPrinting || !isOperator || !selectedTemplateName" @click="submitPrint">{{ isPrinting ? 'Đang gửi...' : 'In nhãn' }}</button>
      </div>
      <div class="card" style="grid-column: span 2"><div class="card-header"><h3 class="card-title">Print jobs</h3></div>
        <div class="table-container"><table class="table"><thead><tr><th>Job ID</th><th>Tên Job</th><th>Máy in</th><th>Số lượng</th><th>Trạng thái</th><th>Mode</th><th>Thời gian</th></tr></thead><tbody>
          <tr v-if="!jobs.length"><td colspan="7" class="text-center text-muted py-4">Không có dữ liệu</td></tr>
          <tr v-for="job in jobs" :key="job.id"><td class="text-mono text-xs">{{ job.id.substring(0,8) }}</td><td>{{ job.job_name }}</td><td>{{ job.printer_name }}</td><td>{{ job.copies }}</td><td><span class="badge" :class="jobMode(job) === 'DEMO' && job.status === 'completed' ? 'badge-warning' : statusClass(job.status)">{{ jobMode(job) === 'DEMO' && job.status === 'completed' ? 'DEMO COMPLETED' : job.status }}</span></td><td><span class="badge" :class="jobMode(job) === 'DEMO' ? 'badge-warning' : 'badge-neutral'">{{ jobMode(job) }}</span></td><td>{{ formatTime(job.created_at) }}</td></tr>
        </tbody></table></div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import api from '@/composables/useApi'
const authStore=useAuthStore(); const isOperator=computed(()=>authStore.isOperator)
const printers=ref([]),templates=ref([]),jobs=ref([]),selectedPrinterId=ref(''),selectedTemplateName=ref(''),printVariables=ref({}),copies=ref(1),isPrinting=ref(false)
const selectedPrinter=computed(()=>printers.value.find(p=>p.id===selectedPrinterId.value))
const selectedTemplate=computed(()=>templates.value.find(t=>t.name===selectedTemplateName.value))
const templateVariables=computed(()=>{try{return JSON.parse(selectedTemplate.value?.variables||'[]')}catch{return[]}})
function displayStatus(p){return p.connection_status==='demo'?'DEMO':String(p.connection_status||'offline').toUpperCase()}
function statusClass(s){return ({ONLINE:'badge-success',DEMO:'badge-warning',completed:'badge-success',failed:'badge-danger'})[s]||'badge-neutral'}
function jobMode(job){try{return String(JSON.parse(job.metadata||'{}').mode||'UNKNOWN').toUpperCase()}catch{return 'UNKNOWN'}}
function onTemplateChange(){printVariables.value={};templateVariables.value.forEach(k=>printVariables.value[k]='')}
async function loadJobs(){if(!selectedPrinterId.value)return;const r=await api.get(`/printers/jobs?printerId=${selectedPrinterId.value}&limit=20`);jobs.value=r.data.data||[]}
async function loadData(){const [p,t]=await Promise.all([api.get('/printers'),api.get('/printers/templates')]);printers.value=p.data.data||[];templates.value=t.data.data||[];if(!selectedPrinterId.value&&printers.value.length)selectedPrinterId.value=printers.value[0].id;await loadJobs()}
async function submitPrint(){isPrinting.value=true;try{await api.post(`/printers/${selectedPrinterId.value}/print`,{templateName:selectedTemplateName.value,variables:printVariables.value,copies:copies.value});await loadJobs();alert('Đã gửi lệnh in thành công!')}catch(e){alert('Lỗi in: '+(e.response?.data?.error||e.message))}finally{isPrinting.value=false}}
async function testPrint(){isPrinting.value=true;try{await api.post(`/printers/${selectedPrinterId.value}/test`);await loadJobs()}catch(e){alert('Lỗi in thử: '+(e.response?.data?.error||e.message))}finally{isPrinting.value=false}}
function formatTime(ts){return ts?new Date(ts).toLocaleString('vi-VN'):'-'}
onMounted(loadData)
</script>
<style scoped>.printer-details{display:flex;flex-direction:column;gap:var(--space-2)}.sys-info-item{display:flex;justify-content:space-between;align-items:center}.sys-label{font-size:var(--text-sm);color:var(--color-text-muted)}.sys-val{font-size:var(--text-sm);font-weight:500}</style>
