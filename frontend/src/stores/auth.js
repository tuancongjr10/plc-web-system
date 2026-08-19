import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/composables/useApi'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(JSON.parse(localStorage.getItem('user') || 'null'))
  const accessToken = ref(localStorage.getItem('accessToken') || '')
  const refreshToken = ref(localStorage.getItem('refreshToken') || '')

  const isLoggedIn = computed(() => !!accessToken.value && !!user.value)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const isOperator = computed(() => ['admin', 'operator'].includes(user.value?.role))

  async function login(username, password) {
    const response = await api.post('/auth/login', { username, password })
    const { accessToken: at, refreshToken: rt, user: u } = response.data.data

    accessToken.value = at
    refreshToken.value = rt
    user.value = u

    localStorage.setItem('accessToken', at)
    localStorage.setItem('refreshToken', rt)
    localStorage.setItem('user', JSON.stringify(u))

    return u
  }

  async function logout() {
    try {
      await api.post('/auth/logout', { refreshToken: refreshToken.value })
    } catch {}

    accessToken.value = ''
    refreshToken.value = ''
    user.value = null

    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    localStorage.removeItem('user')
  }

  async function refreshAccessToken() {
    try {
      const response = await api.post('/auth/refresh', { refreshToken: refreshToken.value })
      accessToken.value = response.data.data.accessToken
      localStorage.setItem('accessToken', accessToken.value)
      return accessToken.value
    } catch {
      await logout()
      throw new Error('Session expired')
    }
  }

  function getToken() {
    return accessToken.value
  }

  return { user, isLoggedIn, isAdmin, isOperator, login, logout, refreshAccessToken, getToken }
})
