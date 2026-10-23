import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', console: 'readonly', crypto: 'readonly', indexedDB: 'readonly', URL: 'readonly', AudioContext: 'readonly', OfflineAudioContext: 'readonly', MediaStreamAudioSourceNode: 'readonly', AudioWorkletNode: 'readonly', Blob: 'readonly', File: 'readonly', IDBRequest: 'readonly', IDBTransaction: 'readonly', IDBDatabase: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
)
