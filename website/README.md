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
