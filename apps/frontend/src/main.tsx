import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import { isDev } from '@genshin-optimizer/common/util'
import React from 'react'
import { createRoot } from 'react-dom/client'
import ReactGA from 'react-ga4'
import App from './app/App'
import './index.css'

ReactGA.initialize(process.env.NX_GA_TRACKINGID as any, {
  testMode: isDev,
})
// Multiple tabs are supported: the database keeps itself in sync across them via
// `storage` events (see `attachTabSync`), so opening a second tab no longer tears
// down the first - which used to kill any optimization running in it.
const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
