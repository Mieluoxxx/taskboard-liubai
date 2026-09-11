import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 只允许 Supabase 公开配置进入客户端；默认的 VITE_ 前缀会把任何 VITE_* 变量内联进 bundle。
  envPrefix: ['VITE_SUPABASE_'],
})
