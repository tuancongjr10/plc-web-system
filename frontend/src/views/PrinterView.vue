<template>
  <div>
    <div class="page-header"><h2 class="page-title">🖨️ Printer & Print Queue Management</h2><button class="btn btn-secondary" @click="loadData">🔄 Refresh</button></div>
    <div v-if="loadError" class="card mb-4" style="border-color: var(--color-danger)"><div class="text-danger text-sm">Unable to load printer data: {{ loadError }}</div></div>
    <div class="grid" style="grid-template-columns: 1fr; gap: var(--space-6)">
      <div class="card">
        <div class="card-header"><h3 class="card-title">Printers</h3></div>
        <select v-model="selectedPrinterId" class="form-select" @change="onPrinterChange"><option v-for="p in printers" :key="p.id" :value="p.id">{{ p.name }} ({{ displayStatus(p) }})</option></select>
        <div v-if="selectedPrinter" class="printer-details mt-4">
          <div class="form-group"><label class="form-label">Windows Print Queue</label><select v-model="queueName" class="form-select" :disabled="!authStore.isAdmin"><option value="" disabled>-- Select Queue --</option><option v-for="queue in queues" :key="queue.queueName" :value="queue.queueName">{{ queue.queueName }}</option></select></div>
          <label class="flex items-center gap-2 text-sm"><input v-model="isDefault" type="checkbox" :disabled="!authStore.isAdmin" /> Default Printer</label>
          <button v-if="authStore.isAdmin" class="btn btn-primary" :disabled="isSavingQueue || !queueName" @click="saveQueue">{{ isSavingQueue ? 'Saving...' : 'Save Queue Configuration' }}</button>
          <div class="sys-info-item"><span class="sys-label">Print mode</span><span class="sys-val">{{ selectedPrinter.print_mode || 'WINDOWS_QUEUE' }}</span></div>
          <div class="sys-info-item"><span class="sys-label">Queue Configured</span><span class="sys-val">{{ selectedPrinter.queue_name || 'Not Configured' }}</span></div>
          <div class="sys-info-item"><span class="sys-label">Driver</span><span class="sys-val">{{ selectedQueue?.driverName || 'UNKNOWN' }}</span></div>
          <div class="sys-info-item"><span class="sys-label">Status</span><span class="badge" :class="printerHealthClass(displayStatus(selectedPrinter))">{{ displayStatus(selectedPrinter) }}</span></div>
          <div v-if="selectedPrinter.last_error" class="alert alert-danger text-xs">{{ selectedPrinter.last_error }}</div>
          <button class="btn btn-secondary mt-4" :disabled="isPrinting || !isOperator" @click="testPrint">Test Print</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title">PDF → Trace QR</h3></div>
        <p class="text-sm text-muted mb-4">Select an existing PDF to generate a separate TraceCode QR file. The source PDF is never printed, edited, or overwritten.</p>
        <div class="trace-grid">
          <div class="form-group">
            <label class="form-label">PDF document</label>
            <input class="form-input" type="file" accept=".pdf,application/pdf" @change="selectTracePdf" />
            <span class="text-xs text-muted">Selected file: {{ selectedTracePdf?.name || 'None' }}</span>
          </div>
          <div class="form-group"><label class="form-label">Product ID (optional)</label><input v-model.trim="traceForm.productId" class="form-input" /></div>
          <div class="form-group"><label class="form-label">Job ID (optional)</label><input v-model.trim="traceForm.productionJobId" class="form-input" /></div>
          <div class="form-group"><label class="form-label">Description (optional)</label><input v-model.trim="traceForm.description" class="form-input" maxlength="1000" /></div>
        </div>
        <button class="btn btn-primary mt-4" :disabled="!selectedTracePdf || isGeneratingTraceQr || !isOperator" @click="generateTraceQr">
          {{ isGeneratingTraceQr ? 'Generating...' : 'Generate Trace QR' }}
        </button>
        <div v-if="generatedTraceCode" class="text-sm mt-3">Generated TraceCode: <span class="text-mono font-medium">{{ generatedTraceCode }}</span></div>
      </div>
      <div class="card"><div class="card-header"><h3 class="card-title">Print jobs</h3></div>
        <div class="table-container"><table class="table"><thead><tr><th>Job ID</th><th>Job Name</th><th>Printer</th><th>Copies</th><th>Status</th><th>Mode</th><th>Created At</th></tr></thead><tbody>
          <tr v-if="!loadError && !jobs.length"><td colspan="7" class="text-center text-muted py-4">No Print Jobs</td></tr>
          <tr v-for="job in jobs" :key="job.id"><td class="text-mono text-xs">{{ job.id.substring(0,8) }}</td><td>{{ job.job_name }}</td><td>{{ job.printer_name }}</td><td>{{ job.copies }}</td><td><span class="badge" :class="getPrintJobStatusClass(job.status)">{{ getPrintJobStatusLabel(job.status) }}</span></td><td><span class="badge" :class="jobMode(job) === 'RAW_TCP_LEGACY' ? 'badge-warning' : 'badge-brand'">{{ jobMode(job) }}</span></td><td>{{ formatTime(job.created_at) }}</td></tr>
        </tbody></table></div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import api, { interactivePrintRequestConfig } from '@/composables/useApi'
