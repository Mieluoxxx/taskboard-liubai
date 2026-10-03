import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

const AccountPage = lazy(() => import('./AccountPage'))
const accountRoute = ['/account', '/oauth/consent'].includes(window.location.pathname)

createRoot(document.getElementById('root')!).render(<StrictMode><Suspense fallback={<div role="status">…</div>}>{accountRoute ? <AccountPage /> : <App />}</Suspense></StrictMode>)
