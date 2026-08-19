import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, title: 'Đăng nhập' },
  },
  {
    path: '/',
    component: () => import('@/components/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: '/dashboard',
      },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: 'Dashboard', icon: '📊' },
      },
      {
        path: 'plc',
        name: 'PLC',
        component: () => import('@/views/PlcView.vue'),
        meta: { title: 'PLC Monitor', icon: '🔌' },
      },
      {
        path: 'printer',
        name: 'Printer',
        component: () => import('@/views/PrinterView.vue'),
        meta: { title: 'Máy in Godex', icon: '🖨️' },
      },
      {
        path: 'scanner',
        name: 'Scanner',
        component: () => import('@/views/ScannerView.vue'),
        meta: { title: 'Scanner / QR', icon: '📷' },
      },
      {
        path: 'logs',
        name: 'Logs',
        component: () => import('@/views/LogsView.vue'),
        meta: { title: 'Lịch sử', icon: '📋' },
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: 'Cài đặt', icon: '⚙️', roles: ['admin'] },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/dashboard',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// Navigation guard
router.beforeEach((to, _from, next) => {
  const auth = useAuthStore()

  if (to.meta.public) {
    if (auth.isLoggedIn && to.name === 'Login') {
      return next('/dashboard')
    }
    return next()
  }

  if (!auth.isLoggedIn) {
    return next({ name: 'Login', query: { redirect: to.fullPath } })
  }

  // Role check
  if (to.meta.roles && !to.meta.roles.includes(auth.user?.role)) {
    return next('/dashboard')
  }

  document.title = `${to.meta.title || 'PLC System'} | PLC Web Control`
  next()
})

export default router
