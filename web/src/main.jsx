import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

// A successful boot clears the one-time "reload after a new version" guard.
setTimeout(() => { try { sessionStorage.removeItem('lr-chunk-reload'); } catch { /* storage blocked */ } }, 15000);

// Remember who invited this visitor (?ref=slug) until they finish signing up.
try { const ref = new URLSearchParams(window.location.search).get('ref'); if (ref && /^[a-z0-9-]{2,64}$/i.test(ref)) localStorage.setItem('lr-ref', ref.toLowerCase()); } catch { /* storage blocked */ }
