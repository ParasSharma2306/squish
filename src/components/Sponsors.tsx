import dikshitabiswasAvatar from '../assets/sponsors/dikshitabiswas.png'
import nicolevdwAvatar from '../assets/sponsors/nicolevdw.png'

const SPONSORS_URL = 'https://github.com/sponsors/ParasSharma2306'

type Sponsor = { name: string; handle: string; amount: number; avatar: string }

// Kept in sync with the Sponsors table in README.md.
const SPONSORS: Sponsor[] = [
  { name: 'nicolevdw', handle: 'nicolevdw', amount: 30, avatar: nicolevdwAvatar },
  { name: 'Dikshita Biswas', handle: 'DikshitaBiswas', amount: 5, avatar: dikshitabiswasAvatar },
]

// A marquee only reads as continuous motion if the strip is wider than the
// viewport; with a handful of sponsors it otherwise scrolls a short row past a
// large empty gap. Repeating the list until there are at least this many cards
// keeps the belt full no matter how few sponsors there are.
const MIN_CARDS = 8

export function Sponsors() {
  if (SPONSORS.length === 0) return null

  const repeats = Math.ceil(MIN_CARDS / SPONSORS.length)
  const belt = Array.from({ length: repeats }, () => SPONSORS).flat()

  // The animation slides the track by exactly half its width and restarts, so
  // the belt is rendered twice: the second copy is what occupies the space the
  // first one vacates. Only the first copy is real content — every repeat
  // beyond the original sponsor list is decorative and hidden from assistive
  // tech and from the tab order.
  const card = (s: Sponsor, index: number, key: string) => {
    const decorative = index >= SPONSORS.length
    return (
      <a
        key={key}
        className="sponsor-card"
        href={`https://github.com/${s.handle}`}
        target="_blank"
        rel="noreferrer"
        aria-hidden={decorative || undefined}
        tabIndex={decorative ? -1 : undefined}
      >
        {/* The GitHub avatars are checked into the repo and bundled with the
            app rather than hotlinked from avatars.githubusercontent.com.
            Squish makes a hard promise that it issues no third-party requests,
            and an <img> pointing at GitHub would hand every visitor's IP to
            GitHub just to render a decorative circle. */}
        <img className="sponsor-avatar" src={s.avatar} alt="" width={40} height={40} loading="lazy" decoding="async" />
        <span className="sponsor-meta">
          <span className="sponsor-name">{s.name}</span>
          <span className="sponsor-amount">${s.amount}</span>
        </span>
      </a>
    )
  }

  return (
    <section className="sponsors" aria-labelledby="sponsors-heading">
      <div className="container">
        <div className="sponsors-head">
          <h2 id="sponsors-heading">Sponsors</h2>
          <a className="sponsors-cta" href={SPONSORS_URL} target="_blank" rel="noreferrer">
            Become a sponsor
          </a>
        </div>
        <p className="sponsors-sub">
          Squish is free and always will be. Thank you to the people who keep it going.
        </p>
      </div>

      <div className="sponsor-marquee">
        <div className="sponsor-track">
          {belt.map((s, i) => card(s, i, `a-${i}`))}
          {belt.map((s, i) => card(s, SPONSORS.length + i, `b-${i}`))}
        </div>
      </div>
    </section>
  )
}
