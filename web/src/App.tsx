import { useEffect, useRef, useState } from 'react'

const INSTALL = 'npm i -g plx-converter'
const GITHUB = 'https://github.com/samlehoy/plx'
const NPM = 'https://www.npmjs.com/package/plx-converter'
const DOCS = 'https://github.com/samlehoy/plx/tree/master/docs'
const ARL_GUIDE = 'https://github.com/samlehoy/plx/blob/master/docs/CONFIG.md#getting-the-cookies'
const NODEJS = 'https://nodejs.org'

type Tier = {
  id: string
  label: string
  ground: string
  ink: string
  title: string
  rule: string
  when: string
  units: string
}

const TIERS: Tier[] = [
  {
    id: 'exact',
    label: 'Exact',
    ground: '#EFEFEE',
    ink: '#0D0D0F',
    title: 'Exact',
    rule: 'Normalized title + first artist + duration within ±3s',
    when: 'Title and primary artist equal after normalization. Duration delta ≤ 3000 ms.',
    units: 'ms → s · ±3s window',
  },
  {
    id: 'fuzzy-duration',
    label: 'Fuzzy-duration',
    ground: '#0D0D0F',
    ink: '#EFEFEE',
    title: 'Fuzzy-duration',
    rule: 'Title + artist equal · duration ignored',
    when: 'Same normalized title and artist. Live edits and remasters still clear.',
    units: 'duration · discarded',
  },
  {
    id: 'fuzzy-title',
    label: 'Fuzzy-title',
    ground: '#E4E4E2',
    ink: '#0D0D0F',
    title: 'Fuzzy-title',
    rule: 'One normalized title contains the other + artist equal',
    when: 'Handles featured-artist suffixes and parentheticals without a scorer.',
    units: 'containment · bidirectional',
  },
]

/* ---------- proof chart: summed sines, honest endpoints ---------- */
const W = 560
const H = 280
const PAD = { t: 24, r: 16, b: 28, l: 36 }
const IW = W - PAD.l - PAD.r
const IH = H - PAD.t - PAD.b
const N = 19

function freeY(i: number): number {
  const t = i / (N - 1)
  const target = Math.min(1, t * 1.15)
  const noise = 0.012 * Math.sin(i * 1.7) + 0.008 * Math.sin(i * 3.1 + 0.4)
  return Math.max(0, Math.min(1, target + noise))
}

function fieldY(i: number): number {
  const t = i / (N - 1)
  const base = 0.473 * (1 - Math.exp(-3.2 * t))
  const wander =
    0.055 * Math.sin(i * 0.9 + 0.2) +
    0.035 * Math.sin(i * 1.6 + 1.1) +
    0.02 * Math.sin(i * 2.4 + 0.7)
  return Math.max(0, Math.min(1, base + wander * t))
}

function toPath(fn: (i: number) => number): string {
  let d = ''
  for (let i = 0; i < N; i++) {
    const x = PAD.l + (IW * i) / (N - 1)
    const y = PAD.t + IH * (1 - fn(i))
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '
  }
  return d.trim()
}

