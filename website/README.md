# Contentric — marketing site

A static marketing website for **Contentric**, a fictional AI-native content
marketing studio. No build step, no framework, no runtime dependencies — three
files and a font folder.

## Run it

Any static file server works. It must be served over HTTP rather than opened
as a `file://` URL, because self-hosted webfonts are subject to CORS:

```bash
cd website
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

```
website/
├── index.html                  # the entire page
├── assets/
│   ├── css/
│   │   ├── fonts.css           # @font-face declarations
│   │   └── styles.css          # design tokens + all component styles
│   ├── fonts/                  # Inter + JetBrains Mono (variable, woff2)
│   └── js/
│       └── main.js             # all interaction, vanilla, no dependencies
└── README.md
```

## Design

Deliberately monochrome — paper white, cool greys, graphite ink — with one
restrained steel accent used only for focus rings and "live" indicators. All
colours, spacing, radii, shadows and easings are CSS custom properties in the
`:root` block at the top of `styles.css`; retheming means editing that block,
not hunting through rules.

The "chrome" gradient applied to `.chrome` spans in headlines is the one
flourish: a slow-drifting metallic sweep via `background-clip: text`.

## What's in the JavaScript

| Feature | Notes |
| --- | --- |
| Momentum scrolling | Animates the *real* document scroll position, so `position: sticky`, anchor links and the native scrollbar all keep working. Disabled on touch devices (native momentum is already good) and under reduced motion. |
| Scroll reveals | `IntersectionObserver`, with a sweep that settles anything the viewport jumped clean past (deep links, `scrollIntoView`, hard flicks). |
| Hero mesh | Canvas particle network, DPR-aware, capped node count, pauses when scrolled out of view, drifts away from the cursor. |
| Pinned engine sequence | The sticky panel swaps as you scroll through the four stages. |
| Counters, spotlight, tilt, custom cursor, accordion, billing toggle, mobile menu, form validation | All vanilla, all progressive. |

Everything degrades: without JavaScript the page is fully readable (no content
is hidden behind reveals), and `prefers-reduced-motion: reduce` disables the
canvas, momentum scrolling, the custom cursor and every transition.

## Before this goes live

The site is a complete front end, but a few things are deliberately inert:

- **The contact form has no backend.** `main.js` validates input and fakes a
  success state. Point it at your form endpoint — HubSpot, Formspree, a
  serverless function — in the `submit` handler near the bottom of the file.
- **All copy, client names, metrics and the testimonial are placeholders.**
  "Northwind Logistics", "Helix Labs", "Arcadia Home", the marquee logos and
  every figure are invented for layout purposes. Replace them with real,
  substantiated numbers before publishing — quoting fabricated results as
  fact is both a legal and a credibility problem.
- **Prices are illustrative.**
- Footer links (Privacy, Terms, Cookies, social) point at `#top`.
- `app.contentric.ai` in the dashboard mock is decorative, not a real host.

## Fonts

Inter and JetBrains Mono, both under the SIL Open Font License 1.1, vendored
as variable woff2 (latin + latin-ext). Self-hosted rather than loaded from
Google Fonts: one fewer third-party round trip, and no third-party request
carrying visitor IPs — which matters for a site claiming a London address.