import { getPrintJobStatusClass, getPrintJobStatusLabel } from '@/utils/printJobStatus'
const authStore=useAuthStore(); const isOperator=computed(()=>authStore.isOperator)
const printers=ref([]),jobs=ref([]),queues=ref([]),selectedPrinterId=ref(''),isPrinting=ref(false)
const queueName=ref(''),isDefault=ref(false),isSavingQueue=ref(false)
const loadError=ref('')
const selectedTracePdf=ref(null),isGeneratingTraceQr=ref(false),generatedTraceCode=ref('')
const traceForm=ref({productId:'',productionJobId:'',description:''})
const selectedPrinter=computed(()=>printers.value.find(p=>p.id===selectedPrinterId.value))
const selectedQueue=computed(()=>queues.value.find(q=>q.queueName===selectedPrinter.value?.queue_name))
function displayStatus(p){if(!p.queue_name)return 'Not Configured';const status=String(p.connection_status||'unknown').toLowerCase();return status.charAt(0).toUpperCase()+status.slice(1)}
function printerHealthClass(s){return ({ONLINE:'badge-success',PRINTING:'badge-warning',ERROR:'badge-danger',OFFLINE:'badge-danger'})[String(s||'').toUpperCase()]||'badge-neutral'}
function jobMode(job){try{return String(JSON.parse(job.metadata||'{}').mode||'UNKNOWN').toUpperCase()}catch{return 'UNKNOWN'}}
async function loadJobs(){if(!selectedPrinterId.value)return;try{const r=await api.get(`/printers/jobs?printerId=${selectedPrinterId.value}&limit=20`);jobs.value=r.data.data||[]}catch(e){loadError.value=e.response?.data?.error||e.message||'Unable to load print jobs'}}
async function onPrinterChange(){queueName.value=selectedPrinter.value?.queue_name||'';isDefault.value=Boolean(selectedPrinter.value?.is_default);await loadJobs()}
async function loadData(){loadError.value='';try{const [p,q]=await Promise.all([api.get('/printers'),api.get('/printers/available-queues')]);printers.value=p.data.data||[];queues.value=q.data.data||[];if(!selectedPrinterId.value&&printers.value.length)selectedPrinterId.value=printers.value[0].id;queueName.value=selectedPrinter.value?.queue_name||'';isDefault.value=Boolean(selectedPrinter.value?.is_default);await loadJobs()}catch(e){loadError.value=e.response?.data?.error||e.message||'Unable to load data'}}
async function saveQueue(){isSavingQueue.value=true;try{await api.patch(`/printers/${selectedPrinterId.value}`,{queue_name:queueName.value,print_mode:'WINDOWS_QUEUE',is_enabled:1,is_default:isDefault.value?1:0});await loadData()}catch(e){alert('Unable to save queue: '+(e.response?.data?.error||e.message))}finally{isSavingQueue.value=false}}
async function testPrint(){isPrinting.value=true;try{await api.post(`/printers/${selectedPrinterId.value}/test`,undefined,interactivePrintRequestConfig);await loadJobs()}catch(e){alert('Unable to submit test print: '+(e.response?.data?.error||e.message))}finally{isPrinting.value=false}}
function selectTracePdf(event){selectedTracePdf.value=event.target.files?.[0]||null;generatedTraceCode.value=''}
function traceDownloadName(disposition, sourceName){const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition||'')?.[1];if(encoded){try{return decodeURIComponent(encoded)}catch{}}const plain=/filename="?([^";]+)"?/i.exec(disposition||'')?.[1];if(plain)return plain;return `QR_${String(sourceName||'document.pdf').replace(/\.pdf$/i,'')}.pdf`}
async function traceErrorMessage(error){const data=error.response?.data;if(data instanceof Blob){try{return JSON.parse(await data.text()).error||error.message}catch{return error.message}}return data?.error||error.message}
async function generateTraceQr(){if(!selectedTracePdf.value)return;isGeneratingTraceQr.value=true;try{const form=new FormData();form.append('pdf',selectedTracePdf.value);if(traceForm.value.productId)form.append('productId',traceForm.value.productId);if(traceForm.value.productionJobId)form.append('productionJobId',traceForm.value.productionJobId);if(traceForm.value.description)form.append('description',traceForm.value.description);const response=await api.post('/document-traces/generate',form,{timeout:0,responseType:'blob',headers:{'Content-Type':'multipart/form-data'}});generatedTraceCode.value=response.headers['x-trace-code']||'';const url=URL.createObjectURL(response.data);const link=document.createElement('a');link.href=url;link.download=traceDownloadName(response.headers['content-disposition'],selectedTracePdf.value.name);document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0)}catch(error){alert('Unable to generate Trace QR: '+await traceErrorMessage(error))}finally{isGeneratingTraceQr.value=false}}
function formatTime(ts){return ts?new Date(ts).toLocaleString('en-US'):'-'}
onMounted(loadData)
</script>
<style scoped>.printer-details{display:flex;flex-direction:column;gap:var(--space-2)}.sys-info-item{display:flex;justify-content:space-between;align-items:center}.sys-label{font-size:var(--text-sm);color:var(--color-text-muted)}.sys-val{font-size:var(--text-sm);font-weight:500}.trace-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}@media(max-width:768px){.trace-grid{grid-template-columns:1fr}}</style>