const gridLines = Array.from({ length: 5 }, (_, g) => PAD.t + (IH * g) / 4)

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduce(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduce
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

function CopyInstallPill({ size, scrollToId }: { size: 'sm' | 'lg'; scrollToId?: string }) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timeoutRef.current), [])

  const handleClick = async () => {
    const ok = await copyToClipboard(INSTALL)
    if (ok) {
      setCopied(true)
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1400)
    }
    if (scrollToId) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      document.getElementById(scrollToId)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' })
    }
  }

  const base = size === 'lg' ? 'pill meta h-12 px-6' : 'pill meta h-11 px-5'
  const color = copied ? 'bg-signal text-ground' : 'bg-ink text-ground hover:bg-signal'

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Copy install command: ${INSTALL}`}
      className={`${base} ${color}`}
    >
      {INSTALL}
      <span className="sr-only" role="status">
        {copied ? 'Command copied to clipboard' : ''}
      </span>
    </button>
  )
}

export default function App() {
  const reduce = useReducedMotion()
  const [tierIdx, setTierIdx] = useState(0)
  const tier = TIERS[tierIdx]

  useEffect(() => {
    if (reduce) return

    // Hero immediate reveal on rAF (not observed).
    const raf = requestAnimationFrame(() => {
      document.querySelectorAll('.plx-word, .hero-record').forEach((el) => {
        el.classList.add('shown')
      })
      document.querySelectorAll('#overview .reveal').forEach((el) => {
        el.classList.add('in')
      })
    })

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in')
            io.unobserve(entry.target)
          }
        })
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    )

    document.querySelectorAll('.reveal').forEach((el) => {
      if (el.closest('#overview')) return
      io.observe(el)
    })

    const pipe = document.getElementById('pipeline-svg')
    let pipeObs: IntersectionObserver | undefined
    if (pipe) {
      pipeObs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('in')
              pipeObs?.unobserve(entry.target)
            }
          })
        },
        { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
      )
      pipeObs.observe(pipe)
    }

    // Single passive rAF-throttled scroll listener.
    let ticking = false
    const plxBack = document.getElementById('plx-back')
    const plxFront = document.getElementById('plx-front')
    const heroRecord = document.getElementById('hero-record')
    const heroSection = document.getElementById('overview')
    const spinSection = document.getElementById('spin')
    const spinRecord = document.getElementById('spin-record')
    const spinMarquee = document.getElementById('spin-marquee')
    const spinReadout = document.getElementById('spin-readout')

    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        const scrollY = window.scrollY || window.pageYOffset

        if (heroSection && plxBack && plxFront && heroRecord) {
          const heroH = heroSection.offsetHeight
          const p = Math.min(1, Math.max(0, scrollY / (heroH * 0.85)))
          const wordShift = p * -36
          const recShift = p * 48
          const tWord = 'translate3d(0, calc(0.10em + ' + wordShift + 'px), 0)'
          plxBack.style.transform = tWord
          plxFront.style.transform = tWord
          heroRecord.style.transform = 'translate3d(0, ' + recShift + 'px, 0)'
        }

        if (spinSection && spinRecord && spinMarquee && spinReadout) {
          const rect = spinSection.getBoundingClientRect()
          const total = spinSection.offsetHeight - window.innerHeight
          const passed = -rect.top
          const progress = total > 0 ? Math.min(1, Math.max(0, passed / total)) : 0
          const deg = progress * 360
          spinRecord.style.transform =
            'translate3d(-50%, -50%, 0) rotate(' + deg.toFixed(2) + 'deg)'
          spinMarquee.style.transform = 'translate3d(' + -progress * 40 + '%, -50%, 0)'
          spinReadout.textContent = String(Math.round(deg)).padStart(3, '0') + '°'
        }
      })
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      pipeObs?.disconnect()
      window.removeEventListener('scroll', onScroll)
    }
  }, [reduce])

  const tierField = (opacity: number) => ({
    color: `color-mix(in srgb, currentColor ${Math.max(opacity, 62)}%, transparent)`,
  })

  return (
    <div className="min-h-screen bg-ground text-ink font-display antialiased">
      {/* NAV */}
      <header className="site-nav fixed top-0 left-0 right-0 z-50 h-16">
        <div className="h-full max-w-[1440px] mx-auto px-5 md:px-8 flex items-center justify-between gap-6">
          <a
            href="#overview"
            className="font-display font-extrabold text-[16px] tracking-[-0.035em] text-ink leading-none"
          >
            plx<span className="text-signal">.</span>
          </a>
          <nav className="hidden lg:flex items-center gap-7" aria-label="Primary">
            <a href="#overview" className="nav-link meta text-secondary">Overview</a>
            <a href="#convert" className="nav-link meta text-secondary">Convert</a>
            <a href="#match" className="nav-link meta text-secondary">Match</a>
            <a href="#spec" className="nav-link meta text-secondary">Spec</a>
            <a href="#install" className="nav-link meta text-secondary">Install</a>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="nav-link meta text-secondary">Github</a>
          </nav>
          <div className="lg:hidden flex items-center gap-2">
            <details className="relative group">
              <summary
                className="pill list-none cursor-pointer w-9 h-9 flex flex-col items-center justify-center gap-[3px] bg-ink [&::-webkit-details-marker]:hidden"
                aria-label="Open navigation menu"
              >
                <span className="block w-4 h-px bg-ground" />
                <span className="block w-4 h-px bg-ground" />
                <span className="block w-4 h-px bg-ground" />
              </summary>
              <nav
                className="hidden group-open:flex absolute right-0 top-[calc(100%+8px)] z-50 flex-col gap-1 bg-ground border hairline p-3 min-w-[160px]"
                aria-label="Primary"
              >
                <a href="#overview" className="nav-link meta text-secondary py-1">Overview</a>
                <a href="#convert" className="nav-link meta text-secondary py-1">Convert</a>
                <a href="#match" className="nav-link meta text-secondary py-1">Match</a>
                <a href="#spec" className="nav-link meta text-secondary py-1">Spec</a>
                <a href="#install" className="nav-link meta text-secondary py-1">Install</a>
                <a href={GITHUB} target="_blank" rel="noreferrer" className="nav-link meta text-secondary py-1">Github</a>
              </nav>
            </details>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section
        id="overview"
        className="hero-stage relative bg-stage pt-16"
        style={{ minHeight: 'calc(100svh)' }}
      >
        <div className="relative z-10 max-w-[1440px] mx-auto px-5 md:px-8 pt-14 md:pt-20 pb-[min(42vw,380px)] md:pb-[min(28vw,320px)] lg:pb-40 flex">
        <div className="w-full lg:w-[54%]">
          <p className="meta text-muted reveal reveal-d1">Spotify ⇄ Deezer</p>
          <h1 className="mt-5 font-extrabold text-[clamp(34px,5.1vw,74px)] leading-[0.92] tracking-[-0.045em] text-ink reveal reveal-d2">
            Move your playlist.
            <br />
            <span className="text-signal">No dev account.</span>
          </h1>
          <p className="mt-7 max-w-[38ch] text-[15px] md:text-[16px] leading-[1.55] text-secondary font-medium tracking-[-0.01em] reveal reveal-d3">
            plx moves Spotify → Deezer with browser sessions, not API keys—no Developer account,
            no OAuth app. One Deezer ARL cookie is enough. Reverse (Deezer → Spotify) is planned.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3 reveal reveal-d4">
            <CopyInstallPill size="sm" scrollToId="install" />
            <a
              href="#convert"
              className="pill meta h-11 px-5 border border-[rgba(13,13,15,.18)] bg-stage text-ink hover:border-signal hover:text-signal"
            >
              Try --dry-run
            </a>
          </div>
          <div className="mt-10 pt-5 border-t hairline space-y-2 reveal reveal-d5">
            <p className="meta-sm text-muted">
              <span className="text-signal">Read</span> — Spotify · anonymous
            </p>
            <p className="meta-sm text-muted">
              <span className="text-signal">Write</span> — Deezer · one ARL cookie
            </p>
            <p className="meta-sm text-muted">
              <span className="text-signal">Report</span> — CSV · per-track method
            </p>
          </div>
        </div>
        </div>

        {/* pinned edge metadata */}
        <div className="absolute top-[5.5rem] right-5 md:right-8 z-10 hidden xl:block pointer-events-none">
          <p className="meta-sm text-muted text-right">0.1.1 · cli</p>
        </div>

        {/* WORDMARK BACK (p, l) */}
        <div className="plx-word plx-back" id="plx-back" aria-hidden="true">
          <span className="letter">p</span>
          <span className="letter">l</span>
          <span className="letter letter-hidden">x</span>
        </div>

        {/* RECORD */}
        <img
          id="hero-record"
          className="hero-record"
          src="/vinyl.webp"
          alt=""
          width={1200}
          height={1200}
          draggable={false}
        />

        {/* WORDMARK FRONT (x only) */}
        <div className="plx-word plx-front" id="plx-front" aria-hidden="true">
          <span className="letter letter-hidden">p</span>
          <span className="letter letter-hidden">l</span>
          <span className="letter">x</span>
        </div>

        <div className="absolute bottom-5 left-5 md:left-8 z-[4] pointer-events-none">
          <p className="meta-sm text-muted">01 / overview</p>
        </div>
      </section>

      {/* INVERTED PROOF */}
      <section id="proof" className="bg-ink text-ground relative">
        <div className="max-w-[1440px] mx-auto px-5 md:px-8 py-20 md:py-28 lg:py-32">
          <div className="flex items-start justify-between gap-6 mb-12 md:mb-16">
            <p className="meta text-[rgba(239,239,238,0.55)] reveal">02 / proof</p>
            <p className="meta text-lift reveal">measured · same playlist</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-14 lg:gap-16 items-end">
            <div>
              <h2 className="font-extrabold text-[clamp(36px,4.6vw,68px)] leading-[0.92] tracking-[-0.045em] reveal">
                Free text beats.
                <br />
                Field syntax.
              </h2>
              <p className="mt-6 max-w-[38ch] text-[15px] md:text-[16px] leading-[1.6] text-[rgba(239,239,238,0.62)] font-medium tracking-[-0.006em] reveal reveal-d1">
                On a 19-track test playlist, Deezer field syntax matched nine titles. The same
                query as free-text words matched every track.
              </p>

              <div className="mt-12 flex items-end gap-4 reveal reveal-d2">
                <span className="font-extrabold tabular-nums text-[clamp(56px,9vw,132px)] leading-[0.78] tracking-[-0.055em] text-ground">
                  19/19
                </span>
                <span className="meta text-lift pb-2 md:pb-3">Tracks</span>
              </div>

              <div className="mt-8 pt-5 border-t border-[rgba(239,239,238,0.12)] space-y-2 reveal reveal-d3">
                <p className="meta-sm text-[rgba(239,239,238,0.55)]">
                  <span className="text-lift">Free-text</span> — 19 matched · flat trace
                </p>
                <p className="meta-sm text-[rgba(239,239,238,0.55)]">
                  <span className="text-[rgba(239,239,238,0.55)]">Field syntax</span> — 9 matched ·
                  wanders
                </p>
              </div>
            </div>

            <div className="reveal reveal-d2">
              <div className="flex items-center justify-between mb-4">
                <p className="meta-sm text-[rgba(239,239,238,0.55)]">Match rate · cumulative</p>
                <p className="meta-sm text-[rgba(239,239,238,0.55)]">n = 19</p>
              </div>
              <svg
                id="proof-chart"
                className="w-full h-auto"
                viewBox="0 0 560 280"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                role="img"
                aria-label="Line chart comparing free-text match rate against field syntax"
              >
                <g className="proof-grid">
                  {gridLines.map((gy) => (
                    <line key={gy} x1={PAD.l} x2={W - PAD.r} y1={gy} y2={gy} />
                  ))}
                </g>
                <path
                  d={toPath(fieldY)}
                  stroke="rgba(239,239,238,0.28)"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="square"
                />
                <path
                  d={toPath(freeY)}
                  stroke="#7C97FF"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="square"
                />
                <circle
                  cx={PAD.l + IW}
                  cy={PAD.t + IH * (1 - fieldY(N - 1))}
                  r="3.5"
                  fill="rgba(239,239,238,0.35)"
                />
                <circle
                  cx={PAD.l + IW}
                  cy={PAD.t + IH * (1 - freeY(N - 1))}
                  r="3.5"
                  fill="#7C97FF"
                />
              </svg>
              <div className="mt-4 flex items-center gap-6">
                <p className="meta-sm flex items-center gap-2 text-[rgba(239,239,238,0.5)]">
                  <span className="inline-block w-3 h-px bg-lift" /> Free text 19/19
                </p>
                <p className="meta-sm flex items-center gap-2 text-[rgba(239,239,238,0.5)]">
                  <span className="inline-block w-3 h-px bg-[rgba(239,239,238,0.35)]" /> Field
                  syntax 9/19
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* TECHNICAL DIAGRAM */}
      <section id="convert" className="bg-ground relative">
        <div className="max-w-[1440px] mx-auto px-5 md:px-8 py-20 md:py-28 lg:py-32">
          <div className="flex items-start justify-between gap-6 mb-12 md:mb-16">
            <p className="meta text-muted reveal">03 / convert</p>
            <p className="meta text-muted reveal">pipeline · to scale</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-14 lg:gap-20">
            <div>
              <h2 className="font-extrabold text-[clamp(34px,4.2vw,60px)] leading-[0.94] tracking-[-0.045em] reveal">
                Four modules.
                <br />
                One pass.
              </h2>
              <p className="mt-6 max-w-[40ch] text-[15px] md:text-[16px] leading-[1.55] text-secondary font-medium tracking-[-0.01em] reveal reveal-d1">
                The CLI walks a fixed pipeline: anonymous Spotify read, tiered match, Deezer
                write, CSV report. Every hop is a module with a single job.
              </p>

              <dl className="mt-12 reveal reveal-d2">
                <div className="def-row py-4 flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <dt className="meta text-signal-text">spotify.ts</dt>
                    <dd className="mt-1 text-[14px] text-secondary font-medium tracking-[-0.01em]">
                      Anonymous playlist read via Pathfinder, embed fallback at 100 tracks.
                    </dd>
                  </div>
                  <dd className="meta-sm text-muted shrink-0 tabular-nums">read</dd>
                </div>
                <div className="def-row py-4 flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <dt className="meta text-signal-text">deezer.ts</dt>
                    <dd className="mt-1 text-[14px] text-secondary font-medium tracking-[-0.01em]">
                      ARL cookie session. Search, add, and playlist create.
                    </dd>
                  </div>
                  <dd className="meta-sm text-muted shrink-0 tabular-nums">write</dd>
                </div>
                <div className="def-row py-4 flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <dt className="meta text-signal-text">converter.ts</dt>
                    <dd className="mt-1 text-[14px] text-secondary font-medium tracking-[-0.01em]">
                      Orchestrates the pass, ms→s duration units, CSV emission.
                    </dd>
                  </div>
                  <dd className="meta-sm text-muted shrink-0 tabular-nums">orch</dd>
                </div>
                <div className="def-row py-4 flex items-baseline justify-between gap-4 border-b hairline">
                  <div className="min-w-0">
                    <dt className="meta text-signal-text">matcher.ts</dt>
                    <dd className="mt-1 text-[14px] text-secondary font-medium tracking-[-0.01em]">
                      Three tiers: exact, fuzzy-duration (±3s), fuzzy-title.
                    </dd>
                  </div>
                  <dd className="meta-sm text-muted shrink-0 tabular-nums">match</dd>
                </div>
              </dl>
            </div>

            <div className="reveal reveal-d2">
              <div className="flex items-center justify-between mb-5">
                <p className="meta-sm text-muted">Conversion pipeline</p>
                <p className="meta-sm text-muted">units · hops</p>
              </div>
              <svg
                id="pipeline-svg"
                className="pipeline-svg w-full h-auto bg-stage"
                viewBox="0 0 560 420"
                xmlns="http://www.w3.org/2000/svg"
                role="img"
                aria-label="Technical diagram of the plx conversion pipeline"
              >
                <g className="pipe-guide" strokeDasharray="2 3">
                  <line x1="40" y1="40" x2="40" y2="380" />
                  <line x1="40" y1="380" x2="520" y2="380" />
                  <line x1="40" y1="80" x2="520" y2="80" />
                  <line x1="40" y1="160" x2="520" y2="160" />
                  <line x1="40" y1="240" x2="520" y2="240" />
                  <line x1="40" y1="320" x2="520" y2="320" />
                </g>

                <path
                  className="pipe-main"
                  pathLength={1}
                  d="M 56 80 L 200 80 L 200 160 L 340 160 L 340 240 L 420 240 L 420 320 L 504 320"
                />

                <g fill="#0D0D0F">
                  <rect x="48" y="72" width="16" height="16" />
                  <rect x="192" y="152" width="16" height="16" />
                  <rect x="412" y="312" width="16" height="16" />
                </g>

                <g>
                  <circle cx="340" cy="160" r="5" fill="#2F5BFF" />
                  <circle cx="340" cy="240" r="5" fill="#2F5BFF" />
                  <circle cx="420" cy="240" r="5" fill="#2F5BFF" />
                </g>

                <g className="pipe-leader">
                  <line x1="64" y1="80" x2="64" y2="52" />
                  <line x1="208" y1="160" x2="248" y2="160" />
                  <line x1="340" y1="155" x2="340" y2="118" />
                  <line x1="340" y1="245" x2="340" y2="278" />
                  <line x1="420" y1="235" x2="456" y2="210" />
                  <line x1="428" y1="320" x2="468" y2="320" />
                </g>

                <g
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="9"
                  letterSpacing="0.14em"
                  fill="#5F6067"
                  style={{ textTransform: 'uppercase' }}
                >
                  <text x="70" y="48">CLI args</text>
                  <text x="256" y="164">Spotify read</text>
                  <text x="256" y="176" fill="#43444A">Pathfinder → embed</text>
                  <text x="348" y="112" fill="#2F5BFF">exact</text>
                  <text x="348" y="292" fill="#2F5BFF">fuzzy-dur</text>
                  <text x="460" y="206" fill="#2F5BFF">fuzzy-title</text>
                  <text x="476" y="324">Deezer write</text>
                  <text x="40" y="400">CSV report · per-track method</text>
                </g>

                <path className="pipe-main" pathLength={1} d="M 504 320 L 504 360 L 200 360" />
                <rect x="192" y="352" width="16" height="16" fill="#0D0D0F" />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* STICKY RECORD STAGE */}
      <section id="spin" className="spin-stage bg-stage" aria-label="Scroll-driven record stage">
        <div className="spin-sticky">
          <div className="spin-marquee" id="spin-marquee" aria-hidden="true">
            {'SPOTIFY DEEZER  SPOTIFY DEEZER  SPOTIFY DEEZER  SPOTIFY DEEZER'}
          </div>
          <img
            id="spin-record"
            className="spin-record"
            src="/vinyl.webp"
            alt=""
            width={1200}
            height={1200}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
          <div className="absolute bottom-6 left-5 md:left-8 z-10">
            <p className="meta-sm text-muted">04 / transfer</p>
          </div>
          <div className="absolute bottom-6 right-5 md:right-8 z-10">
            <p className="meta-sm text-muted tabular-nums">
              <span id="spin-readout">000°</span> · counter-travel
            </p>
          </div>
        </div>
      </section>

      {/* MATCH TIER PICKER */}
      <section
        id="match"
        className="tier-section bg-ground text-ink relative"
        style={{ '--tier-ground': tier.ground, backgroundColor: tier.ground, color: tier.ink } as React.CSSProperties}
      >
        <div className="max-w-[1440px] mx-auto px-5 md:px-8 py-20 md:py-28 lg:py-32">
          <div className="flex items-start justify-between gap-6 mb-12 md:mb-16">
            <p className="meta reveal" style={tierField(48)}>05 / match</p>
            <p className="meta reveal" style={tierField(48)}>three tiers · first hit wins</p>
          </div>

          <h2 className="font-extrabold text-[clamp(34px,4.2vw,60px)] leading-[0.94] tracking-[-0.045em] max-w-[12ch] reveal">
            Pick a tier.
            <br />
            Repaint the field.
          </h2>
          <p
            className="mt-6 max-w-[42ch] text-[15px] md:text-[16px] leading-[1.55] font-medium tracking-[-0.01em] reveal reveal-d1"
            style={tierField(62)}
          >
            matcher.ts tries exact first, then relaxes duration, then title containment. Each
            tier is a deterministic rule — not a score.
          </p>

          <div className="mt-10 flex flex-wrap gap-3 reveal reveal-d2" role="group" aria-label="Match tiers">
            {TIERS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                className="tier-btn pill meta h-11 px-5"
                aria-pressed={i === tierIdx}
                onClick={() => setTierIdx(i)}
              >
                <span>{t.label}</span>
              </button>
            ))}
          </div>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 border tier-panel reveal reveal-d3">
            <div className="p-6 md:p-8 md:border-r tier-panel">
              <p className="meta-sm" style={tierField(48)}>Tier</p>
              <p className="mt-3 font-extrabold text-[28px] md:text-[32px] leading-[0.95] tracking-[-0.04em]">
                {tier.title}
              </p>
            </div>
            <div className="p-6 md:p-8 border-t md:border-t-0 md:border-r tier-panel">
              <p className="meta-sm" style={tierField(48)}>Rule</p>
              <p className="mt-3 text-[14px] md:text-[15px] leading-[1.5] font-medium tracking-[-0.01em]">
                {tier.rule}
              </p>
            </div>
            <div className="p-6 md:p-8 border-t md:border-t-0 tier-panel">
              <p className="meta-sm" style={tierField(48)}>When it fires</p>
              <p className="mt-3 text-[14px] md:text-[15px] leading-[1.5] font-medium tracking-[-0.01em]">
                {tier.when}
              </p>
              <p className="mt-5 meta-sm" style={tierField(48)}>{tier.units}</p>
            </div>
          </div>
        </div>
      </section>

      {/* SPEC TABLE */}
      <section id="spec" className="bg-ground relative border-t hairline">
        <div className="max-w-[1440px] mx-auto px-5 md:px-8 py-20 md:py-28 lg:py-32">
          <div className="flex items-start justify-between gap-6 mb-12 md:mb-16">
            <p className="meta text-muted reveal">06 / spec</p>
            <p className="meta text-muted reveal">runtime facts only</p>
          </div>

          <h2 className="font-extrabold text-[clamp(34px,4.2vw,60px)] leading-[0.94] tracking-[-0.045em] reveal">
            Specification.
          </h2>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-x-12 lg:gap-x-20 reveal reveal-d1">
            <div>
              {[
                ['Language', 'TypeScript'],
                ['Runtime', 'Node ≥ 22'],
                ['Install', 'npm i -g plx-converter'],
                ['Credentials', '1 (DEEZER_ARL)'],
                ['Spotify auth', 'none'],
                ['Deezer auth', 'ARL cookie'],
              ].map(([k, v], i, arr) => (
                <div
                  key={k}
                  className={`spec-row py-4 flex items-baseline justify-between gap-6${i === arr.length - 1 ? ' border-b hairline' : ''}`}
                >
                  <span className="text-[14px] md:text-[15px] text-secondary font-medium tracking-[-0.01em]">
                    {k}
                  </span>
                  <span className="meta text-ink tabular-nums">{v}</span>
                </div>
              ))}
            </div>
            <div>
              {[
                ['Match tiers', '3'],
                ['Duration match', '±3s'],
                ['Duration units', 'ms → s'],
                ['Search', 'free-text words'],
                ['Embed fallback', '100 tracks'],
                ['Report', 'CSV'],
              ].map(([k, v], i, arr) => (
                <div
                  key={k}
                  className={`spec-row py-4 flex items-baseline justify-between gap-6${i === arr.length - 1 ? ' border-b hairline' : ''}`}
                >
                  <span className="text-[14px] md:text-[15px] text-secondary font-medium tracking-[-0.01em]">
                    {k}
                  </span>
                  <span className="meta text-ink tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CLOSE / INSTALL */}
      <section id="install" className="bg-stage relative overflow-hidden">
        <div className="max-w-[1440px] mx-auto px-5 md:px-8 pt-20 md:pt-28 lg:pt-32 pb-8">
          <div className="flex items-start justify-between gap-6 mb-12">
            <p className="meta text-muted reveal">07 / install</p>
            <p className="meta text-muted reveal">one credential</p>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-10">
            <div className="max-w-xl">
              <h2 className="font-extrabold text-[clamp(36px,4.8vw,68px)] leading-[0.92] tracking-[-0.045em] reveal">
                Install once.
                <br />
                Move everything.
              </h2>
              <p className="mt-5 meta text-muted reveal reveal-d1">
                Requires Node ≥ 22 and a Deezer ARL cookie — the login session Deezer stores
                in your browser once you're signed in.{' '}
                <a href={ARL_GUIDE} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                  Grab yours
                </a>
                , stored locally, never sent anywhere else. Spotify stays anonymous.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 reveal reveal-d2">
              <CopyInstallPill size="lg" />
              <a
                href="#convert"
                className="pill meta h-12 px-6 border border-[rgba(13,13,15,.18)] text-ink hover:border-signal hover:text-signal"
              >
                plx --dry-run
              </a>
            </div>
          </div>

          <details className="mt-10 pt-5 border-t hairline reveal reveal-d2 group">
            <summary className="meta text-secondary cursor-pointer select-none hover:text-ink flex items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className="inline-block transition-transform duration-300 group-open:rotate-90">
                →
              </span>
              New to the command line? Four steps.
            </summary>
            <ol className="mt-5 max-w-xl space-y-3 pl-5 list-decimal list-outside text-[14px] md:text-[15px] leading-[1.5] text-secondary font-medium tracking-[-0.01em]">
              <li>
                Install{' '}
                <a href={NODEJS} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                  Node.js
                </a>{' '}
                — version 22 or later.
              </li>
              <li>Open Terminal (macOS/Linux) or Command Prompt / PowerShell (Windows).</li>
              <li>
                Paste <span className="meta-sm text-ink whitespace-nowrap">{INSTALL}</span> and
                press Enter.
              </li>
              <li>
                Run <span className="meta-sm text-ink whitespace-nowrap">plx --version</span> —
                if it prints a version number, the install worked.
              </li>
            </ol>
          </details>

          <div className="mt-16 pt-5 border-t hairline flex flex-wrap items-center gap-x-8 gap-y-3 reveal reveal-d3">
            <a href={GITHUB} target="_blank" rel="noreferrer" className="meta text-muted hover:text-ink transition-colors">Github</a>
            <a href={NPM} className="meta text-muted hover:text-ink transition-colors">Npm</a>
            <a href={DOCS} className="meta text-muted hover:text-ink transition-colors">Docs</a>
            <span className="meta text-muted lg:ml-auto">© plx · local-first · no telemetry</span>
          </div>
        </div>

        <div className="close-brand mt-10 px-5 md:px-8" aria-hidden="true">
          {'plx plx plx'}
        </div>
      </section>
    </div>
  )
}
