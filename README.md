# XAUUSD Structure Analyst

Smart Money Concepts (SMC / ICT-style) market structure dashboard for **XAUUSD**.

## Features

- Multi-timeframe structure analysis (D1, 4H, 1H, 15M)
- Custom canvas chart with Order Blocks, FVGs, liquidity, BOS/CHoCH, kill zones, Fibonacci
- Rule-based high-probability setups (Sweep → OB → CHoCH, BOS retest, Discount/Premium OB)
- Live price + auto refresh
- Alerts + trade log (localStorage)
- Session summary + weekly report generator
- Demo data fallback when live API is unavailable

## Data Layer (Free-tier friendly)

Designed for the **Twelve Data free tier** (~8 calls/min):

| Data | Refresh interval | Cache TTL | Notes |
|------|------------------|-----------|-------|
| Live quote | 60 s | 45 s | Lightest call |
| 1H + 15M | 3 min | 1.5–3 min | Signal timeframes |
| 4H + D1 | 30 min | 15–60 min | Bias timeframes |

Additional protections:
- Serialized request queue + minimum 1.2 s gap between network calls
- Automatic back-off (75 s) on HTTP 429 / rate-limit messages
- Cache-first: timers only hit the network when TTL has expired
- Manual refresh forces fresh data but still respects the gap
- Falls back to last known candles, then demo data

## Project Structure

```
xauusd-analyst/
├── index.html              # Page shell
├── css/
│   └── styles.css          # All styles
├── js/
│   └── app.js              # Core engine (analysis, chart, UI, data, timers)
├── api/
│   └── gold.js             # Vercel serverless proxy
├── netlify/
│   └── functions/
│       └── gold.js         # Netlify function proxy
├── netlify.toml
├── vercel.json
└── README.md
```

Previously this was a single 4,300-line `index.html`. It has been split for maintainability while remaining a zero-build static site.

## Data Source

Uses [Twelve Data](https://twelvedata.com) for real XAU/USD candles and quotes via a serverless proxy (`/api/gold`) to avoid CORS issues.

## Deploy

### Netlify
- Publish directory: `.`
- Functions directory: `netlify/functions`

### Vercel
- The included `vercel.json` handles the `/api/*` rewrite.

## Local development

```bash
npx serve .
# or
python -m http.server 3000
```

Note: the `/api/gold` proxy only works when deployed to Netlify/Vercel. Without it the app falls back to demo data.
