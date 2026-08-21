<template>
  <div class="app-layout">
    <!-- Sidebar Navigation -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <div class="logo-block">
          <div class="logo-icon">⚡</div>
          <div v-if="!sidebarCollapsed" class="logo-text">
            <span class="logo-title">PLC System</span>
            <span class="logo-sub">v1.0.0</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-icon sidebar-toggle" @click="sidebarCollapsed = !sidebarCollapsed"
          :data-tooltip="sidebarCollapsed ? 'Expand menu' : 'Collapse menu'">
          {{ sidebarCollapsed ? '▶' : '◀' }}
        </button>
      </div>

      <!-- Connection status -->
      <div class="sidebar-ws-status" v-if="!sidebarCollapsed">
        <div class="status-dot" :class="plcStore.wsConnected ? 'online' : 'offline'"></div>
        <span class="text-xs text-muted">{{ plcStore.wsConnected ? 'WebSocket ON' : 'Disconnected' }}</span>
      </div>

      <!-- Navigation Items -->
      <nav class="sidebar-nav">
        <router-link
          v-for="route in navRoutes"
          :key="route.path"
          :to="route.path"
          class="nav-item"
          :data-tooltip="sidebarCollapsed ? route.meta.title : undefined"
          active-class="active"
        >
          <span class="nav-icon">{{ route.meta.icon }}</span>
          <span v-if="!sidebarCollapsed" class="nav-label">{{ route.meta.title }}</span>
          <span v-if="!sidebarCollapsed && route.name === 'PLC' && activeAlarms > 0"
            class="badge badge-danger nav-badge">{{ activeAlarms }}</span>
        </router-link>
      </nav>

      <!-- Bottom: User Profile -->
      <div class="sidebar-footer">
        <div class="user-block" :class="{ compact: sidebarCollapsed }">
          <div class="user-avatar">{{ userInitial }}</div>
          <div v-if="!sidebarCollapsed" class="user-info">
            <span class="user-name">{{ auth.user?.fullName }}</span>
            <span class="user-role badge" :class="auth.isAdmin ? 'badge-brand' : 'badge-neutral'">
              {{ auth.user?.role }}
            </span>
          </div>
          <button v-if="!sidebarCollapsed" class="btn btn-ghost btn-icon ml-auto" @click="handleLogout"
            data-tooltip="Sign Out">
            🚪
          </button>
        </div>
      </div>
    </aside>

    <!-- Main Content Area -->
    <div class="main-content">
      <!-- Top Bar -->
      <header class="topbar">
        <div class="topbar-left">
          <h1 class="page-route-title">{{ currentRoute.meta?.title }}</h1>
          <div class="breadcrumb">
            <span class="text-muted text-sm">PLC Web System</span>
            <span class="text-muted text-sm">›</span>
            <span class="text-sm">{{ currentRoute.meta?.title }}</span>
          </div>
        </div>
        <div class="topbar-right">
          <div class="topbar-time text-mono text-sm text-muted">{{ currentTime }}</div>
          <!-- Alarm bell -->
          <button class="btn btn-ghost btn-icon alarm-btn" @click="showAlarmPanel = !showAlarmPanel"
            v-if="activeAlarms > 0">
            🔔
            <span class="alarm-count">{{ activeAlarms }}</span>
          </button>
        </div>
      </header>

      <!-- Alarm Panel -->
      <transition name="slide-up">
        <div v-if="showAlarmPanel" class="alarm-panel">
          <div class="alarm-panel-header">
            <span class="font-semibold">⚠️ Active Alerts</span>
            <button class="btn btn-ghost btn-icon" @click="showAlarmPanel = false">✕</button>
          </div>
          <div v-for="alarm in plcStore.alarms.slice(0, 5)" :key="alarm.id" class="alarm-item">
            <div class="status-dot warning"></div>
            <span class="text-sm">{{ alarm.message }}</span>
          </div>
        </div>
      </transition>

      <!-- Page Content (router-view) -->
      <main class="page-content">
        <transition name="fade" mode="out-in">
          <router-view />
        </transition>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { usePlcStore } from '@/stores/plc'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const plcStore = usePlcStore()

const sidebarCollapsed = ref(false)
const showAlarmPanel = ref(false)
const currentTime = ref('')

