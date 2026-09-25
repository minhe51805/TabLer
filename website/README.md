# TableR Website

The public product website for [TableR](https://github.com/minhe51805/TabLer).
It is a standalone Next.js application so the desktop app and marketing site can
be developed and deployed independently from the same repository.

## Local development

```bash
cd website
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production build

```bash
npm run lint
npm run build
npm start
```

## Deploy to Vercel

1. Import `minhe51805/TabLer` into Vercel.
2. Set **Root Directory** to `website`.
3. Keep the detected framework as **Next.js**.
4. Deploy. Vercel will use `npm run build` automatically.

No website-specific environment variables are currently required.
Set `NEXT_PUBLIC_SITE_URL` only when you want social metadata to use a custom
production domain instead of the URL supplied automatically by Vercel.

## Pages

| Route                   | File                 | Notes                                                                                               |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `/`                     | `src/app/page.tsx`   | Landing page. `revalidate = 0` — GitHub release tags fetched live via `src/lib/github-releases.ts`. |
| `/download`             | `src/app/download/`  | Platform chooser (`DownloadChooser.tsx`).                                                           |
| `/plugins`              | `src/app/plugins/`   | Plugin registry listing + search. Content from `src/lib/plugins.ts`.                                |
| `/docs`, `/docs/[slug]` | `src/app/docs/`      | Authored docs. Content lives in `src/lib/docs.ts` (structured blocks, per-language).                |
| `/changelog`            | `src/app/changelog/` | Release notes pulled from GitHub releases.                                                          |

## Landing-page hero

`src/app/Home3D.tsx` holds every client-side scroll/pointer effect. All of it is
gated — when a gate fails the page renders as a plain static document and every
element stays visible.

- **`HeroScrollFX`** adds `.fx-on` to the hero only when BOTH
  `prefers-reduced-motion: no-preference` AND viewport `> 720px`. With `.fx-on`
  the hero section becomes ~460vh tall with a sticky stage; scroll drives
  progress through copy-fade → caption phases → engines reveal. Below 720px or
  under reduced-motion the hero is a normal ~100vh block (`fx-on` absent).
- **`ScrollReveal`** tags every `.neu section` and `.signal-strip` with
  `.reveal-pending`, then adds `.is-revealed` via IntersectionObserver
  (threshold 0.1). Sections already in the viewport on load get `.is-revealed`
  immediately — no hydration flicker. Reduced-motion users get everything
  revealed up front.
- **`TiltFrame`** pointer-tilt on the hero product frame. Disabled on
  `pointer: coarse` (touch) and reduced-motion.
- **`DockToggle`** collapses/expands the docked header bar (desktop only; the
  button is `display: none` below the docked-media breakpoint).
- **Back-to-top** scrolls with `behavior: "auto"` under reduced-motion,
  `"smooth"` otherwise.

## Mobile UX (≤720px)

- `.main-nav` is `display: none` — there is no hamburger menu; Docs/Changelog/
  Plugins are reachable from the footer.
- `.mobile-cta` is a fixed full-width Download bar that appears once the hero
  is ~1.4 viewports behind and hides near the footer (JS toggles `.is-visible`).
- `.back-to-top` sits at `bottom: 76px` on mobile so it never overlaps the
  mobile CTA bar (desktop: `bottom: 26px`).

## Internationalization

Two languages, `en` and `vi` (`src/lib/i18n.ts`). The active language is a
cookie (`LANGUAGE_COOKIE`) read server-side by `getSiteLanguage()`
(`src/lib/language.ts`); `LanguageToggle.tsx` switches it. All copy goes through
`getDictionary(language)` — no hardcoded strings in page components.

## Security headers

`next.config.ts` sets a Content-Security-Policy on every response. `script-src`
includes `'unsafe-eval'` **only in development** (Next.js dev tooling needs it);
production CSP omits it. `frame-ancestors 'none'` doubles as clickjacking
protection alongside `X-Frame-Options`. When adding a third-party script,
image host, or fetch target, extend the matching directive there.

## Conventions

- Navigation between internal pages uses `next/link`; in-page anchors (`#features`)
  stay plain `<a href="#…">`.
- Section styling lives in `src/app/globals.css` (single file, heavily
  commented). Design tokens (`--neu-*`, `--ink`, `--blue`, radii, shadows) are
  declared at `:root` — reuse them instead of new literals.
- `src/lib/docs.ts` is the authored docs corpus; `docsSlugs` there is mirrored
  by `scripts/build-plugin-repository.mjs` — keep them in sync when adding a
  docs page.
