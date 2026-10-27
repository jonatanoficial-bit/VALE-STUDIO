/** Browser event emitted when a new Vale Studio shell is waiting to be applied. */
export const SERVICE_WORKER_UPDATE_EVENT = 'vale-studio:update-ready'

/**
 * A reload may only follow a user-approved update. This key lets main.tsx
 * distinguish that case from the first service-worker installation.
 */
export const SERVICE_WORKER_RELOAD_KEY = 'vale-studio:reload-after-update'