let timeInterval = null

const navRoutes = [
  { path: '/dashboard', name: 'Dashboard', meta: { title: 'Dashboard', icon: '📊' } },
  { path: '/plc', name: 'PLC', meta: { title: 'Machine Control', icon: '🔌' } },
  { path: '/printer', name: 'Printer', meta: { title: 'Print Queue', icon: '🖨️' } },
  { path: '/scanner', name: 'Scanner', meta: { title: 'Scan & TraceCode', icon: '📷' } },
  { path: '/logs', name: 'Logs', meta: { title: 'Traceability', icon: '📋' } },
  ...(auth.isAdmin ? [{ path: '/settings', name: 'Settings', meta: { title: 'Device Registry', icon: '⚙️' } }] : []),
]

const currentRoute = computed(() => route)
const userInitial = computed(() => (auth.user?.fullName || 'U')[0].toUpperCase())
const activeAlarms = computed(() => plcStore.alarms.filter(a => !a.resolved).length)

function updateTime() {
  currentTime.value = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

async function handleLogout() {
  await auth.logout()
  plcStore.disconnectWebSocket()
  router.push('/login')
}

onMounted(() => {
  plcStore.connectWebSocket()
  updateTime()
  timeInterval = setInterval(updateTime, 1000)
})

onUnmounted(() => {
  clearInterval(timeInterval)
})
</script>

<style scoped>
/* Sidebar */
.sidebar {
  width: var(--sidebar-width);
  height: 100vh;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  transition: width var(--transition-slow);
  overflow: hidden;
  flex-shrink: 0;
  z-index: 100;
}

.sidebar.collapsed { width: var(--sidebar-collapsed); }

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);
  min-height: var(--topbar-height);
}

.logo-block {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  overflow: hidden;
}

.logo-icon {
  width: 32px;
  height: 32px;
  background: var(--color-brand-dim);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
  border: 1px solid #93c5fd;
}

.logo-text { display: flex; flex-direction: column; overflow: hidden; }
.logo-title { font-size: var(--text-sm); font-weight: 700; white-space: nowrap; }
.logo-sub { font-size: var(--text-xs); color: var(--color-text-muted); }

.sidebar-toggle { flex-shrink: 0; }

.sidebar-ws-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
}

/* Navigation */
.sidebar-nav {
  flex: 1;
  padding: var(--space-3) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: 500;
  transition: all var(--transition-fast);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  position: relative;
}

.nav-item:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.nav-item.active {
  background: var(--color-brand-dim);
  color: var(--color-brand);
}

.nav-item.active .nav-icon { filter: none; }

.nav-icon {
  font-size: 1.1rem;
  width: 24px;
  text-align: center;
  flex-shrink: 0;
}

.nav-label { flex: 1; }

.nav-badge {
  font-size: var(--text-xs);
  padding: 0.1rem 0.4rem;
  animation: pulse-dot 1.5s infinite;
}

/* Sidebar Footer */
.sidebar-footer {
  padding: var(--space-3) var(--space-2);
  border-top: 1px solid var(--color-border);
}

.user-block {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.user-block.compact { justify-content: center; }

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--color-brand-dim);
  color: var(--color-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: 700;
  flex-shrink: 0;
  border: 1px solid #93c5fd;
}

.user-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow: hidden;
  flex: 1;
}

.user-name {
  font-size: var(--text-sm);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Topbar */
.topbar {
  height: var(--topbar-height);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-6);
  flex-shrink: 0;
}

.topbar-left { display: flex; flex-direction: column; gap: 2px; }
.page-route-title { font-size: var(--text-md); font-weight: 600; line-height: 1; }
.breadcrumb { display: flex; align-items: center; gap: var(--space-2); }
.topbar-right { display: flex; align-items: center; gap: var(--space-3); }
.topbar-time { letter-spacing: 0.05em; }

.alarm-btn { position: relative; }
.alarm-count {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 14px;
  height: 14px;
  background: var(--color-danger);
  border-radius: 50%;
  font-size: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  animation: pulse-dot 1s infinite;
}

/* Alarm Panel */
.alarm-panel {
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-warning);
  padding: var(--space-3) var(--space-6);
}

.alarm-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
}

.alarm-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
}

.alarm-item:last-child { border-bottom: none; }
</style>
