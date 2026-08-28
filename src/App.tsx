import { lazy, Suspense, useState } from 'react'
import { ConvertTab } from './components/ConvertTab'
import { Footer } from './components/Footer'
import { Sponsors } from './components/Sponsors'

const PdfTab = lazy(() => import('./components/PdfTab').then((m) => ({ default: m.PdfTab })))
const CompressTab = lazy(() =>
  import('./components/CompressTab').then((m) => ({ default: m.CompressTab })),
)

type Tab = 'convert' | 'pdf' | 'compress'

const TABS: { id: Tab; label: string }[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'pdf', label: 'Image → PDF' },
  { id: 'compress', label: 'Compress' },
]

function App() {
  const [tab, setTab] = useState<Tab>('convert')

  return (
    <>
      <header className="site-header">
        <div className="container">
          <a className="brand" href="/">
            <img src="/logo.svg" alt="" />
            <span className="brand-name">Squish</span>
          </a>
          <p className="tagline">Convert, combine and compress images and PDFs, right in your browser.</p>

          {/* Squish's whole reason for existing is that the file never leaves
              the device, so it says so on the page itself rather than only in
              a policy nobody opens. */}
          <div className="trust-strip">
            <span className="trust-item">
              <span className="trust-dot" /> No uploads
            </span>
            <span className="trust-item">
              <span className="trust-dot" /> No accounts
            </span>
            <span className="trust-item">
              <span className="trust-dot" /> No tracking
            </span>
            <span className="trust-item">
              <span className="trust-dot" /> Works offline
            </span>
          </div>

          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`tab-btn${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main>
        <div className="container">
          <Suspense fallback={<div className="card">Loading…</div>}>
            {tab === 'convert' && <ConvertTab />}
            {tab === 'pdf' && <PdfTab />}
            {tab === 'compress' && <CompressTab />}
          </Suspense>
        </div>
      </main>

      <Sponsors />

      <Footer />
    </>
  )
}

export default App
