import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { useAuthStore } from './auth'

export const usePlcStore = defineStore('plc', () => {
  const devices = ref([])
  const tagValues = reactive({}) // tagId -> value info
  const alarms = ref([])
  const isLoading = ref(false)

  // WebSocket
  let ws = null
  const wsConnected = ref(false)

  function connectWebSocket() {
    const auth = useAuthStore()
    if (!auth.getToken()) return

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${auth.getToken()}`

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      wsConnected.value = true
      console.log('WebSocket connected')
    }

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      handleWsMessage(message)
    }

    ws.onclose = () => {
      wsConnected.value = false
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        if (useAuthStore().isLoggedIn) {
          connectWebSocket()
        }
      }, 5000)
    }

    ws.onerror = (err) => {
      console.error('WebSocket error:', err)
    }
  }

  function handleWsMessage({ type, payload }) {
    switch (type) {
      case 'plc:data':
        if (payload.tags) {
          payload.tags.forEach(tag => {
            tagValues[tag.tagId] = tag
          })
        }
        break

      case 'plc:command':
        if (payload?.command) {
          // last commanded state is already pushed via plc:data
        }
        break

      case 'plc:connected':
        updateDeviceStatus(payload.deviceId, 'connected', payload.isDemo)
        break

      case 'plc:disconnected':
        updateDeviceStatus(payload.deviceId, 'disconnected')
        break

      case 'plc:alarm':
        alarms.value.unshift({
          ...payload,
          id: Date.now(),
          timestamp: new Date().toISOString(),
        })
        // Keep max 50 alarms in memory
        if (alarms.value.length > 50) alarms.value.pop()
        break
    }
  }

  function updateDeviceStatus(deviceId, status, isDemo) {
    const device = devices.value.find(d => d.id === deviceId)
    if (device) {
      device.connection_status = status
      if (!device.liveStatus) device.liveStatus = {}
      device.liveStatus.connected = status === 'connected'
      if (isDemo !== undefined) device.liveStatus.isDemo = isDemo
    }
  }

  function sendWsMessage(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }))
    }
  }

  function writePlcTag(deviceId, tagId, value) {
    sendWsMessage('plc:write', { deviceId, tagId, value })
  }

  function disconnectWebSocket() {
    if (ws) {
      ws.close()
      ws = null
    }
    wsConnected.value = false
  }

  return {
    devices, tagValues, alarms, isLoading, wsConnected,
    connectWebSocket, disconnectWebSocket, writePlcTag, handleWsMessage,
  }
})
