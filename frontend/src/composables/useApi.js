import axios from 'axios'
import { useAuthStore } from '@/stores/auth'

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

// Request interceptor - add auth token
api.interceptors.request.use((config) => {
  const auth = useAuthStore()
  const url = config.url || ''
  const isAuthCall = url.includes('/auth/login') || url.includes('/auth/refresh')
  if (!isAuthCall && auth.getToken()) {
    config.headers.Authorization = `Bearer ${auth.getToken()}`
  }
  return config
})

// Response interceptor - handle 401 and refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    const url = originalRequest?.url || ''
    const isAuthCall = url.includes('/auth/login') || url.includes('/auth/refresh') || url.includes('/auth/logout')

    // Login 401 = sai mật khẩu. Không được gọi refresh token (gây vòng lặp 401 → 429).
    if (error.response?.status === 401 && !originalRequest._retry && !isAuthCall) {
      originalRequest._retry = true
      try {
        const auth = useAuthStore()
        await auth.refreshAccessToken()
        originalRequest.headers.Authorization = `Bearer ${auth.getToken()}`
        return api(originalRequest)
      } catch {
        const auth = useAuthStore()
        await auth.logout()
        window.location.href = '/login'
      }
    }

    return Promise.reject(error)
  }
)

export default api
