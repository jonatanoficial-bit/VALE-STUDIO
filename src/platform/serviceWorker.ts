/** Browser event emitted when a new Vale Studio shell is waiting to be applied. */
export const SERVICE_WORKER_UPDATE_EVENT = 'vale-studio:update-ready'

/**
 * A reload may only follow a user-approved update. This key lets main.tsx
 * distinguish that case from the first service-worker installation.
 */
export const SERVICE_WORKER_RELOAD_KEY = 'vale-studio:reload-after-update'

/** Tauri uses WebView2 with an http-like internal origin. It must never run
 * the browser PWA service worker because the bundled application is already
 * local and an old cache can intercept its first page. */
export const PWA_SERVICE_WORKER_AVAILABLE = typeof window !== 'undefined'
  && 'serviceWorker' in navigator
  && !Boolean((window as Window & { __TAURI__?: unknown }).__TAURI__)
  && window.location.hostname !== 'tauri.localhost'
