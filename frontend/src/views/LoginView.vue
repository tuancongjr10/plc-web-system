<template>
  <div class="login-page">
    <div class="login-bg">
      <div class="login-grid"></div>
    </div>

    <div class="login-container">
      <div class="login-card">
        <!-- Logo & Title -->
        <div class="login-header">
          <div class="login-logo">⚡</div>
          <h1 class="login-title">PLC Web Control</h1>
          <p class="login-subtitle">Hệ thống điều khiển PLC, máy in & scanner</p>
        </div>

        <!-- Form -->
        <form class="login-form" @submit.prevent="handleLogin">
          <div class="form-group">
            <label class="form-label" for="username">Tên đăng nhập</label>
            <div class="input-with-icon">
              <span class="input-icon">👤</span>
              <input
                id="username"
                v-model="form.username"
                type="text"
                class="form-input"
                placeholder="admin"
                autocomplete="username"
                :disabled="isLoading"
                required
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="password">Mật khẩu</label>
            <div class="input-with-icon">
              <span class="input-icon">🔒</span>
              <input
                id="password"
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                class="form-input"
                placeholder="••••••••"
                autocomplete="current-password"
                :disabled="isLoading"
                required
              />
              <button type="button" class="input-toggle" @click="showPassword = !showPassword">
                {{ showPassword ? '👁️' : '🙈' }}
              </button>
            </div>
          </div>

          <div v-if="error" class="alert alert-danger">
            <span>⚠️</span>
            <span>{{ error }}</span>
          </div>

          <button type="submit" class="btn btn-primary w-full btn-login" :disabled="isLoading">
            <div v-if="isLoading" class="spinner"></div>
            <span>{{ isLoading ? 'Đang đăng nhập...' : 'Đăng nhập' }}</span>
          </button>
        </form>

        <!-- System Info -->
        <div class="login-footer">
          <div class="system-info">
            <div class="sys-info-item">
              <span class="sys-label">PLC</span>
              <span class="sys-val text-success">Siemens S7-1200 TCP</span>
            </div>
            <div class="sys-info-item">
              <span class="sys-label">Máy in</span>
              <span class="sys-val text-warning">Godex Printer</span>
            </div>
            <div class="sys-info-item">
              <span class="sys-label">Scanner</span>
              <span class="sys-val text-brand">QR / Barcode</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const form = reactive({ username: '', password: '' })
const isLoading = ref(false)
const error = ref('')
const showPassword = ref(false)

async function handleLogin() {
  if (!form.username || !form.password) return
  isLoading.value = true
  error.value = ''

  try {
    await auth.login(form.username, form.password)
    const redirect = route.query.redirect || '/dashboard'
    router.push(redirect)
  } catch (err) {
    error.value = err.response?.data?.error || 'Đăng nhập thất bại. Kiểm tra lại thông tin.'
  } finally {
    isLoading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.login-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 30% 40%, hsl(210, 50%, 12%) 0%, var(--color-bg-primary) 60%);
}

/* Subtle grid background */
.login-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(hsl(220, 15%, 22% / 0.3) 1px, transparent 1px),
    linear-gradient(90deg, hsl(220, 15%, 22% / 0.3) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(ellipse at center, black 40%, transparent 80%);
}

.login-container {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 420px;
  padding: var(--space-4);
}

.login-card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  padding: var(--space-10) var(--space-8);
  box-shadow: var(--shadow-lg), 0 0 60px hsl(210, 80%, 40% / 0.1);
}

.login-header {
  text-align: center;
  margin-bottom: var(--space-8);
}

.login-logo {
  width: 64px;
  height: 64px;
  background: var(--color-brand-dim);
  border: 2px solid hsl(210, 60%, 30%);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  margin: 0 auto var(--space-4);
  box-shadow: 0 0 30px hsl(210, 90%, 55% / 0.2);
}

.login-title {
  font-size: var(--text-xl);
  font-weight: 700;
  margin-bottom: var(--space-2);
}

.login-subtitle {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.input-with-icon {
  position: relative;
  display: flex;
  align-items: center;
}

.input-icon {
  position: absolute;
  left: 0.75rem;
  font-size: 1rem;
  pointer-events: none;
  z-index: 1;
}

.input-with-icon .form-input {
  padding-left: 2.5rem;
}

.input-toggle {
  position: absolute;
  right: 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  font-size: 1rem;
  border-radius: var(--radius-sm);
}

.btn-login {
  height: 44px;
  font-size: var(--text-md);
  margin-top: var(--space-2);
  gap: var(--space-3);
}

.login-footer {
  margin-top: var(--space-8);
  padding-top: var(--space-6);
  border-top: 1px solid var(--color-border);
}

.system-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sys-info-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sys-label {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.sys-val {
  font-size: var(--text-xs);
  font-weight: 600;
}
</style>
