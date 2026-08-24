// Kept in sync with package.json's "version" field.
const APP_VERSION = '0.2.1-beta'

export function Footer() {
  return (
    <footer>
      <div className="container footer-grid">
        <div className="footer-col footer-brand-col">
          <div className="footer-brand">
            <img src="/logo.svg" alt="" width={20} height={20} />
            <span>Squish</span>
          </div>
          <p>Privacy-first image &amp; PDF toolkit. No uploads, completely local.</p>
        </div>

        <div className="footer-col">
          <h4>Project</h4>
          <a href="https://github.com/ParasSharma2306/squish" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://github.com/sponsors/ParasSharma2306" target="_blank" rel="noreferrer">
            Sponsor
          </a>
          <a href="/privacy.html">Privacy Policy</a>
          <a href="/terms.html">Terms of Use</a>
        </div>

        <div className="footer-col">
          <h4>More from Paras</h4>
          <a href="https://parassharma.com" target="_blank" rel="noreferrer">
            Portfolio
          </a>
          <a href="https://chatlume.parassharma.in" target="_blank" rel="noreferrer">
            ChatLume
          </a>
          <a href="https://zarya.parassharma.in" target="_blank" rel="noreferrer">
            Zarya
          </a>
          <a href="https://backdoor.parassharma.in" target="_blank" rel="noreferrer">
            Backdoor
          </a>
        </div>
      </div>

      <div className="footer-bottom">
        &copy; {new Date().getFullYear()}{' '}
        <a href="https://parassharma.com" target="_blank" rel="noreferrer">
          Paras Sharma
        </a>
        . MIT licensed &amp; open source. <span style={{ opacity: 0.7 }}>v{APP_VERSION}</span>
      </div>
    </footer>
  )
}
