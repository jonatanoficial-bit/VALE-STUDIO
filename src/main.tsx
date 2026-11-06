import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { PWA_SERVICE_WORKER_AVAILABLE, SERVICE_WORKER_RELOAD_KEY, SERVICE_WORKER_UPDATE_EVENT } from './platform/serviceWorker'

type StartupBoundaryState = { failed: boolean }

class StartupBoundary extends Component<{ children: ReactNode }, StartupBoundaryState> {
  state: StartupBoundaryState = { failed: false }

  static getDerivedStateFromError(): StartupBoundaryState {
    return { failed: true }
  }

  render() {
    if (this.state.failed) return <main className="startup-recovery"><span>VALE STUDIO</span><h1>Não foi possível iniciar a interface.</h1><p>Feche o aplicativo e abra-o novamente. Se continuar, instale a versão mais recente disponibilizada no projeto.</p></main>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartupBoundary><App /></StartupBoundary>
  </StrictMode>,
)

if (PWA_SERVICE_WORKER_AVAILABLE) {
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
