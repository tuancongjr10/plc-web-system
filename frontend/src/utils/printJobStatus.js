const PRINT_JOB_STATUS = Object.freeze({
  pending: Object.freeze({ label: 'Pending', className: 'badge-neutral' }),
  rendered: Object.freeze({ label: 'Rendered', className: 'badge-brand' }),
  submitted: Object.freeze({ label: 'Submitted', className: 'badge-brand' }),
  printing: Object.freeze({ label: 'Printing', className: 'badge-warning' }),
  completed: Object.freeze({ label: 'Completed', className: 'badge-success' }),
  failed: Object.freeze({ label: 'Failed', className: 'badge-danger' }),
  cancelled: Object.freeze({ label: 'Cancelled', className: 'badge-neutral' }),
  unknown: Object.freeze({ label: 'Unknown', className: 'badge-neutral' }),
})

export function normalizePrintJobStatus(status) {
  const normalized = String(status ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(PRINT_JOB_STATUS, normalized) ? normalized : 'unknown'
}

export function getPrintJobStatusLabel(status) {
  return PRINT_JOB_STATUS[normalizePrintJobStatus(status)].label
}

export function getPrintJobStatusClass(status) {
  return PRINT_JOB_STATUS[normalizePrintJobStatus(status)].className
}

export { PRINT_JOB_STATUS }
