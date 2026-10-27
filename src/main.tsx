import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { SERVICE_WORKER_RELOAD_KEY, SERVICE_WORKER_UPDATE_EVENT } from './platform/serviceWorker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const announceUpdate = () => window.dispatchEvent(new Event(SERVICE_WORKER_UPDATE_EVENT))
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (window.sessionStorage.getItem(SERVICE_WORKER_RELOAD_KEY) !== '1') return
      window.sessionStorage.removeItem(SERVICE_WORKER_RELOAD_KEY)
      window.location.reload()
    })
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) announceUpdate()
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate()
        })
      })
    })
  })
}
