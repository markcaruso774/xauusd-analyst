/**
 * XAUUSD Structure Analyst — Core Application
 * Extracted from monolithic index.html for maintainability.
 */

// ============================================================
// XAUUSD STRUCTURE ANALYST — CORE ENGINE
// ============================================================

const STATE = {
  apiKey: null,
  currentTF: '1H',
  candles: {},
  analysis: {},
  alerts: [],
  lastPrice: null,
  prevClose: null,
  refreshInterval: null,
  tradeLog: [],        // All triggered trades with outcome tracking
  seenAlerts: new Map(), // key -> original trigger time
  showFibo: false,
  chartOffset: 0,      // how many candles scrolled back from latest
  chartCandleCount: 60, // how many candles visible (zoom)
  tooltipCandle: null,  // candle currently being hovered/touched
  tooltip: null,        // { candleIndex, x, y } — active hover candle
  showKillZones: false, // Prevents duplicate alerts
  demoMode: false,
  liveConfirmed: false,
};

// ── TRADING PARAMETERS ──────────────────────────────────────
// Confirmed: 0.10 lot (mini) on Gold = $0.10 per pip
// 1 pip = $0.01 price move on XAUUSD
// 100 pips = $1.00 price move = $10.00 risk at 0.10 lot
// Example: SELL $5,175 → SL $5,185 = $10 move = 100 pips = $10 risk ✅
const TRADE = {
  lotSize: 0.10,        // 0.10 mini lot (10 oz)
  pipValue: 0.10,       // $0.10 per pip at 0.10 lot
  pipSize: 0.01,        // 1 pip = $0.01 price move on Gold
  maxRiskDollars: 10,   // max $10 risk per trade
  fixedSLPips: 100,     // SL1 = 100 pips = $10.00 price move = $10 risk
};

function pipsFromPrice(priceDiff) {
  // e.g. $10 price diff / $0.01 pip size = 1000 pips... 
  // BUT: on Gold $0.01 = 1 pip, $1.00 = 100 pips, $10.00 = 1000 pips
  // At 0.10 lot: 1000 pips × $0.10 = $100 — that's wrong
  // Correction: pip value already accounts for lot, so:
  // $10 risk / $0.10 per pip = 100 pips ✅ → price distance = 100 × $0.01 = $1.00... 
  // NO — user confirmed: entry 5175, SL 5185 = $10 away = 100 pips = $10 risk
  // Therefore: pips = price_distance / $0.10 (each $0.10 = 1 pip at 0.10 lot)
  return Math.round(Math.abs(priceDiff) / 0.10);
}
function dollarsFromPips(pips) {
  return (pips * TRADE.pipValue).toFixed(2);
}
function calcDualSL(entry, isBull, sweepLevel) {
  // SL1: fixed $10 risk = 100 pips = $10.00 price distance away
  // Confirmed: entry 5175, SL1 = 5175 + 10 = 5185 (sell) or 5175 - 10 = 5165 (buy)
  const sl1Distance = TRADE.fixedSLPips * TRADE.pipValue; // 100 × $0.10 = $10.00
  const sl1Price = isBull
    ? entry - sl1Distance   // BUY: SL below entry
    : entry + sl1Distance;  // SELL: SL above entry

  // SL2: structural — 3 pips ($0.30) beyond the sweep wick
  const sl2Price = sweepLevel != null
    ? (isBull ? sweepLevel - 0.30 : sweepLevel + 0.30)
    : (isBull ? entry - sl1Distance * 1.5 : entry + sl1Distance * 1.5);

  const sl2Pips = pipsFromPrice(Math.abs(entry - sl2Price));
  const sl2Risk = dollarsFromPips(sl2Pips);

  const tpDir = isBull ? 1 : -1;

  // TP for SL1 (fixed $10 risk)
  const tp1_sl1 = entry + tpDir * sl1Distance * 2;   // 1:2 = $20
  const tp2_sl1 = entry + tpDir * sl1Distance * 3;   // 1:3 = $30
  const tp3_sl1 = entry + tpDir * sl1Distance * 5;   // 1:5 = $50

  // TP for SL2 (structural risk)
  const sl2Dist = Math.abs(entry - sl2Price);
  const tp1_sl2 = entry + tpDir * sl2Dist * 2;
  const tp2_sl2 = entry + tpDir * sl2Dist * 3;

  return {
    sl1: {
      price: sl1Price.toFixed(2),
      pips: TRADE.fixedSLPips,
      risk: (TRADE.fixedSLPips * TRADE.pipValue).toFixed(2),  // $10.00
    },
    sl2: {
      price: sl2Price.toFixed(2),
      pips: sl2Pips,
      risk: sl2Risk,
    },
    tp: {
      sl1: [
        { label:'TP1 (1:2)', price: tp1_sl1.toFixed(2), pips: TRADE.fixedSLPips*2, profit: (TRADE.fixedSLPips*2*TRADE.pipValue).toFixed(2) },
        { label:'TP2 (1:3)', price: tp2_sl1.toFixed(2), pips: TRADE.fixedSLPips*3, profit: (TRADE.fixedSLPips*3*TRADE.pipValue).toFixed(2) },
        { label:'TP3 (1:5)', price: tp3_sl1.toFixed(2), pips: TRADE.fixedSLPips*5, profit: (TRADE.fixedSLPips*5*TRADE.pipValue).toFixed(2) },
      ],
      sl2: [
        { label:'TP1 (1:2)', price: tp1_sl2.toFixed(2), pips: sl2Pips*2, profit: (sl2Pips*2*TRADE.pipValue).toFixed(2) },
        { label:'TP2 (1:3)', price: tp2_sl2.toFixed(2), pips: sl2Pips*3, profit: (sl2Pips*3*TRADE.pipValue).toFixed(2) },
      ],
    }
  };
}

// ============================================================
// ============================================================
// DATA LAYER — Rate-limit aware, cached, free-tier friendly
// ============================================================
// Design goals for Twelve Data free tier (~8 calls/min):
//   • Cache candles aggressively (TTL per TF)
//   • Enforce minimum gap between any two API calls
//   • Stagger refreshes (price frequent, structure less often)
//   • Detect 429 / rate-limit responses and back off
//   • Fall back to demo data cleanly
// ============================================================

const TF_MAP = {
  'D1':    { interval: '1day',  outputsize: 100 },
  '4H':    { interval: '4h',    outputsize: 100 },
  '1H':    { interval: '1h',    outputsize: 100 },
  '15min': { interval: '15min', outputsize: 100 },
};

// Cache TTL (ms) — how long we consider candle data "fresh"
const CACHE_TTL = {
  '15min': 90 * 1000,      // 1.5 min
  '1H':    3 * 60 * 1000,  // 3 min
  '4H':    15 * 60 * 1000, // 15 min
  'D1':    60 * 60 * 1000, // 1 hour
  'quote': 45 * 1000,      // 45 sec
};

// Minimum gap between any two network calls (protects free tier)
const MIN_REQUEST_GAP_MS = 1200; // ~1.2 s → max ~50 calls/min theoretical, but we stay far below

const NETLIFY_FN = '/api/gold';

// Internal request bookkeeping
const _data = {
  lastRequestAt: 0,
  queue: Promise.resolve(),
  cache: {               // tf -> { candles, fetchedAt }
    'D1': null,
    '4H': null,
    '1H': null,
    '15min': null,
    quote: null,
  },
  rateLimitedUntil: 0,   // timestamp until which we avoid calling the API
};

function _isRateLimited(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.code === 429) return true;
  return data.status === 'error' && typeof data.message === 'string' &&
    /limit|quota|exceed|credits/i.test(data.message);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Serialize requests and enforce minimum gap */
async function _throttledFetch(url, timeoutMs = 10000) {
  // Chain onto the queue so only one request runs at a time
  const run = _data.queue.then(async () => {
    const now = Date.now();

    // Honor rate-limit back-off
    if (now < _data.rateLimitedUntil) {
      const wait = _data.rateLimitedUntil - now;
      console.warn(`[data] rate-limited, waiting ${Math.round(wait/1000)}s`);
      await _sleep(wait);
    }

    // Enforce minimum gap
    const gap = now - _data.lastRequestAt;
    if (gap < MIN_REQUEST_GAP_MS) {
      await _sleep(MIN_REQUEST_GAP_MS - gap);
    }

    _data.lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (r.status === 429) {
        // Back off for 60–90 seconds
        _data.rateLimitedUntil = Date.now() + 75 * 1000;
        showRateLimitWarning();
        return null;
      }
      if (!r.ok) return null;
      const json = await r.json();
      // Proxy passes Twelve Data's body through with HTTP 200, so detect limits in the body
      if (_isRateLimited(json)) {
        _data.rateLimitedUntil = Date.now() + 75 * 1000;
        showRateLimitWarning();
        return null;
      }
      return json;
    } catch (e) {
      clearTimeout(timer);
      console.warn('[data] fetch failed:', e.message);
      return null;
    }
  });

  // Keep the queue alive even if this request fails
  _data.queue = run.catch(() => {});
  return run;
}

async function callProxy(params, timeoutMs = 10000) {
  const qs = new URLSearchParams(params).toString();
  const url = `${NETLIFY_FN}?${qs}`;
  return _throttledFetch(url, timeoutMs);
}

function parseTwelveDataCandles(data) {
  try {
    if (!data || !data.values || data.status === 'error') return null;
    return data.values.map(v => ({
      time:   v.datetime,
      open:   parseFloat(v.open),
      high:   parseFloat(v.high),
      low:    parseFloat(v.low),
      close:  parseFloat(v.close),
      volume: parseFloat(v.volume || 0),
    })).reverse();
  } catch (e) {
    return null;
  }
}

/**
 * Fetch candles for a timeframe.
 * @param {string} tf
 * @param {object} opts
 * @param {boolean} opts.force  Ignore cache and fetch fresh
 * @returns {Promise<Array|null>}
 */
async function fetchCandles(tf, opts = {}) {
  const { force = false } = opts;
  const ttl = CACHE_TTL[tf] || 3 * 60 * 1000;
  const cached = _data.cache[tf];

  if (!force && cached && (Date.now() - cached.fetchedAt) < ttl) {
    return cached.candles;
  }

  const { interval, outputsize } = TF_MAP[tf];
  const data = await callProxy({ type: 'candles', interval, outputsize });

  if (data) {
    const candles = parseTwelveDataCandles(data);
    if (candles && candles.length > 5) {
      _data.cache[tf] = { candles, fetchedAt: Date.now() };
      STATE.candles[tf] = candles;          // keep legacy STATE in sync
      STATE.liveConfirmed = true;
      return candles;
    }
  }

  // Fallback: use existing STATE or generate demo
  if (STATE.candles[tf] && STATE.candles[tf].length > 5) {
    console.warn(`[data] fetchCandles(${tf}) failed — using previous candles`);
    return STATE.candles[tf];
  }

  console.warn(`[data] fetchCandles(${tf}) failed — using demo data`);
  const demo = generateDemoCandles(tf);
  STATE.candles[tf] = demo;
  return demo;
}

/**
 * Fetch live quote (price).
 * Respects quote cache TTL.
 */
async function fetchQuote(opts = {}) {
  const { force = false } = opts;
  const cached = _data.cache.quote;

  if (!force && cached && (Date.now() - cached.fetchedAt) < CACHE_TTL.quote) {
    return cached.quote;
  }

  const data = await callProxy({ type: 'quote' });
  if (data && (data.close || data.price)) {
    const quote = {
      price: parseFloat(data.close || data.price),
      change: parseFloat(data.change || 0),
      percent_change: parseFloat(data.percent_change || 0),
    };
    _data.cache.quote = { quote, fetchedAt: Date.now() };
    return quote;
  }
  return cached ? cached.quote : null;
}

/** Force-refresh a single TF (used by manual refresh / switchTF) */
async function forceFetchCandles(tf) {
  return fetchCandles(tf, { force: true });
}

// Generate realistic XAUUSD demo candles (fallback only)
function generateDemoCandles(tf) {
  const basePrice = 5170;
  const volatility = { 'D1': 45, '4H': 22, '1H': 12, '15min': 6 };
  const countMap = { 'D1': 100, '4H': 100, '1H': 100, '15min': 100 };
  const count = countMap[tf] || 100;
  const vol = volatility[tf] || 10;
  const candles = [];

  let price = basePrice - (count * vol * 0.3);
  const now = new Date();

  const minsPerTF = { 'D1': 1440, '4H': 240, '1H': 60, '15min': 15 };
  const mins = minsPerTF[tf] || 60;

  for (let i = count; i >= 0; i--) {
    const t = new Date(now.getTime() - i * mins * 60000);
    const change = (Math.random() - 0.46) * vol;
    const open = price;
    const close = price + change;
    const wickMult = 0.3 + Math.random() * 0.5;
    const high = Math.max(open, close) + Math.abs(change) * wickMult;
    const low = Math.min(open, close) - Math.abs(change) * wickMult;
    candles.push({
      time: t.toISOString().slice(0, 19).replace('T', ' '),
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: Math.floor(Math.random() * 5000 + 1000),
    });
    price = close;
  }

  return candles;
}

// ============================================================
// MARKET STRUCTURE ENGINE (improved)
// ============================================================
// Improvements vs original:
//  • Adaptive swing lookback by timeframe context
//  • Stronger pivot filtering (requires clear swing)
//  • Cleaner BOS / CHoCH separation with confirmation
//  • Order Blocks ranked by strength + freshness + proximity
//  • Explicit mitigation / invalidation logic
// ============================================================

/** Adaptive lookback: tighter on lower TFs, wider on higher */
function swingLookbackFor(candles) {
  // Heuristic from average true range magnitude
  if (!candles || candles.length < 10) return 3;
  const recent = candles.slice(-20);
  const ranges = recent.map(c => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  // Gold: smaller average range → slightly tighter lookback still ok
  if (avgRange < 5) return 2;
  if (avgRange < 15) return 3;
  return 4;
}

function findSwings(candles, lookback = null) {
  if (!candles || candles.length < 10) return { highs: [], lows: [] };
  const lb = lookback != null ? lookback : swingLookbackFor(candles);
  const highs = [], lows = [];

  for (let i = lb; i < candles.length - lb; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow)  lows.push({ index: i, price: candles[i].low,  time: candles[i].time });
  }
  return { highs, lows };
}

/**
 * Market structure: trend + BOS + CHoCH
 * BOS = continuation break of structure
 * CHoCH = change of character (first break against prior trend)
 */
function detectStructure(candles) {
  if (!candles || candles.length < 20) {
    return { trend: 'RANGING', bos: null, choch: null, recentHighs: [], recentLows: [] };
  }

  const { highs, lows } = findSwings(candles);
  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'RANGING', bos: null, choch: null, recentHighs: [], recentLows: [] };
  }

  const recentHighs = highs.slice(-5);
  const recentLows  = lows.slice(-5);

  // Score HH/HL vs LH/LL on the last few swings
  let bullPoints = 0, bearPoints = 0;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) bullPoints += 1.2;
    else bearPoints += 1;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) bullPoints += 1;
    else bearPoints += 1.2;
  }

  let trend = 'RANGING';
  if (bullPoints > bearPoints + 0.5) trend = 'BULLISH';
  else if (bearPoints > bullPoints + 0.5) trend = 'BEARISH';

  const lastHigh = recentHighs[recentHighs.length - 1];
  const lastLow  = recentLows[recentLows.length - 1];
  const currentClose = candles[candles.length - 1].close;
  const prevClose    = candles.length > 1 ? candles[candles.length - 2].close : currentClose;

  // BOS only on the first candle that closes through the level
  let bos = null;
  if (lastHigh && currentClose > lastHigh.price && prevClose <= lastHigh.price) {
    bos = { type: 'BULLISH BOS', level: lastHigh.price, index: lastHigh.index };
  }
  if (lastLow && currentClose < lastLow.price && prevClose >= lastLow.price) {
    bos = { type: 'BEARISH BOS', level: lastLow.price, index: lastLow.index };
  }

  // CHoCH: break against the prevailing trend (structure flip)
  let choch = null;
  if (trend === 'BEARISH' && lastHigh && currentClose > lastHigh.price) {
    choch = { type: 'BULLISH CHoCH', level: lastHigh.price, index: lastHigh.index };
  }
  if (trend === 'BULLISH' && lastLow && currentClose < lastLow.price) {
    choch = { type: 'BEARISH CHoCH', level: lastLow.price, index: lastLow.index };
  }

  return { trend, bos, choch, recentHighs, recentLows };
}

/**
 * Order Blocks — improved quality filters
 * - Require real displacement (impulse)
 * - Score by strength, freshness, proximity to price
 * - Strict mitigation: close through the body invalidates
 */
function detectOrderBlocks(candles) {
  if (!candles || candles.length < 12) return [];

  const bullishOBs = [];
  const bearishOBs = [];
  const currentPrice = candles[candles.length - 1].close;
  const len = candles.length;

  for (let i = 3; i < len - 3; i++) {
    const c = candles[i];
    const body = Math.abs(c.open - c.close);
    if (body < 0.8) continue; // skip tiny / doji candles

    // ── BULLISH OB: last bearish candle before bullish impulse ──
    if (c.close < c.open) {
      let maxHigh = c.high;
      let impulsive = false;
      let impulseMove = 0;

      for (let j = i + 1; j < Math.min(i + 6, len); j++) {
        maxHigh = Math.max(maxHigh, candles[j].high);
        const moveFromBody = candles[j].close - c.open;
        if (moveFromBody > body * 1.8) {
          impulsive = true;
          impulseMove = Math.max(impulseMove, maxHigh - c.low);
        }
      }

      if (impulsive && impulseMove > body * 2.2 && impulseMove > 6) {
        const strength = Math.round((impulseMove / body) * 10) / 10;
        bullishOBs.push({
          type: 'BULLISH',
          high: Math.max(c.open, c.close),
          low:  Math.min(c.open, c.close),
          mid:  (c.open + c.close) / 2,
          index: i,
          time: c.time,
          strength,
          age: len - 1 - i,
        });
      }
    }

    // ── BEARISH OB: last bullish candle before bearish impulse ──
    if (c.close > c.open) {
      let minLow = c.low;
      let impulsive = false;
      let impulseMove = 0;

      for (let j = i + 1; j < Math.min(i + 6, len); j++) {
        minLow = Math.min(minLow, candles[j].low);
        const moveFromBody = c.open - candles[j].close;
        if (moveFromBody > body * 1.8) {
          impulsive = true;
          impulseMove = Math.max(impulseMove, c.high - minLow);
        }
      }

      if (impulsive && impulseMove > body * 2.2 && impulseMove > 6) {
        const strength = Math.round((impulseMove / body) * 10) / 10;
        bearishOBs.push({
          type: 'BEARISH',
          high: Math.max(c.open, c.close),
          low:  Math.min(c.open, c.close),
          mid:  (c.open + c.close) / 2,
          index: i,
          time: c.time,
          strength,
          age: len - 1 - i,
        });
      }
    }
  }

  // Strict mitigation: close through the body invalidates the OB
  const validBullish = bullishOBs.filter(ob => {
    for (let i = ob.index + 1; i < len; i++) {
      if (candles[i].close < ob.low - 0.3) return false;
    }
    return true;
  });

  const validBearish = bearishOBs.filter(ob => {
    for (let i = ob.index + 1; i < len; i++) {
      if (candles[i].close > ob.high + 0.3) return false;
    }
    return true;
  });

  // Rank: prefer stronger, fresher, closer to current price
  function scoreOB(ob) {
    const distPct = Math.abs(ob.mid - currentPrice) / currentPrice;
    const proximity = Math.max(0, 1 - distPct * 80); // closer = higher
    const freshness = Math.max(0, 1 - ob.age / 40);  // newer = higher
    return ob.strength * 0.45 + proximity * 0.35 + freshness * 0.20;
  }

  const ranked = [...validBullish, ...validBearish]
    .map(ob => ({ ...ob, score: scoreOB(ob) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return ranked.sort((a, b) => a.index - b.index);
}

function detectFVG(candles) {
  if (!candles || candles.length < 3) return [];
  const fvgs = [];
  const currentPrice = candles[candles.length - 1].close;

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG
    if (next.low > prev.high) {
      const gap = next.low - prev.high;
      if (gap > 1.5) { // ignore tiny gaps
        fvgs.push({
          type: 'BULLISH',
          high: next.low,
          low: prev.high,
          mid: (next.low + prev.high) / 2,
          index: i,
          size: gap,
          filled: currentPrice < prev.high, // roughly
        });
      }
    }
    // Bearish FVG
    if (next.high < prev.low) {
      const gap = prev.low - next.high;
      if (gap > 1.5) {
        fvgs.push({
          type: 'BEARISH',
          high: prev.low,
          low: next.high,
          mid: (prev.low + next.high) / 2,
          index: i,
          size: gap,
          filled: currentPrice > prev.low,
        });
      }
    }
  }

  // Keep unfilled + most recent
  return fvgs.filter(f => !f.filled).slice(-5);
}

function detectLiquidityPools(candles, tf) {
  if (!candles || candles.length < 10) return [];
  const pools = [];
  const tolerance = 0.003; // 0.3% tolerance for "equal" levels

  const { highs, lows } = findSwings(candles, 3);

  // Find equal highs (buy-side liquidity)
  for (let i = 0; i < highs.length - 1; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const diff = Math.abs(highs[i].price - highs[j].price) / highs[i].price;
      if (diff < tolerance) {
        pools.push({
          type: 'BUY-SIDE',
          price: (highs[i].price + highs[j].price) / 2,
          description: 'Equal Highs — BSL',
        });
        break;
      }
    }
  }

  // Find equal lows (sell-side liquidity)
  for (let i = 0; i < lows.length - 1; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const diff = Math.abs(lows[i].price - lows[j].price) / lows[i].price;
      if (diff < tolerance) {
        pools.push({
          type: 'SELL-SIDE',
          price: (lows[i].price + lows[j].price) / 2,
          description: 'Equal Lows — SSL',
        });
        break;
      }
    }
  }

  // Previous day high/low — timeframe aware
  const pdCandleCount = { 'D1': 5, '4H': 6, '1H': 24, '15min': 96 };
  const pdCount = pdCandleCount[tf] || 24;
  if (candles.length > pdCount) {
    const pdIdx = candles.length - (pdCount + 1);
    let pdHigh = 0, pdLow = Infinity;
    for (let i = pdIdx; i < candles.length - 1; i++) {
      pdHigh = Math.max(pdHigh, candles[i].high);
      pdLow = Math.min(pdLow, candles[i].low);
    }
    if (pdHigh > 0) pools.push({ type: 'BUY-SIDE', price: pdHigh, description: 'Prev Day High — BSL' });
    if (pdLow < Infinity) pools.push({ type: 'SELL-SIDE', price: pdLow, description: 'Prev Day Low — SSL' });
  }

  return pools.slice(0, 6);
}

function detectPattern(candles) {
  if (!candles || candles.length < 15) {
    return { name: 'RANGING / CONSOLIDATION', type: 'neutral', detail: 'Insufficient data' };
  }

  const { highs, lows } = findSwings(candles, 3);
  if (highs.length < 2 || lows.length < 2) {
    return { name: 'RANGING / CONSOLIDATION', type: 'neutral', detail: 'No clear swings' };
  }

  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;

  // Bullish structure
  if (h2 > h1 && l2 > l1) {
    const range = candles.slice(-10);
    const rangeHigh = Math.max(...range.map(c => c.high));
    const rangeLow  = Math.min(...range.map(c => c.low));
    if ((rangeHigh - rangeLow) / rangeHigh < 0.012) {
      return {
        name: 'BULLISH FLAG',
        type: 'bull',
        breakout: rangeHigh,
        target: rangeHigh + (rangeHigh - rangeLow) * 2,
      };
    }
    return { name: 'BULLISH TREND', type: 'bull', detail: 'HH + HL — uptrend intact' };
  }

  // Bearish structure
  if (h2 < h1 && l2 < l1) {
    const range = candles.slice(-10);
    const rangeHigh = Math.max(...range.map(c => c.high));
    const rangeLow  = Math.min(...range.map(c => c.low));
    if ((rangeHigh - rangeLow) / rangeHigh < 0.012) {
      return {
        name: 'BEARISH FLAG',
        type: 'bear',
        breakout: rangeLow,
        target: rangeLow - (rangeHigh - rangeLow) * 2,
      };
    }
    return { name: 'BEARISH TREND', type: 'bear', detail: 'LL + LH — downtrend intact' };
  }

  return { name: 'RANGING / CONSOLIDATION', type: 'neutral', detail: 'No clear pattern — waiting for breakout' };
}

function detectSweep(candles) {
  if (!candles || candles.length < 8) return null;
  const last = candles[candles.length - 1];
  const prev = candles.slice(-12, -1);

  const prevHigh = Math.max(...prev.map(c => c.high));
  const prevLow  = Math.min(...prev.map(c => c.low));

  // Buy-side swept: wick above then close back below
  if (last.high > prevHigh && last.close < prevHigh) {
    return { type: 'BUY-SIDE SWEPT', level: prevHigh, direction: 'short', index: candles.length - 1 };
  }
  // Sell-side swept: wick below then close back above
  if (last.low < prevLow && last.close > prevLow) {
    return { type: 'SELL-SIDE SWEPT', level: prevLow, direction: 'long', index: candles.length - 1 };
  }
  return null;
}

function detectCHoCH(candles, tf) {
  if (!candles || candles.length < 20) return null;
  const recent = candles.slice(-24);
  const { highs, lows } = findSwings(recent, 2);
  if (highs.length < 2 || lows.length < 2) return null;

  const structure = detectStructure(recent.slice(0, -2));
  const currentClose = candles[candles.length - 1].close;
  const lastHigh = highs[highs.length - 1].price;
  const lastLow  = lows[lows.length - 1].price;

  if (structure.trend === 'BEARISH' && currentClose > lastHigh) {
    return { type: 'BULLISH CHoCH', level: lastHigh, tf, significance: 'HIGH' };
  }
  if (structure.trend === 'BULLISH' && currentClose < lastLow) {
    return { type: 'BEARISH CHoCH', level: lastLow, tf, significance: 'HIGH' };
  }
  return null;
}

// ============================================================
// SETUP GENERATION — The Exact Strategy Used This Week
// ============================================================

function generateSetups(candles, tf, structure, obs, liqPools, fvgs) {
  if (!candles || candles.length < 20) return [];
  const setups = [];
  const len = candles.length;
  const current  = candles[len - 1];
  const prev1    = candles[len - 2];
  const prev2    = candles[len - 3];
  const currentPrice = current.close;

  // ── Helpers ────────────────────────────────────────────────
  function recentlyTouched(level, lookback, tolerance = 0.003) {
    for (let i = Math.max(0, len - lookback); i < len; i++) {
      if (Math.abs(candles[i].low - level) / level < tolerance ||
          Math.abs(candles[i].high - level) / level < tolerance) return true;
    }
    return false;
  }

  function hasRejection(candle, level, isBull) {
    if (isBull) {
      return candle.low <= level * 1.002 && candle.close > level;
    }
    return candle.high >= level * 0.998 && candle.close < level;
  }

  function closedAbove(candle, level) { return candle.close > level; }
  function closedBelow(candle, level) { return candle.close < level; }

  // ── Helper: sweep happened recently (within N candles) ───────
  function recentSweep(lookback) {
    for (let i = len - lookback; i < len - 1; i++) {
      const c = candles[i];
      const prevHigh = Math.max(...candles.slice(Math.max(0,i-8),i).map(x=>x.high));
      const prevLow  = Math.min(...candles.slice(Math.max(0,i-8),i).map(x=>x.low));
      if (c.high > prevHigh && c.close < prevHigh)
        return { type:'BUY-SIDE SWEPT', level: prevHigh, direction:'short', index: i };
      if (c.low < prevLow && c.close > prevLow)
        return { type:'SELL-SIDE SWEPT', level: prevLow, direction:'long', index: i };
    }
    return null;
  }

  // ── Helper: CHoCH happened recently (within N candles) ───────
  function recentCHoCH(lookback) {
    const slice = candles.slice(-lookback);
    return detectCHoCH(slice, tf);
  }

  /** Confluence scorer → maps points to confidence */
  function scoreToConfidence(pts) {
    if (pts >= 7) return 'HIGH';
    if (pts >= 4) return 'MEDIUM';
    return 'LOW';
  }

  // ============================================================
  // SETUP 1: Liquidity Sweep → OB → CHoCH
  // RULES:
  // 1. Sweep happened within last 6 candles
  // 2. CHoCH confirmed within last 5 candles (candle CLOSED through structure)
  // 3. Price is now inside or touching a valid OB
  // 4. Current candle closed in direction of trade (not still against it)
  // ============================================================
  const sweep6 = recentSweep(6);
  const choch5 = recentCHoCH(5);

  if (sweep6 && choch5) {
    const isBull = sweep6.direction === 'long';
    // CHoCH direction must match sweep direction
    const chochMatchesSweep = isBull
      ? choch5.type === 'BULLISH CHoCH'
      : choch5.type === 'BEARISH CHoCH';

    if (chochMatchesSweep) {
      const relevantOBs = obs.filter(o => o.type === (isBull ? 'BULLISH' : 'BEARISH'));
      const nearestOB = relevantOBs.find(o => {
        const dist = Math.abs(currentPrice - o.mid) / currentPrice;
        return dist < 0.012;
      });

      // Current candle must have closed in trade direction
      const candleConfirmed = isBull
        ? closedAbove(current, choch5.level)
        : closedBelow(current, choch5.level);

      if (nearestOB && candleConfirmed) {
        const entry = isBull ? nearestOB.high : nearestOB.low;
        const dual = calcDualSL(entry, isBull, sweep6.level);
        setups.push({
          type: isBull ? 'BUY' : 'SELL',
          name: 'SWEEP → OB → CHoCH',
          confidence: 'HIGH',
          entry: entry.toFixed(2),
          dual,
          condition: `${sweep6.type} at $${sweep6.level.toFixed(2)} + ${choch5.type} confirmed — candle closed through structure`,
          tf,
        });
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // SETUP 2: BOS Retest
  // ────────────────────────────────────────────────────────────
  if (structure.bos) {
    const bosLevel = structure.bos.level;
    const isBull = structure.bos.type.includes('BULL');
    const dist = Math.abs(currentPrice - bosLevel) / bosLevel;

    if (dist < 0.01) {
      const approaching = isBull
        ? currentPrice >= bosLevel * 0.995
        : currentPrice <= bosLevel * 1.005;

      const rejection =
        hasRejection(current, bosLevel, isBull) ||
        hasRejection(prev1, bosLevel, isBull) ||
        hasRejection(prev2, bosLevel, isBull);

      const consolidating = [current, prev1, prev2].every(c =>
        Math.abs(c.close - bosLevel) / bosLevel < 0.004
      );

      const closedOK = isBull ? closedAbove(current, bosLevel) : closedBelow(current, bosLevel);

      if (approaching && (rejection || consolidating) && closedOK) {
        let pts = 3;
        if (rejection) pts += 2;
        if ((isBull && structure.trend === 'BULLISH') || (!isBull && structure.trend === 'BEARISH')) pts += 1;
        if (dist < 0.004) pts += 1;

        const dual = calcDualSL(bosLevel, isBull, null);
        setups.push({
          type: isBull ? 'BUY' : 'SELL',
          name: 'BOS RETEST',
          confidence: scoreToConfidence(pts),
          score: pts,
          entry: bosLevel.toFixed(2),
          dual,
          condition: `${structure.bos.type} — held as ${isBull ? 'support' : 'resistance'} (score ${pts})`,
          tf,
        });
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // SETUP 3: Discount / Premium OB Entry
  // ────────────────────────────────────────────────────────────
  const lookbackRange = candles.slice(-50);
  const rangeHigh = Math.max(...lookbackRange.map(c => c.high));
  const rangeLow  = Math.min(...lookbackRange.map(c => c.low));
  const midPoint  = (rangeHigh + rangeLow) / 2;
  const isDiscount = currentPrice < midPoint;
  const isPremium  = currentPrice > midPoint;

  if (structure.trend === 'BULLISH' && isDiscount) {
    const bullOBs = (obs || []).filter(o =>
      o.type === 'BULLISH' &&
      o.high < currentPrice * 1.01 &&
      o.high > currentPrice * 0.985
    ).sort((a, b) => (b.score || 0) - (a.score || 0));

    if (bullOBs.length > 0) {
      const ob = bullOBs[0];
      const wickedIntoOB = current.low <= ob.high || prev1.low <= ob.high || prev2.low <= ob.high;
      const closedAboveOB = closedAbove(current, ob.high) || closedAbove(prev1, ob.high);
      const bullishCandle = current.close > current.open;
      const prevBullishHolding = prev1.close > prev1.open && closedAbove(current, ob.high);

      if (wickedIntoOB && closedAboveOB && (bullishCandle || prevBullishHolding)) {
        let pts = 3;
        if (ob.strength >= 3) pts += 1;
        if (ob.age && ob.age < 15) pts += 1;
        if (bullishCandle) pts += 1;

        const dual = calcDualSL(ob.high, true, ob.low);
        setups.push({
          type: 'BUY',
          name: 'DISCOUNT OB ENTRY',
          confidence: scoreToConfidence(pts),
          score: pts,
          entry: ob.high.toFixed(2),
          dual,
          condition: `Bullish OB $${ob.high.toFixed(2)} (str ${ob.strength}x) — rejection confirmed`,
          tf,
        });
      }
    }
  }

  if (structure.trend === 'BEARISH' && isPremium) {
    const bearOBs = (obs || []).filter(o =>
      o.type === 'BEARISH' &&
      o.low > currentPrice * 0.99 &&
      o.low < currentPrice * 1.015
    ).sort((a, b) => (b.score || 0) - (a.score || 0));

    if (bearOBs.length > 0) {
      const ob = bearOBs[0];
      const wickedIntoOB = current.high >= ob.low || prev1.high >= ob.low || prev2.high >= ob.low;
      const closedBelowOB = closedBelow(current, ob.low) || closedBelow(prev1, ob.low);
      const bearishCandle = current.close < current.open;
      const prevBearishHolding = prev1.close < prev1.open && closedBelow(current, ob.low);

      if (wickedIntoOB && closedBelowOB && (bearishCandle || prevBearishHolding)) {
        let pts = 3;
        if (ob.strength >= 3) pts += 1;
        if (ob.age && ob.age < 15) pts += 1;
        if (bearishCandle) pts += 1;

        const dual = calcDualSL(ob.low, false, ob.high);
        setups.push({
          type: 'SELL',
          name: 'PREMIUM OB ENTRY',
          confidence: scoreToConfidence(pts),
          score: pts,
          entry: ob.low.toFixed(2),
          dual,
          condition: `Bearish OB $${ob.low.toFixed(2)} (str ${ob.strength}x) — rejection confirmed`,
          tf,
        });
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // SETUP 4: Liquidity Grab Reversal
  // ────────────────────────────────────────────────────────────
  for (const pool of (liqPools || [])) {
    const level = pool.price;
    const isBull = pool.type === 'SELL-SIDE'; // SSL grab → long
    if (!recentlyTouched(level, 6, 0.004)) continue;

    // Look for a sweep candle at this level
    let sweepCandle = null;
    for (let i = len - 1; i >= Math.max(0, len - 5); i--) {
      const c = candles[i];
      if (isBull) {
        if (c.low <= level * 1.001 && c.close > level) { sweepCandle = c; break; }
      } else {
        if (c.high >= level * 0.999 && c.close < level) { sweepCandle = c; break; }
      }
    }
    if (!sweepCandle) continue;

    // Confirmation on following candle if sweep was previous
    if (sweepCandle === prev1) {
      const confirmed = isBull ? current.close > prev1.close : current.close < prev1.close;
      if (!confirmed) continue;
    }

    let pts = 4;
    if ((isBull && structure.trend !== 'BEARISH') || (!isBull && structure.trend !== 'BULLISH')) pts += 1;

    const liqEntry = isBull ? level + 0.50 : level - 0.50;
    const dual = calcDualSL(liqEntry, isBull, level);
    setups.push({
      type: isBull ? 'BUY' : 'SELL',
      name: 'LIQUIDITY GRAB REVERSAL',
      confidence: scoreToConfidence(pts),
      score: pts,
      entry: liqEntry.toFixed(2),
      dual,
      condition: `${pool.description} at $${level.toFixed(2)} — sweep + close back through`,
      tf,
    });
    break; // one liquidity setup at a time
  }

  // Sort by score descending so highest confluence shows first
  setups.sort((a, b) => (b.score || 0) - (a.score || 0));
  return setups;
}

// ============================================================
// CHART RENDERER
// ============================================================

function renderChart(candles, tf) {
  const canvas = document.getElementById('mainChart');
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth * window.devicePixelRatio;
  canvas.height = wrap.clientHeight * window.devicePixelRatio;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';

  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio;

  ctx.clearRect(0, 0, W, H);
  if (!candles || candles.length === 0) return;

  // Pan/zoom — clamp offset and candle count to valid range
  const maxOffset = Math.max(0, candles.length - 20);
  STATE.chartOffset = Math.max(0, Math.min(STATE.chartOffset, maxOffset));
  STATE.chartCandleCount = Math.max(20, Math.min(200, STATE.chartCandleCount));

  const endIdx   = candles.length - STATE.chartOffset;
  const startIdx = Math.max(0, endIdx - STATE.chartCandleCount);
  const displayCandles = candles.slice(startIdx, endIdx);
  const isLiveView = STATE.chartOffset === 0;
  const currentPrice = displayCandles[displayCandles.length - 1].close;

  // ── Get exactly 2 BEARISH OBs above + 2 BULLISH OBs below ─
  const allOBs = detectOrderBlocks(candles);

  // Above price: BEARISH OBs = resistance zones (red)
  const obsAbove = allOBs
    .filter(o => o.mid > currentPrice && o.type === 'BEARISH')
    .sort((a,b) => a.mid - b.mid)
    .slice(0, 2);

  // If not enough bearish OBs above, fill with any OB above
  const obsAboveFill = obsAbove.length < 2
    ? allOBs.filter(o => o.mid > currentPrice && o.type !== 'BEARISH')
            .sort((a,b) => a.mid - b.mid)
            .slice(0, 2 - obsAbove.length)
            .map(o => ({...o, type:'BEARISH'})) // treat as resistance
    : [];

  // Below price: BULLISH OBs = support zones (green)
  const obsBelow = allOBs
    .filter(o => o.mid <= currentPrice && o.type === 'BULLISH')
    .sort((a,b) => b.mid - a.mid)
    .slice(0, 2);

  // If not enough bullish OBs below, find recent swing lows as synthetic OBs
  const obsBelowFill = obsBelow.length < 2
    ? allOBs.filter(o => o.mid <= currentPrice && o.type !== 'BULLISH')
            .sort((a,b) => b.mid - a.mid)
            .slice(0, 2 - obsBelow.length)
            .map(o => ({...o, type:'BULLISH'})) // treat as support
    : [];

  const selectedOBs = [
    ...obsAbove, ...obsAboveFill,
    ...obsBelow, ...obsBelowFill,
  ];

  // ── Get top 3 liquidity pools (closest to price) ─────────
  const allPools = detectLiquidityPools(candles, STATE.currentTF);
  const poolsAbove = allPools.filter(p => p.price > currentPrice)
                             .sort((a,b) => a.price - b.price)
                             .slice(0, 2);
  const poolsBelow = allPools.filter(p => p.price <= currentPrice)
                             .sort((a,b) => b.price - a.price)
                             .slice(0, 1);
  const selectedPools = [...poolsAbove, ...poolsBelow];

  // ── Price range — include OBs so they're always visible ──
  const allPrices = [
    ...displayCandles.map(c => c.high),
    ...displayCandles.map(c => c.low),
    ...selectedOBs.map(o => o.high),
    ...selectedOBs.map(o => o.low),
  ];
  const rawHigh = Math.max(...allPrices);
  const rawLow  = Math.min(...allPrices);
  const pad = (rawHigh - rawLow) * 0.05;
  const priceHigh = rawHigh + pad;
  const priceLow  = rawLow  - pad;
  const priceRange = priceHigh - priceLow;

  const padding = { top: 20*dpr, right: 75*dpr, bottom: 20*dpr, left: 6*dpr };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top  - padding.bottom;

  function toX(i) { return padding.left + (i / (displayCandles.length - 1)) * chartW; }
  function toY(p)  { return padding.top  + (1 - (p - priceLow) / priceRange) * chartH; }

  const candleW = Math.max(2*dpr, (chartW / displayCandles.length) * 0.55);

  // ── Background ────────────────────────────────────────────
  ctx.fillStyle = '#0D1013';
  ctx.fillRect(0, 0, W, H);

  // ── Grid ─────────────────────────────────────────────────
  ctx.setLineDash([1*dpr, 4*dpr]);
  ctx.strokeStyle = 'rgba(30,45,61,0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const y = padding.top + (i/6) * chartH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
    const price = priceHigh - (i/6) * priceRange;
    ctx.fillStyle = 'rgba(90,122,150,0.7)';
    ctx.font = `${11*dpr}px IBM Plex Mono, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(1), W - padding.right + 4*dpr, y + 4*dpr);
  }
  ctx.setLineDash([]);

  // ── LAYER 0: Kill Zone shading (behind everything) ───────
  if (STATE.showKillZones) {
    // Kill zones defined in GMT hours
    const killZones = [
      { name: 'ASIAN',    startH: 0,  endH: 3,  color: 'rgba(160,100,255,0.30)', labelColor: 'rgba(200,160,255,1.0)'  },
      { name: 'LONDON',   startH: 8,  endH: 10, color: 'rgba(74,158,255,0.32)',  labelColor: 'rgba(120,190,255,1.0)'  },
      { name: 'NEW YORK', startH: 13, endH: 15, color: 'rgba(224,178,62,0.32)',  labelColor: 'rgba(240,190,60,1.0)'   },
      { name: 'LN CLOSE', startH: 15, endH: 17, color: 'rgba(255,122,122,0.28)', labelColor: 'rgba(255,100,130,0.95)' },
    ];

    killZones.forEach(function(kz) {
      // Find indices of displayCandles that fall within this kill zone (GMT hours)
      let startX = null, endX = null;

      displayCandles.forEach(function(c, i) {
        if (!c.time) return;
        // c.time is "2026-03-29 08:00:00" — parse as UTC/GMT
        var parts = c.time.replace(' ', 'T') + 'Z'; // treat as GMT
        var dt = new Date(parts);
        if (isNaN(dt.getTime())) return;
        var gmtHour = dt.getUTCHours();
        var inZone  = gmtHour >= kz.startH && gmtHour < kz.endH;
        if (inZone) {
          var x = toX(i);
          if (startX === null || x < startX) startX = x;
          if (endX   === null || x > endX)   endX   = x;
        }
      });

      if (startX !== null && endX !== null) {
        // Extend by half a candle width each side
        var halfCandle = candleW * 0.5;
        startX = Math.max(padding.left, startX - halfCandle);
        endX   = Math.min(W - padding.right, endX + halfCandle);
        var zoneW = endX - startX;

        // Shaded background
        ctx.fillStyle = kz.color;
        ctx.fillRect(startX, padding.top, zoneW, chartH);

        // Left and right border lines for zone boundaries
        ctx.strokeStyle = kz.labelColor.replace('0.95', '0.5');
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([3*dpr, 3*dpr]);
        ctx.beginPath(); ctx.moveTo(startX, padding.top); ctx.lineTo(startX, padding.top + chartH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(endX,   padding.top); ctx.lineTo(endX,   padding.top + chartH); ctx.stroke();
        ctx.setLineDash([]);

        // Left and right border lines at zone edges
        ctx.strokeStyle = kz.labelColor;
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([3*dpr, 3*dpr]);
        ctx.beginPath(); ctx.moveTo(startX, padding.top); ctx.lineTo(startX, padding.top + chartH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(endX,   padding.top); ctx.lineTo(endX,   padding.top + chartH); ctx.stroke();
        ctx.setLineDash([]);

        // Top label with background
        const kzLabel = kz.name;
        ctx.font = 'bold ' + (11 * dpr) + 'px IBM Plex Mono, monospace';
        const kzLabelW = ctx.measureText(kzLabel).width + 8*dpr;
        ctx.fillStyle = 'rgba(13,16,19,0.8)';
        ctx.fillRect(startX + zoneW/2 - kzLabelW/2, padding.top + 2*dpr, kzLabelW, 15*dpr);
        ctx.fillStyle = kz.labelColor;
        ctx.textAlign = 'center';
        ctx.fillText(kzLabel, startX + zoneW / 2, padding.top + 14 * dpr);
      }
    });
  }

  // ── LAYER 1: OB transparent boxes (drawn first, behind candles) ──
  selectedOBs.forEach(ob => {
    const isBull = ob.type === 'BULLISH';
    const y1 = toY(Math.max(ob.high, ob.low));
    const y2 = toY(Math.min(ob.high, ob.low));
    const boxH = Math.max(4*dpr, Math.abs(y2 - y1));

    // Transparent fill — green for bullish, red for bearish
    ctx.fillStyle = isBull ? 'rgba(61,214,160,0.15)' : 'rgba(255,60,100,0.15)';
    ctx.fillRect(padding.left, y1, chartW, boxH);

    // Top and bottom border lines
    ctx.strokeStyle = isBull ? 'rgba(61,214,160,0.7)' : 'rgba(255,60,100,0.7)';
    ctx.lineWidth = 1.5*dpr;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(padding.left, y1); ctx.lineTo(W - padding.right, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padding.left, y1 + boxH); ctx.lineTo(W - padding.right, y1 + boxH); ctx.stroke();

    // Label pill on the LEFT side — short to fit mobile
    const label = `${isBull ? '▲' : '▼'} OB  ${ob.mid.toFixed(2)}`;
    ctx.font = `bold ${11*dpr}px IBM Plex Mono, monospace`;
    const lw = ctx.measureText(label).width + 10*dpr;
    const lx = padding.left + 4*dpr;

    // Fix 3: Offset label vertically to avoid overlap between close OBs
    // Place label near top border of box, not center
    const ly = y1 + 13*dpr;

    ctx.fillStyle = isBull ? 'rgba(61,214,160,0.92)' : 'rgba(255,60,100,0.92)';
    ctx.beginPath();
    ctx.roundRect(lx, ly - 11*dpr, lw, 16*dpr, 3*dpr);
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 5*dpr, ly + 2*dpr);
  });

  // ── LAYER 2: Liquidity lines (dashed, behind candles) ────
  selectedPools.forEach((pool, idx) => {
    const y = toY(pool.price);
    const isBuy = pool.type === 'BUY-SIDE';

    // Dashed line
    ctx.strokeStyle = isBuy ? 'rgba(74,158,255,0.6)' : 'rgba(74,158,255,0.6)';
    ctx.lineWidth = 1*dpr;
    ctx.setLineDash([5*dpr, 4*dpr]);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label on right — stagger vertically to avoid overlap
    const offset = idx % 2 === 0 ? -8*dpr : 10*dpr;
    const liqLabel = `${isBuy ? '▲' : '▼'} LIQ  ${pool.price.toFixed(2)}`;
    ctx.font = `${10*dpr}px IBM Plex Mono, monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(74,158,255,0.9)';
    ctx.fillText(liqLabel, W - padding.right - 2*dpr, y + offset);
  });

  // ── LAYER 3: Candles (on top of zones) ───────────────────
  displayCandles.forEach((c, i) => {
    const x = toX(i);
    const openY  = toY(c.open);
    const closeY = toY(c.close);
    const highY  = toY(c.high);
    const lowY   = toY(c.low);
    const isBull = c.close >= c.open;

    // Wick
    ctx.strokeStyle = isBull ? '#3DD6A0' : '#FF7A7A';
    ctx.lineWidth = Math.max(1*dpr, candleW * 0.12);
    ctx.beginPath(); ctx.moveTo(x, highY); ctx.lineTo(x, lowY); ctx.stroke();

    // Body
    const bodyTop = Math.min(openY, closeY);
    const bodyH   = Math.max(2*dpr, Math.abs(openY - closeY));
    ctx.fillStyle = isBull ? 'rgba(61,214,160,0.9)' : 'rgba(255,122,122,0.9)';
    ctx.fillRect(x - candleW/2, bodyTop, candleW, bodyH);
  });

  // ── LAYER 4: Swing markers (small dots above/below wicks) ─
  const { highs: swingHighs, lows: swingLows } = findSwings(displayCandles, 3);
  swingHighs.slice(-4).forEach(sh => {
    const x = toX(sh.index);
    const y = toY(sh.price) - 7*dpr;
    ctx.fillStyle = 'rgba(255,122,122,0.9)';
    ctx.font = `${10*dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('▼', x, y);
  });
  swingLows.slice(-4).forEach(sl => {
    const x = toX(sl.index);
    const y = toY(sl.price) + 13*dpr;
    ctx.fillStyle = 'rgba(61,214,160,0.9)';
    ctx.font = `${10*dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('▲', x, y);
  });

  // ── LAYER 5: Fibonacci (drawn from 4H swing high/low) ───
  if (STATE.showFibo) {
    const h4Candles = STATE.candles['4H'];
    if (h4Candles && h4Candles.length > 20) {
      // Find swing high and swing low from 4H using last 60 candles
      // Use last 60 4H candles (~10 days) for swing detection
      const h4Slice = h4Candles.slice(-60);
      const totalLen = h4Slice.length;

      // Find ALL swing highs and lows using 3-candle lookback each side
      // A swing high: highest candle among 3 left + 3 right neighbours
      const allSwingHighs = [];
      const allSwingLows  = [];

      for (let i = 3; i < totalLen - 3; i++) {
        const c = h4Slice[i];
        let isHigh = true, isLow = true;
        for (let j = 1; j <= 3; j++) {
          if (c.high <= h4Slice[i-j].high || c.high <= h4Slice[i+j].high) isHigh = false;
          if (c.low  >= h4Slice[i-j].low  || c.low  >= h4Slice[i+j].low)  isLow  = false;
        }
        if (isHigh) allSwingHighs.push({ price: c.high, idx: i });
        if (isLow)  allSwingLows.push({ price: c.low,  idx: i });
      }

      // Pick the most recent significant swing high and low
      // "Significant" = the highest swing high and lowest swing low in the last 60 candles
      // But prefer the most recent one if two swings are within 1% of each other
      let bestHigh = null, bestLow = null;

      if (allSwingHighs.length > 0) {
        // Most recent swing high that is also a major high (within top 30% of all swing highs)
        const maxHighPrice = Math.max(...allSwingHighs.map(s=>s.price));
        const threshold = maxHighPrice * 0.97; // within 3% of the absolute high
        const significantHighs = allSwingHighs.filter(s => s.price >= threshold);
        // Pick the most recent among significant ones
        bestHigh = significantHighs.reduce((a,b) => b.idx > a.idx ? b : a);
      }
      if (!bestHigh && allSwingHighs.length > 0) {
        bestHigh = allSwingHighs[allSwingHighs.length - 1]; // fallback: most recent
      }

      if (allSwingLows.length > 0) {
        const minLowPrice = Math.min(...allSwingLows.map(s=>s.price));
        const threshold = minLowPrice * 1.03;
        const significantLows = allSwingLows.filter(s => s.price <= threshold);
        bestLow = significantLows.reduce((a,b) => b.idx > a.idx ? b : a);
      }
      if (!bestLow && allSwingLows.length > 0) {
        bestLow = allSwingLows[allSwingLows.length - 1];
      }

      // Direction uses swing point indices
      if (!bestHigh) bestHigh = { price: Math.max(...h4Slice.map(c=>c.high)), idx: 0 };
      if (!bestLow)  bestLow  = { price: Math.min(...h4Slice.map(c=>c.low)),  idx: 0 };

      const isBullish4H = bestLow.idx > bestHigh.idx;

      // Anchors use ABSOLUTE high/low of the 60-candle window — not the swing point prices
      // This ensures 0% and 100% sit exactly on the true extreme candles
      const fiboHigh  = Math.max(...h4Slice.map(c=>c.high));
      const fiboLow   = Math.min(...h4Slice.map(c=>c.low));
      const fiboRange = fiboHigh - fiboLow;

      // Fibonacci levels — 0% at high, 100% at low for bearish; reversed for bullish
      const fiboLevels = [
        { ratio: 0,     label: '0',     color: 'rgba(200,200,200,0.7)',  width: 1.5, dash: false },
        { ratio: 0.236, label: '23.6',  color: 'rgba(200,200,200,0.85)', width: 1.5, dash: false },
        { ratio: 0.382, label: '38.2',  color: 'rgba(224,178,62,1.0)',   width: 2.5, dash: false }, // GOLD — highest prob
        { ratio: 0.5,   label: '50.0',  color: 'rgba(100,180,255,1.0)',  width: 2,   dash: false },
        { ratio: 0.618, label: '61.8',  color: 'rgba(61,214,160,1.0)',    width: 2,   dash: false },
        { ratio: 0.786, label: '78.6',  color: 'rgba(200,200,200,0.6)',  width: 1,   dash: true  },
        { ratio: 1,     label: '100',   color: 'rgba(200,200,200,0.7)',  width: 1.5, dash: false },
        { ratio: 1.272, label: '127.2', color: 'rgba(255,100,130,0.9)',  width: 1.5, dash: true  },
        { ratio: 1.618, label: '161.8', color: 'rgba(255,122,122,1.0)',   width: 2,   dash: true  },
      ];

      fiboLevels.forEach(function(fl) {
        // Bullish: 0% = swing low (bottom), 100% = swing high (top)
        //          levels increase upward — 38.2 is above 0, below 50
        // Bearish: 0% = swing high (top), 100% = swing low (bottom)
        //          levels decrease downward — 38.2 is below 0, above 50
        const price = isBullish4H
          ? fiboLow  + (fl.ratio * fiboRange)   // bullish: levels go UP from low
          : fiboHigh - (fl.ratio * fiboRange);   // bearish: levels go DOWN from high

        // Only draw if price is within chart visible range
        if (price < priceLow || price > priceHigh) return;

        const y = toY(price);

        ctx.strokeStyle = fl.color;
        ctx.lineWidth = fl.width * dpr;
        ctx.setLineDash(fl.dash ? [4*dpr, 4*dpr] : []);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(W - padding.right, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label on right side with background box for readability
        const labelText = fl.label + '%  ' + price.toFixed(2);
        const fontSize = fl.ratio === 0.382 ? 11*dpr : 10*dpr;
        ctx.font = (fl.ratio === 0.382 ? 'bold ' : '') + fontSize + 'px IBM Plex Mono, monospace';
        ctx.textAlign = 'right';
        const textW = ctx.measureText(labelText).width;
        // Semi-transparent background behind label
        ctx.fillStyle = 'rgba(13,16,19,0.75)';
        ctx.fillRect(W - padding.right - textW - 6*dpr, y - fontSize - 2*dpr, textW + 6*dpr, fontSize + 4*dpr);
        ctx.fillStyle = fl.color;
        ctx.fillText(labelText, W - padding.right - 2*dpr, y - 3*dpr);
      });

      // Draw a small annotation showing swing points used
      ctx.fillStyle = 'rgba(224,178,62,0.5)';
      ctx.font = (9*dpr) + 'px IBM Plex Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText('FIBO · 4H · ' + (isBullish4H ? 'BULL' : 'BEAR'), W - padding.right - 4*dpr, padding.top + 14*dpr);
    }
  }

  // ── LAYER 6: Current price line + label ──────────────────
  const currentY = toY(currentPrice);
  ctx.strokeStyle = 'rgba(224,178,62,0.9)';
  ctx.lineWidth = 1.5*dpr;
  ctx.setLineDash([4*dpr, 3*dpr]);
  ctx.beginPath();
  ctx.moveTo(padding.left, currentY);
  ctx.lineTo(W - padding.right, currentY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Gold price label box
  const lblW = padding.right - 2*dpr;
  const lblH = 20*dpr;
  ctx.fillStyle = '#E0B23E';
  ctx.beginPath();
  ctx.roundRect(W - padding.right + 1*dpr, currentY - lblH/2, lblW, lblH, 3*dpr);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = `bold ${11*dpr}px IBM Plex Mono, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(currentPrice.toFixed(2), W - padding.right + lblW/2, currentY + 4*dpr);

  // ── LAYER 7: LIVE / HISTORICAL indicator ─────────────────
  const viewLabel = isLiveView ? '● LIVE' : '◀ HISTORICAL';
  const viewColor = isLiveView ? 'rgba(61,214,160,0.8)' : 'rgba(224,178,62,0.8)';
  ctx.font = (9*dpr) + 'px IBM Plex Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = viewColor;
  ctx.fillText(viewLabel, padding.left + 4*dpr, padding.top + 12*dpr);

  // ── LAYER 8: OHLC Tooltip ────────────────────────────────
  if (STATE.tooltip !== null) {
    const ti = STATE.tooltip.index;
    if (ti >= 0 && ti < displayCandles.length) {
      const tc = displayCandles[ti];
      const isBullC = tc.close >= tc.open;
      const candleRange = (tc.high - tc.low).toFixed(2);

      // Format candle open time — c.time is "2026-04-09 14:00:00"
      let timeLabel = '';
      try {
        const dt = new Date(tc.time.replace(' ', 'T') + '+00:00'); // treat as UTC
        // Convert to WAT (UTC+1)
        const watDt = new Date(dt.getTime() + 60 * 60000);
        timeLabel = watDt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
                  + '  ' + watDt.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false }) + ' WAT';
      } catch(e) { timeLabel = tc.time || ''; }

      // Build tooltip lines
      const lines = [
        { label: timeLabel,                        color: 'rgba(224,178,62,0.9)', bold: true  },
        { label: 'O: ' + tc.open.toFixed(2),       color: 'rgba(200,200,200,0.9)', bold: false },
        { label: 'H: ' + tc.high.toFixed(2),       color: 'rgba(61,214,160,1.0)',   bold: false },
        { label: 'L: ' + tc.low.toFixed(2),        color: 'rgba(255,122,122,1.0)',  bold: false },
        { label: 'C: ' + tc.close.toFixed(2),      color: isBullC ? 'rgba(61,214,160,1.0)' : 'rgba(255,122,122,1.0)', bold: true },
        { label: 'Range: ' + candleRange + ' pts', color: 'rgba(150,150,150,0.8)', bold: false },
        { label: isBullC ? '▲ BULLISH' : '▼ BEARISH', color: isBullC ? 'rgba(61,214,160,1.0)' : 'rgba(255,122,122,1.0)', bold: true },
      ];

      const fontSize  = 10 * dpr;
      const lineH     = fontSize * 1.7;
      const tipPadX   = 8 * dpr;
      const tipPadY   = 8 * dpr;
      const tipH      = lines.length * lineH + tipPadY * 2;

      // Measure widest line
      ctx.font = 'bold ' + fontSize + 'px IBM Plex Mono, monospace';
      let maxW = 0;
      lines.forEach(function(l) {
        const w = ctx.measureText(l.label).width;
        if (w > maxW) maxW = w;
      });
      const tipW = maxW + tipPadX * 2;

      // X position — candle x coordinate
      const candleX = toX(ti);

      // Flip to left side if too close to right edge
      let tipX = candleX + 10 * dpr;
      if (tipX + tipW > W - padding.right - 4*dpr) {
        tipX = candleX - tipW - 10 * dpr;
      }
      // Clamp to left edge
      tipX = Math.max(padding.left + 2*dpr, tipX);

      // Y position — near top of chart, clamp to bottom
      let tipY = padding.top + 20 * dpr;
      if (tipY + tipH > H - padding.bottom - 4*dpr) {
        tipY = H - padding.bottom - tipH - 4*dpr;
      }

      // Draw vertical crosshair line at candle
      ctx.strokeStyle = 'rgba(224,178,62,0.3)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3*dpr, 3*dpr]);
      ctx.beginPath();
      ctx.moveTo(candleX, padding.top);
      ctx.lineTo(candleX, H - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tooltip background
      ctx.fillStyle = 'rgba(8,14,22,0.96)';
      ctx.strokeStyle = 'rgba(224,178,62,0.5)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.roundRect(tipX, tipY, tipW, tipH, 4*dpr);
      ctx.fill();
      ctx.stroke();

      // Draw each line
      lines.forEach(function(l, i) {
        ctx.font = (l.bold ? 'bold ' : '') + fontSize + 'px IBM Plex Mono, monospace';
        ctx.fillStyle = l.color;
        ctx.textAlign = 'left';
        ctx.fillText(l.label, tipX + tipPadX, tipY + tipPadY + fontSize + i * lineH);
      });
    }
  }
}

// ============================================================
// UI UPDATERS
// ============================================================

function updateStructureBadges(candles, tf) {
  const struct = detectStructure(candles);
  const pattern = detectPattern(candles);
  const sweep = detectSweep(candles);
  const choch = detectCHoCH(candles.slice(-20), tf);

  const container = document.getElementById('structureBadges');
  container.innerHTML = '';

  const badges = [];

  // Trend
  const trendClass = struct.trend === 'BULLISH' ? 'bull' : struct.trend === 'BEARISH' ? 'bear' : 'neutral';
  badges.push(`<span class="badge ${trendClass}">${struct.trend}</span>`);

  // BOS
  if (struct.bos) {
    badges.push(`<span class="badge ${struct.bos.type.includes('BULL') ? 'bull' : 'bear'}">${struct.bos.type}</span>`);
  }

  // CHoCH
  if (choch) {
    badges.push(`<span class="badge warn">${choch.type}</span>`);
  }

  // Pattern
  if (pattern) {
    const pc = pattern.type === 'bull' ? 'bull' : pattern.type === 'bear' ? 'bear' : 'neutral';
    badges.push(`<span class="badge ${pc}">${pattern.name}</span>`);
  }

  // Sweep
  if (sweep) {
    badges.push(`<span class="badge gold">⚡ ${sweep.type}</span>`);
  }

  // TF indicator
  badges.push(`<span class="badge neutral" style="margin-left:auto">${tf}</span>`);

  container.innerHTML = badges.join('');
}

function updateConditionPanel(candles, tf) {
  const struct = detectStructure(candles);
  const pattern = detectPattern(candles);
  const sweep = detectSweep(candles);
  const choch = detectCHoCH(candles.slice(-20), tf);
  const current = candles[candles.length - 1];

  const mainEl = document.getElementById('conditionMain');
  const detailEl = document.getElementById('conditionDetail');

  let mainText = '';
  let mainClass = '';
  let detail = '';

  if (choch && sweep) {
    mainClass = choch.type.includes('BULL') ? 'bull' : 'bear';
    mainText = choch.type.includes('BULL') ? '⚡ BULLISH REVERSAL SIGNAL' : '⚡ BEARISH REVERSAL SIGNAL';
    detail = `${sweep.type} detected at $${sweep.level.toFixed(2)}. ${choch.type} confirmed on ${tf}. This is the highest-probability setup: liquidity swept, structure confirmed, looking for continuation.`;
  } else if (struct.bos) {
    mainClass = struct.bos.type.includes('BULL') ? 'bull' : 'bear';
    mainText = struct.bos.type.includes('BULL') ? '📈 BULLISH BREAKOUT' : '📉 BEARISH BREAKOUT';
    detail = `${struct.bos.type} at $${struct.bos.level.toFixed(2)}. Price is breaking structure. Watch for BOS retest entry — wait for price to pull back to broken level, confirm hold, enter in direction of break.`;
  } else if (pattern) {
    mainClass = pattern.type === 'bull' ? 'bull' : pattern.type === 'bear' ? 'bear' : 'neutral';
    mainText = pattern.name;
    detail = pattern.detail || `${pattern.name} in formation. ${pattern.type === 'bull' ? `Watch for breakout above $${pattern.breakout?.toFixed(2) || 'resistance'} for long entry.` : pattern.type === 'bear' ? `Watch for breakdown below $${pattern.breakout?.toFixed(2) || 'support'} for short entry.` : 'No directional bias — wait for range break.'}`;
  } else if (struct.trend !== 'RANGING') {
    mainClass = struct.trend === 'BULLISH' ? 'bull' : 'bear';
    mainText = `${struct.trend} STRUCTURE`;
    detail = `${struct.trend} market structure intact. ${struct.trend === 'BULLISH' ? 'Higher Highs and Higher Lows forming. Buy pullbacks to OBs in discount zone.' : 'Lower Lows and Lower Highs forming. Sell rallies to OBs in premium zone.'}`;
  } else {
    mainClass = 'neutral';
    mainText = 'RANGING / NO BIAS';
    detail = 'Price is in consolidation. No directional trade. Identify range high and low, watch for liquidity sweep at extremes to catch the breakout direction.';
  }

  mainEl.className = `condition-main ${mainClass}`;
  mainEl.textContent = mainText;
  detailEl.textContent = detail;
}

function updateLevelsPanel(candles, tf) {
  const panel = document.getElementById('levelsPanel');
  const obs = detectOrderBlocks(candles);
  const pools = detectLiquidityPools(candles, tf || STATE.currentTF);
  const fvgs = detectFVG(candles);
  const current = candles[candles.length - 1].close;

  let html = '';

  // Current price
  html += `<div class="level-row" style="padding-bottom:10px;margin-bottom:4px;">
    <span class="level-label">CURRENT PRICE</span>
    <span class="level-price" style="color:var(--gold)">${current.toFixed(2)}</span>
  </div>`;

  // Liquidity pools above
  const above = pools.filter(p => p.price > current).sort((a, b) => a.price - b.price);
  const below = pools.filter(p => p.price < current).sort((a, b) => b.price - a.price);

  if (above.length > 0) {
    html += `<div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim);letter-spacing:1px;padding:6px 0 4px;border-bottom:1px solid var(--border);">▲ LEVELS ABOVE</div>`;
    above.slice(0, 3).forEach(p => {
      html += `<div class="level-row">
        <span class="level-label">${p.description}</span>
        <span class="level-type liq">LIQ</span>
        <span class="level-price">${p.price.toFixed(2)}</span>
      </div>`;
    });
  }

  // OBs above
  const obsAbove = obs.filter(o => o.mid > current).sort((a, b) => a.mid - b.mid);
  obsAbove.slice(0, 2).forEach(ob => {
    html += `<div class="level-row">
      <span class="level-label">${ob.type} OB (str: ${ob.strength}x)</span>
      <span class="level-type ob-bear">BEAR OB</span>
      <span class="level-price">${ob.mid.toFixed(2)}</span>
    </div>`;
  });

  // FVGs above
  fvgs.filter(f => f.mid > current).slice(0, 1).forEach(fvg => {
    html += `<div class="level-row">
      <span class="level-label">${fvg.type} FVG</span>
      <span class="level-type fvg">FVG</span>
      <span class="level-price">${fvg.mid.toFixed(2)}</span>
    </div>`;
  });

  // Levels below
  if (below.length > 0 || obs.filter(o => o.mid < current).length > 0) {
    html += `<div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim);letter-spacing:1px;padding:6px 0 4px;border-bottom:1px solid var(--border);margin-top:6px;">▼ LEVELS BELOW</div>`;
    below.slice(0, 3).forEach(p => {
      html += `<div class="level-row">
        <span class="level-label">${p.description}</span>
        <span class="level-type liq">LIQ</span>
        <span class="level-price">${p.price.toFixed(2)}</span>
      </div>`;
    });
  }

  // OBs below
  const obsBelow = obs.filter(o => o.mid < current).sort((a, b) => b.mid - a.mid);
  obsBelow.slice(0, 2).forEach(ob => {
    html += `<div class="level-row">
      <span class="level-label">${ob.type} OB (str: ${ob.strength}x)</span>
      <span class="level-type ob-bull">BULL OB</span>
      <span class="level-price">${ob.mid.toFixed(2)}</span>
    </div>`;
  });

  // FVGs below
  fvgs.filter(f => f.mid < current).slice(0, 1).forEach(fvg => {
    html += `<div class="level-row">
      <span class="level-label">${fvg.type} FVG</span>
      <span class="level-type fvg">FVG</span>
      <span class="level-price">${fvg.mid.toFixed(2)}</span>
    </div>`;
  });

  panel.innerHTML = html || '<div class="no-data">No significant levels detected</div>';
}

function updateSetupsPanel(candles, tf) {
  // Always generate setups for BOTH 1H and 15M regardless of chart TF
  const allSetups = [];

  const tfsToCheck = ['1H', '15min'];
  // Get 1H bias first for confluence filter
  const candles1H = STATE.candles['1H'] || [];
  const bias1H = candles1H.length > 20 ? detectStructure(candles1H).trend : 'RANGING';

  tfsToCheck.forEach(function(signalTF) {
    const c = STATE.candles[signalTF];
    if (!c || c.length < 20) return;
    const struct = detectStructure(c);
    const obs    = detectOrderBlocks(c);
    const pools  = detectLiquidityPools(c, signalTF);
    const fvgs   = detectFVG(c);
    const setups = generateSetups(c, signalTF, struct, obs, pools, fvgs);

    setups.forEach(function(s) {
      // Confluence filter — 15M must match 1H bias unless 1H is RANGING
      if (signalTF === '15min' && bias1H !== 'RANGING') {
        if (s.type === 'BUY' && bias1H === 'BEARISH') return; // conflict — skip
        if (s.type === 'SELL' && bias1H === 'BULLISH') return; // conflict — skip
      }
      s.signalTF = signalTF;
      allSetups.push(s);
    });
  });

  const panel = document.getElementById('setupsPanel');

  if (allSetups.length === 0) {
    panel.innerHTML = '<div class="no-data">No high-probability setups currently. Market may be mid-range. Wait for key level approach.</div>';
    return;
  }

  // Register each setup in trade log — deduped by rounded entry + type + tf
  allSetups.forEach(function(s) {
    // Round entry to nearest 0.5 for stable key across refreshes
    const roundedEntry = Math.round(parseFloat(s.entry) * 2) / 2;
    const tradeKey = 'setup|' + s.type + '|' + roundedEntry + '|' + s.signalTF;
    if (!STATE.seenAlerts.has(tradeKey)) {
      // First time seeing this setup — record time and register
      const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      STATE.seenAlerts.set(tradeKey, time);
      registerTrade({
        type:        s.type,
        name:        s.name,
        entry:       parseFloat(s.entry),
        dual:        s.dual,
        tf:          s.signalTF,
        time:        time,
        candleIndex: (STATE.candles[s.signalTF] || []).length - 1,
      });
    }
  });

  const setups = allSetups; // use combined list below

  let html = '';
  setups.forEach(s => {
    const cls = s.type === 'BUY' ? 'buy' : 'sell';
    const arrow = s.type === 'BUY' ? '▲' : '▼';
    const activeKZ = getActiveKillZone();
    // Boost confidence to HIGH if setup fires during a kill zone
    const effectiveConf = (activeKZ && s.confidence !== 'HIGH') ? 'HIGH*' : s.confidence;
    const confColor = effectiveConf === 'HIGH' || effectiveConf === 'HIGH*' ? 'var(--bull)' : 'var(--warn)';
    const tfBadgeColor = s.signalTF === '1H' ? 'var(--neutral)' : 'var(--gold)';
    // Get original triggered time from seenAlerts Map — falls back to now if not found
    const roundedEntry = Math.round(parseFloat(s.entry) * 2) / 2;
    const tradeKey = 'setup|' + s.type + '|' + roundedEntry + '|' + s.signalTF;
    const originalTime = STATE.seenAlerts.get(tradeKey);
    const triggeredTime = originalTime || new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const triggeredDate = new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    const d = s.dual;
    // Build TP rows for SL1
    const tp1rows = d.tp.sl1.map(t =>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${t.label}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-bright)">$${t.price}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${t.pips}p</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--bull)">+$${t.profit}</span>
      </div>`
    ).join('');
    const tp2rows = d.tp.sl2.map(t =>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${t.label}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-bright)">$${t.price}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${t.pips}p</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--bull)">+$${t.profit}</span>
      </div>`
    ).join('');

    html += `<div class="alert-item ${cls} new" style="padding:14px;">
      <div class="alert-header">
        <span class="alert-type" style="font-size:15px;">${arrow} ${s.name}</span>
        <span style="display:flex;gap:6px;align-items:center;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,0.07);color:${tfBadgeColor}">${s.signalTF || s.tf}</span>
          <span class="alert-time" style="color:${confColor};font-size:13px;">${effectiveConf}${activeKZ ? ' 🕐' : ''}</span>
        </span>
      </div>
      <div class="alert-text" style="margin:8px 0;font-size:14px;">${s.condition}</div>

      <!-- ENTRY -->
      <div style="display:flex;justify-content:space-between;align-items:center;
           padding:8px 10px;background:rgba(224,178,62,0.1);border-radius:4px;margin-bottom:8px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--gold)">ENTRY</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:17px;color:var(--gold);font-weight:bold;">$${s.entry}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${s.tf}</span>
      </div>
      <!-- TIME TRIGGERED -->
      <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim);
           margin-bottom:8px;padding:4px 8px;background:rgba(255,255,255,0.03);border-radius:3px;
           display:flex;justify-content:space-between;">
        <span>⏱ TRIGGERED</span>
        <span style="color:var(--gold)">${triggeredTime}</span>
        <span>${triggeredDate}</span>
      </div>

      <!-- SL1 -->
      <div style="background:rgba(255,122,122,0.08);border:1px solid rgba(255,122,122,0.3);
           border-radius:4px;padding:8px 10px;margin-bottom:6px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--bear);
             letter-spacing:1px;margin-bottom:6px;">SL1 — FIXED RISK ($10 MAX)</div>
        <div style="display:flex;justify-content:space-between;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--text-bright)">$${d.sl1.price}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${d.sl1.pips} pips</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--bear)">-$${d.sl1.risk}</span>
        </div>
        <div style="margin-top:6px;">${tp1rows}</div>
      </div>

      <!-- SL2 -->
      <div style="background:rgba(255,170,0,0.06);border:1px solid rgba(255,170,0,0.3);
           border-radius:4px;padding:8px 10px;margin-bottom:4px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--warn);
             letter-spacing:1px;margin-bottom:6px;">SL2 — STRUCTURAL (BELOW SWEEP WICK)</div>
        <div style="display:flex;justify-content:space-between;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--text-bright)">$${d.sl2.price}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${d.sl2.pips} pips</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--warn)">-$${d.sl2.risk}</span>
        </div>
        <div style="margin-top:6px;">${tp2rows}</div>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim);
           margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);">
        LOT: 0.10 &nbsp;|&nbsp; PIP VALUE: $0.10/pip &nbsp;|&nbsp; $10 move = 100 pips = $10 risk
      </div>
    </div>`;
  });

  panel.innerHTML = html;
}

function addAlert(type, title, text, levels) {
  const panel = document.getElementById('alertsPanel');
  const noData = panel.querySelector('.no-data');
  if (noData) noData.remove();

  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  let levelsHTML = '';
  if (levels) {
    levelsHTML = `<div class="alert-levels">`;
    Object.entries(levels).forEach(([k, v]) => {
      levelsHTML += `<div class="alert-level-item"><span class="lbl">${k} </span><span class="val">${v}</span></div>`;
    });
    levelsHTML += `</div>`;
  }

  const el = document.createElement('div');
  el.className = `alert-item ${type} new`;

  // Build dual SL display if levels contain dual SL data
  let slHTML = levelsHTML;
  if (levels && levels.dual) {
    const d = levels.dual;
    const isBuy = type === 'buy';
    slHTML = `
    <div style="margin-top:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;
           padding:6px 8px;background:rgba(224,178,62,0.1);border-radius:4px;margin-bottom:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--gold)">ENTRY</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:16px;color:var(--gold);font-weight:bold;">$${levels.entry}</span>
      </div>
      <div style="background:rgba(255,122,122,0.08);border:1px solid rgba(255,122,122,0.3);border-radius:4px;padding:7px 9px;margin-bottom:5px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--bear);margin-bottom:5px;">SL1 — FIXED ($10 RISK)</div>
        <div style="display:flex;justify-content:space-between;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--text-bright)">$${d.sl1.price}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">${d.sl1.pips} pips</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--bear)">-$${d.sl1.risk}</span>
        </div>
        ${d.tp.sl1.map(t => `<div style="display:flex;justify-content:space-between;padding:2px 0;border-top:1px solid rgba(255,255,255,0.05);margin-top:3px;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">${t.label}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-bright)">$${t.price}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">${t.pips}p</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--bull)">+$${t.profit}</span>
        </div>`).join('')}
      </div>
      <div style="background:rgba(255,170,0,0.06);border:1px solid rgba(255,170,0,0.3);border-radius:4px;padding:7px 9px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--warn);margin-bottom:5px;">SL2 — STRUCTURAL (BELOW SWEEP WICK)</div>
        <div style="display:flex;justify-content:space-between;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--text-bright)">$${d.sl2.price}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">${d.sl2.pips} pips</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--warn)">-$${d.sl2.risk}</span>
        </div>
        ${d.tp.sl2.map(t => `<div style="display:flex;justify-content:space-between;padding:2px 0;border-top:1px solid rgba(255,255,255,0.05);margin-top:3px;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">${t.label}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-bright)">$${t.price}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">${t.pips}p</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--bull)">+$${t.profit}</span>
        </div>`).join('')}
      </div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);margin-top:5px;">
        LOT: 0.10 &nbsp;|&nbsp; $0.10/pip &nbsp;|&nbsp; $10 move = 100 pips = $10 risk
      </div>
    </div>`;
  }

  el.innerHTML = `
    <div class="alert-header">
      <span class="alert-type">${title}</span>
      <span class="alert-time">${time}</span>
    </div>
    <div class="alert-text">${text}</div>
    ${slHTML}
  `;

  panel.insertBefore(el, panel.firstChild);

  // Keep only last 20 alerts
  while (panel.children.length > 20) panel.removeChild(panel.lastChild);

  STATE.alerts.push({ type, title, text, time, levels });
}

function updateMultiTFGrid() {
  const grid = document.getElementById('multiTfGrid');
  const tfs = ['D1', '4H', '1H', '15min'];
  const tfLabels = { D1: 'DAILY', '4H': '4 HOUR', '1H': '1 HOUR', '15min': '15 MIN' };

  let html = '';
  tfs.forEach(tf => {
    const candles = STATE.candles[tf];
    if (!candles || candles.length < 10) {
      html += `<div class="tf-analysis-card">
        <div class="tf-name">${tfLabels[tf]}</div>
        <div class="tf-structure range">LOADING</div>
        <div class="tf-detail">Fetching data...</div>
      </div>`;
      return;
    }

    const struct = detectStructure(candles);
    const pattern = detectPattern(candles);
    const choch = detectCHoCH(candles.slice(-20), tf);
    const sweep = detectSweep(candles);

    const structClass = struct.trend === 'BULLISH' ? 'bull' : struct.trend === 'BEARISH' ? 'bear' : 'range';
    let detail = struct.trend === 'BULLISH' ? 'HH + HL intact' : struct.trend === 'BEARISH' ? 'LL + LH intact' : 'No clear trend';
    if (choch) detail = `⚠ ${choch.type}`;
    if (sweep) detail = `⚡ ${sweep.type}`;
    if (pattern && pattern.name !== 'RANGING / CONSOLIDATION') detail = pattern.name;

    html += `<div class="tf-analysis-card">
      <div class="tf-name">${tfLabels[tf]}</div>
      <div class="tf-structure ${structClass}">${struct.trend}</div>
      <div class="tf-detail">${detail}</div>
    </div>`;
  });

  grid.innerHTML = html;
}

function updateSessionSummary(candles) {
  const summaryEl = document.getElementById('sessionSummary');
  const statsEl = document.getElementById('summaryStats');

  if (!candles || candles.length < 5) return;

  const tfCandlesPerDay = { 'D1': 5, '4H': 6, '1H': 24, '15min': 96 };
  const dayCount = tfCandlesPerDay[STATE.currentTF] || 24;
  const today = candles.slice(-dayCount);
  const todayHigh = Math.max(...today.map(c => c.high));
  const todayLow = Math.min(...today.map(c => c.low));
  const open = today[0].open;
  const current = today[today.length - 1].close;
  const change = current - open;
  const changePct = (change / open * 100).toFixed(2);
  const range = (todayHigh - todayLow).toFixed(2);

  const struct = detectStructure(candles);
  const pattern = detectPattern(candles);
  const obs = detectOrderBlocks(candles);
  const pools = detectLiquidityPools(candles, STATE.currentTF);

  const direction = change > 0 ? 'bullish' : 'bearish';
  const nearOB = obs.find(o => {
    const dist = Math.abs(current - o.mid) / current;
    return dist < 0.015;
  });

  const day = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  let summary = `${day} — Gold is trading ${direction} on the day, `;
  summary += `${change > 0 ? 'up' : 'down'} $${Math.abs(change).toFixed(2)} (${Math.abs(changePct)}%) from open at $${open.toFixed(2)}. `;
  summary += `Today's range: $${todayLow.toFixed(2)} – $${todayHigh.toFixed(2)} (${range} pips). `;
  summary += `Overall ${STATE.currentTF} structure remains ${struct.trend}. `;

  if (nearOB) {
    summary += `Price is currently near a ${nearOB.type} Order Block at $${nearOB.mid.toFixed(2)} — watch for reaction. `;
  }

  if (pattern && pattern.name !== 'RANGING / CONSOLIDATION') {
    summary += `${pattern.name} in development. `;
  }

  const topPool = pools.find(p => p.price > current);
  const botPool = pools.find(p => p.price < current);
  if (topPool) summary += `Next liquidity target above: $${topPool.price.toFixed(2)}. `;
  if (botPool) summary += `Key support liquidity: $${botPool.price.toFixed(2)}.`;

  summaryEl.textContent = summary;

  statsEl.innerHTML = `
    <div class="stat-box">
      <div class="stat-label">TODAY HIGH</div>
      <div class="stat-value" style="font-size:17px;color:var(--bull)">${todayHigh.toFixed(2)}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">TODAY LOW</div>
      <div class="stat-value" style="font-size:17px;color:var(--bear)">${todayLow.toFixed(2)}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">DAILY RANGE</div>
      <div class="stat-value" style="font-size:17px">${range}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">STRUCTURE</div>
      <div class="stat-value" style="font-size:15px;color:${struct.trend === 'BULLISH' ? 'var(--bull)' : struct.trend === 'BEARISH' ? 'var(--bear)' : 'var(--neutral)'}">${struct.trend}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">DAY CHANGE</div>
      <div class="stat-value" style="font-size:17px;color:${change > 0 ? 'var(--bull)' : 'var(--bear)'}">
        ${change > 0 ? '+' : ''}${changePct}%
      </div>
    </div>
    <div class="stat-box">
      <div class="stat-label">ORDER BLOCKS</div>
      <div class="stat-value" style="font-size:17px;color:var(--gold)">${obs.length}</div>
    </div>
  `;
}

// ============================================================
// WEEKLY REPORT
// ============================================================

function openWeeklyReport() {
  try {
  const modal   = document.getElementById('weeklyModal');
  const reportEl = document.getElementById('weeklyReportContent');
  const candles  = STATE.candles['1H'] || STATE.candles[STATE.currentTF] || [];
  const d1       = STATE.candles['D1'] || [];
  const h4       = STATE.candles['4H'] || [];
  const current  = candles.length > 0 ? candles[candles.length-1].close : 0;

  // ── Weekly price data ─────────────────────────────────────
  // Current Mon–Fri week in WAT (on Sat/Sun this is the week that just ended).
  // Candle times are UTC. Weekly stats use D1 bars where intraday data doesn't cover the
  // whole day, because the 100-candle 1H window only reaches back ~4 trading days.
  const WAT_MS   = 60 * 60000;
  const watDate  = ts => new Date(ts + WAT_MS).toISOString().slice(0, 10);
  const nowWAT   = new Date(Date.now() + WAT_MS);
  const todayStr = nowWAT.toISOString().slice(0, 10);
  const dowNow   = nowWAT.getUTCDay();                                  // 0 Sun … 6 Sat
  const sinceMon = dowNow === 0 ? 6 : dowNow === 6 ? 5 : dowNow - 1;    // days since this report's Monday
  const dayData  = [];
  ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach((name, i) => {
    const dateStr = new Date(nowWAT.getTime() - (sinceMon - i) * 86400000).toISOString().slice(0, 10);
    if (dateStr > todayStr) return;                                     // day hasn't happened yet
    const isToday = dateStr === todayStr;
    const dc  = candles.filter(c => { const ts = candleTs(c); return ts && watDate(ts) === dateStr; });
    const bar = d1.find(c => String(c.time).slice(0, 10) === dateStr) || null;
    dayData.push({
      label: isToday ? name + ' (today)' : name,
      dc, bar,
      full: dc.length >= 20 || (isToday && dc.length >= 2),
    });
  });

  const dayOHLC = dayData.map(d => {
    if (d.full) return { o: d.dc[0].open, h: Math.max(...d.dc.map(c => c.high)), l: Math.min(...d.dc.map(c => c.low)), c: d.dc[d.dc.length - 1].close };
    if (d.bar)  return { o: d.bar.open, h: d.bar.high, l: d.bar.low, c: d.bar.close };
    if (d.dc.length >= 2) return { o: d.dc[0].open, h: Math.max(...d.dc.map(c => c.high)), l: Math.min(...d.dc.map(c => c.low)), c: d.dc[d.dc.length - 1].close };
    return null;
  }).filter(Boolean);

  const weekHigh  = dayOHLC.length ? Math.max(...dayOHLC.map(x => x.h)) : (candles.length ? Math.max(...candles.map(c => c.high)) : 0);
  const weekLow   = dayOHLC.length ? Math.min(...dayOHLC.map(x => x.l)) : (candles.length ? Math.min(...candles.map(c => c.low))  : 0);
  const weekOpen  = dayOHLC.length ? dayOHLC[0].o : (candles.length ? candles[0].open : 0);
  const weekChange = weekOpen > 0 ? ((current-weekOpen)/weekOpen*100).toFixed(2) : '0';
  const isBullWeek = parseFloat(weekChange) > 0;

  // ── Structure ─────────────────────────────────────────────
  const struct  = detectStructure(candles);
  const pattern = detectPattern(candles);
  const obs     = detectOrderBlocks(candles);
  const candlesTF = STATE.candles['1H'] ? '1H' : STATE.currentTF;   // pools must be computed on the TF these candles are
  const pools   = detectLiquidityPools(candles, candlesTF);
  const d1Struct = d1.length > 20 ? detectStructure(d1) : null;
  const h4Struct = h4.length > 20 ? detectStructure(h4) : null;

  // ── Day by day narrative ──────────────────────────────────
  // Uses the dayData built above. Intraday (1H) detail where loaded, otherwise the D1 bar.
  function narrateDay(day) {
    const dc = day.dc, label = day.label;
    let dOpen, dHigh, dLow, dClose;
    let events = [];
    let note = '';

    if (day.full) {
      dOpen  = dc[0].open;
      dClose = dc[dc.length-1].close;
      dHigh  = Math.max(...dc.map(c=>c.high));
      dLow   = Math.min(...dc.map(c=>c.low));

      // Detect key events that day
      const daySweep  = detectSweep(dc);
      const dayBOS    = detectStructure(dc).bos;
      const dayCHoCH  = detectCHoCH(dc.slice(-20), '1H');
      const dayOBs    = detectOrderBlocks(dc);
      if (daySweep) events.push(`${daySweep.type === 'BUY-SIDE SWEPT' ? '🔴 BSL swept' : '🟢 SSL swept'} at $${daySweep.level.toFixed(2)}`);
      if (dayBOS)   events.push(`${dayBOS.type} confirmed at $${dayBOS.level.toFixed(2)}`);
      if (dayCHoCH) events.push(`${dayCHoCH.type} on 1H at $${dayCHoCH.level.toFixed(2)}`);
      if (dayOBs.length) events.push(`${dayOBs.length} Order Block${dayOBs.length>1?'s':''} active`);
    } else if (day.bar) {
      dOpen = day.bar.open; dHigh = day.bar.high; dLow = day.bar.low; dClose = day.bar.close;
      note = 'Daily bar — intraday detail not loaded for this day';
    } else if (dc.length >= 2) {
      dOpen  = dc[0].open;
      dClose = dc[dc.length-1].close;
      dHigh  = Math.max(...dc.map(c=>c.high));
      dLow   = Math.min(...dc.map(c=>c.low));
      note = 'Partial intraday data only';
    } else {
      return `<div style="border:1px solid var(--border2);border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--text-dim);">${label} — no data loaded</div>`;
    }

    const dChg    = dClose - dOpen;
    const dChgPct = (dChg/dOpen*100).toFixed(2);
    const dRange  = (dHigh-dLow).toFixed(2);
    const dir     = dChg > 0 ? '▲ BULLISH' : '▼ BEARISH';
    const dirCol  = dChg > 0 ? 'var(--bull)' : 'var(--bear)';

    return `
      <div style="border:1px solid var(--border2);border-radius:6px;padding:12px;margin-bottom:10px;background:rgba(255,255,255,0.02);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--gold);letter-spacing:1px;">${label}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:${dirCol}">${dir} ${dChg>0?'+':''}${dChg.toFixed(2)} (${dChgPct}%)</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px;">
          <div style="text-align:center;padding:4px;background:rgba(61,214,160,0.08);border-radius:4px;">
            <div style="font-size:10px;color:var(--text-dim)">OPEN</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-bright)">${dOpen.toFixed(2)}</div>
          </div>
          <div style="text-align:center;padding:4px;background:rgba(61,214,160,0.08);border-radius:4px;">
            <div style="font-size:10px;color:var(--text-dim)">HIGH</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--bull)">${dHigh.toFixed(2)}</div>
          </div>
          <div style="text-align:center;padding:4px;background:rgba(255,122,122,0.08);border-radius:4px;">
            <div style="font-size:10px;color:var(--text-dim)">LOW</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--bear)">${dLow.toFixed(2)}</div>
          </div>
          <div style="text-align:center;padding:4px;background:rgba(224,178,62,0.08);border-radius:4px;">
            <div style="font-size:10px;color:var(--text-dim)">CLOSE</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--gold)">${dClose.toFixed(2)}</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-dim)">Range: ${dRange} pts &nbsp;|&nbsp; ${events.length ? events.join(' &nbsp;·&nbsp; ') : (note || 'No major structural events')}</div>
      </div>`;
  }

  // ── Trade log ─────────────────────────────────────────────
  function tradeStatusHTML(t) {
    const statusColors = { SL:'var(--bear)', TP1:'var(--bull)', TP2:'var(--bull)', TP3:'var(--bull)', OPEN:'var(--warn)' };
    const statusLabels = { SL:'❌ SL HIT', TP1:'✅ TP1 → BE', TP2:'✅✅ TP1+TP2 → BE', TP3:'✅✅✅ TP1+TP2+TP3', OPEN:'⏳ OPEN' };
    const col   = statusColors[t.status] || 'var(--text-dim)';
    const label = statusLabels[t.status] || t.status;
    const pnlCol = t.pnl > 0 ? 'var(--bull)' : t.pnl < 0 ? 'var(--bear)' : 'var(--text-dim)';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;
           padding:8px 10px;border:1px solid var(--border);border-radius:5px;margin-bottom:6px;
           background:rgba(255,255,255,0.02);">
        <div>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;
                color:${t.type==='BUY'?'var(--bull)':'var(--bear)'};">${t.type==='BUY'?'▲':'▼'} ${t.type}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim);margin-left:8px;">${t.name}</span>
        </div>
        <div style="text-align:center;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--gold)">$${t.entry.toFixed(2)}</div>
          <div style="font-size:10px;color:var(--text-dim)">${t.time} ${t.tf}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:${col}">${label}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:${pnlCol}">${t.pnl>0?'+':''}${t.pnl.toFixed(2)}</div>
        </div>
      </div>`;
  }

  // ── Performance stats ─────────────────────────────────────
  const completedTrades = STATE.tradeLog.filter(t => t.status !== 'OPEN');
  const wins   = completedTrades.filter(t => t.status !== 'SL').length;
  const losses = completedTrades.filter(t => t.status === 'SL').length;
  const openTrades = STATE.tradeLog.filter(t => t.status === 'OPEN').length;
  const winRate = completedTrades.length > 0 ? ((wins/completedTrades.length)*100).toFixed(0) : '–';
  const totalPnL = STATE.tradeLog.reduce((sum,t) => sum+t.pnl, 0);
  const tp1Count = STATE.tradeLog.filter(t => t.tp1Hit).length;
  const tp2Count = STATE.tradeLog.filter(t => t.tp2Hit).length;
  const tp3Count = STATE.tradeLog.filter(t => t.tp3Hit).length;
  const slCount  = completedTrades.filter(t => t.status === 'SL').length;

  // ── Key levels next week ──────────────────────────────────
  // Next-week bias comes from D1 + 4H (per the strategy checklist); 1H is only the fallback
  const htfDirs = [d1Struct && d1Struct.trend, h4Struct && h4Struct.trend].filter(t => t && t !== 'RANGING');
  const htfConflict = htfDirs.length === 2 && htfDirs[0] !== htfDirs[1];
  let biasNext = struct.trend;
  if (d1Struct || h4Struct) {
    biasNext = htfDirs.length === 0 || htfConflict ? 'RANGING' : htfDirs[0];
  }
  const topResist = pools.filter(p=>p.price>current).sort((a,b)=>a.price-b.price).slice(0,3);
  const botSupport = pools.filter(p=>p.price<current).sort((a,b)=>b.price-a.price).slice(0,3);
  const bearOBs   = obs.filter(o=>o.mid>current&&o.type==='BEARISH').sort((a,b)=>a.mid-b.mid).slice(0,2);
  const bullOBs   = obs.filter(o=>o.mid<current&&o.type==='BULLISH').sort((a,b)=>b.mid-a.mid).slice(0,2);

  const now = new Date();
  const weekStr = now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  reportEl.innerHTML = `
    <!-- HEADER -->
    <div style="text-align:center;padding:16px 0 20px;border-bottom:1px solid var(--border);margin-bottom:20px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);letter-spacing:2px;">WEEKLY TRADING REPORT</div>
      <div style="font-family:'Inter',sans-serif;font-size:20px;font-weight:800;color:var(--gold);margin:6px 0;">XAUUSD — GOLD</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim)">Week ending ${weekStr}</div>
      <div style="margin-top:12px;display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
        <div style="text-align:center;">
          <div style="font-size:10px;color:var(--text-dim)">WEEKLY OPEN</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--text-bright)">$${weekOpen.toFixed(2)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px;color:var(--text-dim)">CURRENT</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--gold)">$${current.toFixed(2)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px;color:var(--text-dim)">WEEK HIGH</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--bull)">$${weekHigh.toFixed(2)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px;color:var(--text-dim)">WEEK LOW</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--bear)">$${weekLow.toFixed(2)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px;color:var(--text-dim)">WEEK CHANGE</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;color:${isBullWeek?'var(--bull)':'var(--bear)'}">
            ${isBullWeek?'+':''}${weekChange}%
          </div>
        </div>
      </div>
    </div>

    <!-- SECTION 1: DAY BY DAY -->
    <div class="modal-section">
      <div class="modal-section-title">📅 DAY BY DAY MARKET BREAKDOWN</div>
      ${dayData.map(narrateDay).join('')}
    </div>

    <!-- SECTION 2: TRADE LOG -->
    <div class="modal-section">
      <div class="modal-section-title">📋 TRADE LOG — LAST 7 DAYS</div>
      ${STATE.tradeLog.length === 0
        ? '<div class="modal-text" style="color:var(--text-dim)">No trades recorded in the last 7 days. Trades are recorded in real time as setups fire.</div>'
        : STATE.tradeLog.map(t => tradeStatusHTML(t)).join('')
      }
    </div>

    <!-- SECTION 3: PERFORMANCE -->
    <div class="modal-section">
      <div class="modal-section-title">📊 PERFORMANCE SUMMARY</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
        <div style="text-align:center;padding:10px;background:rgba(61,214,160,0.08);border:1px solid rgba(61,214,160,0.2);border-radius:6px;">
          <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">TOTAL TRADES</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:22px;color:var(--gold)">${STATE.tradeLog.length}</div>
        </div>
        <div style="text-align:center;padding:10px;background:rgba(61,214,160,0.08);border:1px solid rgba(61,214,160,0.2);border-radius:6px;">
          <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">WIN RATE</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:22px;color:${parseInt(winRate)>=60?'var(--bull)':'var(--warn)'}">${winRate}%</div>
        </div>
        <div style="text-align:center;padding:10px;background:${totalPnL>=0?'rgba(61,214,160,0.08)':'rgba(255,122,122,0.08)'};border:1px solid ${totalPnL>=0?'rgba(61,214,160,0.2)':'rgba(255,122,122,0.2)'};border-radius:6px;">
          <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">NET P&L</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:22px;color:${totalPnL>=0?'var(--bull)':'var(--bear)'}">
            ${totalPnL>=0?'+':''}\$${totalPnL.toFixed(2)}
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
        <div style="text-align:center;padding:8px;background:rgba(255,255,255,0.03);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">WINS</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:18px;color:var(--bull)">${wins}</div>
        </div>
        <div style="text-align:center;padding:8px;background:rgba(255,255,255,0.03);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">LOSSES</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:18px;color:var(--bear)">${losses}</div>
        </div>
        <div style="text-align:center;padding:8px;background:rgba(255,255,255,0.03);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">OPEN</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:18px;color:var(--warn)">${openTrades}</div>
        </div>
        <div style="text-align:center;padding:8px;background:rgba(255,255,255,0.03);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">SL HITS</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:18px;color:var(--bear)">${slCount}</div>
        </div>
      </div>
      <div style="margin-top:8px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
        <div style="text-align:center;padding:8px;background:rgba(61,214,160,0.05);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">TP1 HITS</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;color:var(--bull)">${tp1Count}</div>
          <div style="font-size:10px;color:var(--bull)">+$${(tp1Count*20).toFixed(0)}</div>
        </div>
        <div style="text-align:center;padding:8px;background:rgba(61,214,160,0.05);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">TP2 HITS</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;color:var(--bull)">${tp2Count}</div>
          <div style="font-size:10px;color:var(--bull)">+$${(tp2Count*30).toFixed(0)}</div>
        </div>
        <div style="text-align:center;padding:8px;background:rgba(61,214,160,0.05);border-radius:5px;">
          <div style="font-size:10px;color:var(--text-dim)">TP3 HITS</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;color:var(--bull)">${tp3Count}</div>
          <div style="font-size:10px;color:var(--bull)">+$${(tp3Count*50).toFixed(0)}</div>
        </div>
      </div>
    </div>

    <!-- SECTION 4: KEY LEVELS -->
    <div class="modal-section">
      <div class="modal-section-title">🎯 KEY LEVELS — NEXT WEEK</div>
      <div style="margin-bottom:12px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--bear);letter-spacing:1px;margin-bottom:8px;">
          ▼ RESISTANCE ABOVE — SELL ZONES
        </div>
        ${bearOBs.map(o=>`
          <div style="display:flex;justify-content:space-between;padding:6px 10px;
               border-left:3px solid var(--bear);background:rgba(255,122,122,0.06);
               border-radius:0 4px 4px 0;margin-bottom:4px;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">Bearish OB (str: ${o.strength}x)</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--bear)">$${o.mid.toFixed(2)}</span>
          </div>`).join('')}
        ${topResist.map(p=>`
          <div style="display:flex;justify-content:space-between;padding:6px 10px;
               border-left:3px solid rgba(255,122,122,0.5);background:rgba(255,122,122,0.04);
               border-radius:0 4px 4px 0;margin-bottom:4px;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${p.description}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-bright)">$${p.price.toFixed(2)}</span>
          </div>`).join('')}
      </div>
      <div style="text-align:center;padding:8px;background:rgba(224,178,62,0.1);border-radius:4px;margin:10px 0;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--gold)">
          CURRENT PRICE: $${current.toFixed(2)}
        </span>
      </div>
      <div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--bull);letter-spacing:1px;margin-bottom:8px;">
          ▲ SUPPORT BELOW — BUY ZONES
        </div>
        ${bullOBs.map(o=>`
          <div style="display:flex;justify-content:space-between;padding:6px 10px;
               border-left:3px solid var(--bull);background:rgba(61,214,160,0.06);
               border-radius:0 4px 4px 0;margin-bottom:4px;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">Bullish OB (str: ${o.strength}x)</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--bull)">$${o.mid.toFixed(2)}</span>
          </div>`).join('')}
        ${botSupport.map(p=>`
          <div style="display:flex;justify-content:space-between;padding:6px 10px;
               border-left:3px solid rgba(61,214,160,0.5);background:rgba(61,214,160,0.04);
               border-radius:0 4px 4px 0;margin-bottom:4px;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-dim)">${p.description}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--text-bright)">$${p.price.toFixed(2)}</span>
          </div>`).join('')}
      </div>
    </div>

    <!-- SECTION 5: NEXT WEEK BIAS -->
    <div class="modal-section">
      <div class="modal-section-title">🔮 NEXT WEEK BIAS & FORECAST</div>
      <div style="text-align:center;padding:12px;margin-bottom:12px;
           background:${biasNext==='BULLISH'?'rgba(61,214,160,0.1)':biasNext==='BEARISH'?'rgba(255,122,122,0.1)':'rgba(74,158,255,0.1)'};
           border:1px solid ${biasNext==='BULLISH'?'rgba(61,214,160,0.3)':biasNext==='BEARISH'?'rgba(255,122,122,0.3)':'rgba(74,158,255,0.3)'};
           border-radius:6px;">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">PROJECTED BIAS</div>
        <div style="font-family:'Inter',sans-serif;font-size:24px;font-weight:800;
             color:${biasNext==='BULLISH'?'var(--bull)':biasNext==='BEARISH'?'var(--bear)':'var(--neutral)'}">
          ${biasNext==='BULLISH'?'▲ BULLISH':biasNext==='BEARISH'?'▼ BEARISH':'◆ NEUTRAL'}
        </div>
        ${d1Struct ? `<div style="font-size:12px;color:var(--text-dim);margin-top:4px;">D1: ${d1Struct.trend} &nbsp;|&nbsp; 4H: ${h4Struct?h4Struct.trend:'N/A'} &nbsp;|&nbsp; 1H: ${struct.trend}${htfConflict ? ' &nbsp;·&nbsp; ⚠ D1 and 4H disagree' : ''}</div>` : ''}
      </div>
      <div class="modal-text">
        ${biasNext==='BULLISH'
          ? `<strong style="color:var(--bull)">Bullish bias going into next week.</strong><br><br>
             Look for pullbacks into discount zones ($${bullOBs[0]?bullOBs[0].mid.toFixed(2):'–'}) as buying opportunities.
             Ideal entry: liquidity sweep of lows → OB touch → 15M CHoCH confirmation.
             <br><br>
             <strong>Target above:</strong> $${topResist[0]?topResist[0].price.toFixed(2):'–'} (BSL / resistance zone)<br>
             <strong>Invalidation:</strong> Daily close below $${botSupport[0]?botSupport[0].price.toFixed(2):'–'}<br><br>
             Avoid chasing highs. Wait for the pullback.`
          : biasNext==='BEARISH'
          ? `<strong style="color:var(--bear)">Bearish bias going into next week.</strong><br><br>
             Look for rallies into premium zones ($${bearOBs[0]?bearOBs[0].mid.toFixed(2):'–'}) as selling opportunities.
             Ideal entry: liquidity sweep of highs → OB touch → 15M CHoCH confirmation.
             <br><br>
             <strong>Target below:</strong> $${botSupport[0]?botSupport[0].price.toFixed(2):'–'} (SSL / support zone)<br>
             <strong>Invalidation:</strong> Daily close above $${topResist[0]?topResist[0].price.toFixed(2):'–'}<br><br>
             Avoid shorting lows. Wait for the rally.`
          : `<strong style="color:var(--neutral)">No clear directional bias.</strong><br><br>
             Market is ranging between $${botSupport[0]?botSupport[0].price.toFixed(2):'–'} and $${topResist[0]?topResist[0].price.toFixed(2):'–'}.
             Trade range boundaries only — buy sweeps of lows, sell sweeps of highs.
             No directional bias trades until a clear BOS forms.`
        }
      </div>
    </div>

    <!-- SECTION 6: STRATEGY REMINDER -->
    <div class="modal-section">
      <div class="modal-section-title">📌 STRATEGY CHECKLIST — NEXT WEEK</div>
      <div class="modal-text" style="line-height:2;">
        <div>✅ Identify D1/4H trend direction first</div>
        <div>✅ Only trade setups that align with higher TF bias</div>
        <div>✅ Wait for liquidity sweep before considering entry</div>
        <div>✅ Require 15M CHoCH confirmation before entering</div>
        <div>✅ Candle must CLOSE on correct side of level — no wicks</div>
        <div>✅ Use SL1 (fixed $10 risk) as default</div>
        <div>✅ Take TP1 first — then trail remaining position</div>
        <div>❌ Do NOT enter on proximity alone — wait for confirmation</div>
        <div>❌ Do NOT trade during major news events (NFP, CPI, FOMC)</div>
        <div>❌ Do NOT chase price after a large move</div>
        <br>
        <div style="color:var(--warn);">⚠ Key events to monitor: USD CPI, NFP, FOMC minutes, DXY direction</div>
        <div style="color:var(--text-dim);margin-top:6px;">Gold inversely correlated to USD — strong DXY = bearish Gold bias</div>
      </div>
    </div>
  `;

  modal.classList.add('open');
  } catch(e) {
    alert('Weekly report error: ' + e.message + '\n\nLine: ' + e.stack);
  }
}

function closeWeeklyReport() {
  document.getElementById('weeklyModal').classList.remove('open');
}

// ============================================================
// MAIN DATA FLOW
// ============================================================

async function loadAllData() {
  document.getElementById('loadingOverlay').style.display = 'flex';
  setStatus('loading', 'CONNECTING TO TWELVEDATA...');

  // Initial load: fetch all TFs with forced refresh, but still throttled
  // Order: higher TFs first (less frequent later), then working TFs, then quote
  const tfs = ['D1', '4H', '1H', '15min'];
  for (const tf of tfs) {
    const candles = await fetchCandles(tf, { force: true });
    if (candles) STATE.candles[tf] = candles;
  }

  const quote = await fetchQuote({ force: true });
  const candles1h = STATE.candles['1H'] || STATE.candles['15min'];
  const lastCandle = candles1h && candles1h.length > 0 ? candles1h[candles1h.length - 1] : null;

  if (quote && quote.price) {
    updatePriceDisplay(quote.price, quote.change || 0, quote.percent_change || 0);
    const isDemo = lastCandle && Math.abs(lastCandle.close - 5170) < 100 && !STATE.liveConfirmed;
    if (!isDemo) {
      setStatus('live', 'LIVE ● TWELVEDATA');
      STATE.demoMode = false;
      STATE.liveConfirmed = true;
    } else {
      setStatus('error', 'DEMO MODE');
      STATE.demoMode = true;
      showDemoBanner();
    }
  } else if (lastCandle) {
    const chg = lastCandle.close - lastCandle.open;
    updatePriceDisplay(lastCandle.close, chg, (chg / lastCandle.open) * 100);
    setStatus('error', 'DEMO MODE');
    STATE.demoMode = true;
    showDemoBanner();
  }

  renderAll();
  document.getElementById('loadingOverlay').style.display = 'none';

  checkForAlerts();
  updateTradeOutcomes();
}

function showDemoBanner() {
  const existing = document.getElementById('demoBanner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'demoBanner';
  banner.style.cssText = `
    position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
    background:rgba(13,17,23,0.97); border:1px solid var(--gold-dim);
    color:var(--text); font-family:'IBM Plex Mono',monospace; font-size:15px;
    padding:12px 20px; border-radius:6px; z-index:200; text-align:center;
    box-shadow:0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(224,178,62,0.15);
    max-width:90vw; line-height:1.6;
  `;
  banner.innerHTML = `
    <div style="color:var(--gold);font-size:16px;margin-bottom:6px;">⚠ DEMO MODE — Live data unavailable</div>
    <div style="color:var(--text-dim)">Couldn't reach TwelveData proxy — check your connection.<br>
    All structure analysis, OBs, setups and alerts work on demo data.</div>
    <div style="margin-top:8px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
      <button onclick="manualRefresh();document.getElementById('demoBanner').remove()" style="
        background:rgba(61,214,160,0.15); border:1px solid rgba(61,214,160,0.4);
        color:#3DD6A0; font-family:'IBM Plex Mono',monospace; font-size:14px;
        padding:5px 14px; border-radius:3px; cursor:pointer; letter-spacing:1px;
      ">⟳ RETRY</button>
      <button onclick="document.getElementById('demoBanner').remove()" style="
        background:rgba(224,178,62,0.1); border:1px solid var(--gold-dim);
        color:var(--gold); font-family:'IBM Plex Mono',monospace; font-size:14px;
        padding:5px 14px; border-radius:3px; cursor:pointer; letter-spacing:1px;
      ">OK</button>
    </div>
  `;
  document.body.appendChild(banner);
}

function renderAll() {
  const tf = STATE.currentTF;
  const candles = STATE.candles[tf];

  if (!candles || candles.length === 0) return;

  // Update active kill zone indicator
  const kzNow = getActiveKillZone();
  const kzIndicator = document.getElementById('kzIndicator');
  if (kzIndicator) {
    if (kzNow) {
      kzIndicator.textContent = '🕐 ' + kzNow.name + ' ACTIVE';
      kzIndicator.style.color = kzNow.color;
      kzIndicator.style.display = 'inline';
    } else {
      kzIndicator.style.display = 'none';
    }
  }

  renderChart(candles, tf);
  updateStructureBadges(candles, tf);
  updateConditionPanel(candles, tf);
  updateLevelsPanel(candles, tf);
  updateSetupsPanel(candles, tf);
  updateMultiTFGrid();
  updateSessionSummary(STATE.candles['1H'] || candles);
}

// ── Unique alert key to prevent duplicates ──────────────────
function alertKey(type, level, tf) {
  // Round level to nearest $1 to absorb tiny fluctuations
  return `${type}|${Math.round(parseFloat(level))}|${tf}`;
}

function checkForAlerts() {
  const tf1H = STATE.candles['1H'];
  const tf15 = STATE.candles['15min'];

  if (tf1H && tf1H.length > 0) {
    const sweep1H  = detectSweep(tf1H);
    const choch1H  = detectCHoCH(tf1H.slice(-20), '1H');
    const struct1H = detectStructure(tf1H);
    const current  = tf1H[tf1H.length - 1];
    const prev1    = tf1H[tf1H.length - 2];
    const prev2    = tf1H[tf1H.length - 3];

    // FIX 3+4: BOS retest — use proper confirmation logic, fire only once
    if (struct1H.bos) {
      const bosLevel = struct1H.bos.level;
      const isBull   = struct1H.bos.type.includes('BULL');
      const dist     = Math.abs(current.close - bosLevel) / bosLevel;

      // Confirmation: approaching from correct side + rejection/consolidation + closed correctly
      const approachOK = isBull ? current.close >= bosLevel * 0.996 : current.close <= bosLevel * 1.004;
      const rejectionOK = [current, prev1, prev2].some(c =>
        isBull ? (c.low <= bosLevel * 1.001 && c.close > bosLevel)
               : (c.high >= bosLevel * 0.999 && c.close < bosLevel)
      );
      const closedOK = isBull ? current.close > bosLevel : current.close < bosLevel;
      const key = alertKey('bos-retest', bosLevel, '1H');

      if (dist < 0.008 && approachOK && rejectionOK && closedOK && !STATE.seenAlerts.has(key)) {
        STATE.seenAlerts.set(key, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
        addAlert(
          'watch',
          `⚡ BOS RETEST — ${struct1H.bos.type}`,
          `Candle wicked to $${bosLevel.toFixed(2)} and closed ${isBull ? 'above' : 'below'} — level held as ${isBull ? 'support' : 'resistance'}. High-probability continuation entry.`,
          { 'LEVEL': `$${bosLevel.toFixed(2)}`, 'TYPE': struct1H.bos.type }
        );
      }
    }

    // Sweep + CHoCH confirmed buy/sell signal — fire only once per sweep level
    if (sweep1H && choch1H) {
      const isBull = choch1H.type.includes('BULL');
      const key    = alertKey('sweep-choch', sweep1H.level, '1H');
      if (!STATE.seenAlerts.has(key)) {
        STATE.seenAlerts.set(key, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
        const dual = calcDualSL(current.close, isBull, sweep1H.level);
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        // Register as a tracked trade
        registerTrade({
          type:    isBull ? 'BUY' : 'SELL',
          name:    'SWEEP → CHoCH',
          entry:   current.close,
          dual,
          tf:      '1H',
          time,
          candleIndex: tf1H.length - 1,
        });

        addAlert(
          isBull ? 'buy' : 'sell',
          `${isBull ? '▲ BUY SIGNAL' : '▼ SELL SIGNAL'} — 1H CONFIRMED`,
          `${sweep1H.type} at $${sweep1H.level.toFixed(2)} + ${choch1H.type} on 1H. Entry: $${current.close.toFixed(2)} at ${time}`,
          { entry: current.close.toFixed(2), dual }
        );
      }
    }
  }

  if (tf15 && tf15.length > 0) {
    const choch15 = detectCHoCH(tf15.slice(-20), '15M');
    const sweep15 = detectSweep(tf15);

    // FIX 9: Show BSL or SSL clearly in title
    if (sweep15) {
      const key = alertKey('sweep15', sweep15.level, '15M');
      if (!STATE.seenAlerts.has(key)) {
        STATE.seenAlerts.set(key, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
        const sweepLabel = sweep15.type === 'BUY-SIDE SWEPT' ? '🔴 BSL SWEPT' : '🟢 SSL SWEPT';
        addAlert(
          'watch',
          `⚡ 15M LIQUIDITY SWEEP — ${sweepLabel}`,
          `${sweep15.type} on 15M at $${sweep15.level.toFixed(2)}. Watch for 15M CHoCH confirmation — if it comes, this triggers a ${sweep15.direction === 'long' ? 'LONG' : 'SHORT'} entry.`,
          { 'LEVEL': `$${sweep15.level.toFixed(2)}`, 'DIRECTION': sweep15.direction === 'long' ? 'LONG (SSL sweep)' : 'SHORT (BSL sweep)' }
        );
      }
    }

    if (choch15) {
      const key = alertKey('choch15', choch15.level, '15M');
      if (!STATE.seenAlerts.has(key)) {
        STATE.seenAlerts.set(key, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
        addAlert(
          'info',
          `📍 15M CHoCH — ${choch15.type}`,
          `Change of Character on 15M at $${choch15.level.toFixed(2)}. Structure flipped — check higher TF alignment before entering.`,
          { 'LEVEL': `$${choch15.level.toFixed(2)}`, 'TF': '15M', 'SIG': choch15.significance }
        );
      }
    }
  }

  // Check outcomes on all open trades
  updateTradeOutcomes();
}

// ============================================================
// TRADE OUTCOME TRACKING SYSTEM
// ============================================================

function registerTrade(trade) {
  const sl1  = parseFloat(trade.dual.sl1.price);
  const tp1  = parseFloat(trade.dual.tp.sl1[0].price);
  const tp2  = parseFloat(trade.dual.tp.sl1[1].price);
  const tp3  = parseFloat(trade.dual.tp.sl1[2].price);

  const alertKey = 'setup|' + trade.type + '|' + trade.entry + '|' + trade.tf;
  STATE.tradeLog.push({
    id:        Date.now(),
    type:      trade.type,
    name:      trade.name,
    entry:     trade.entry,
    tf:        trade.tf,
    time:      trade.time,
    date:      new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    sl:        sl1,
    tp1, tp2, tp3,
    tp1Hit:    false,
    tp2Hit:    false,
    tp3Hit:    false,
    slHit:     false,
    status:    'OPEN',
    pnl:       0,
    candleIndexAtEntry: trade.candleIndex,   // legacy; outcomes are matched by time now
    entryTs:   Date.now(),
    lastCheckedTs: 0,
    riskDollars: TRADE.maxRiskDollars,
    tfKey:     trade.tf,
    alertKey:  alertKey,
  });
  saveTradeLog(); // persist immediately
}

// ── Candle time → UTC milliseconds ───────────────────────────
// Twelve Data returns "YYYY-MM-DD HH:MM:SS" (no zone) or "YYYY-MM-DD"; treat both as UTC.
const TF_MS = { '15min': 15 * 60000, '1H': 60 * 60000, '4H': 4 * 60 * 60000, 'D1': 24 * 60 * 60000 };

function candleTs(c) {
  if (!c || c.time == null) return 0;
  if (typeof c.time === 'number') return c.time * 1000;
  let str = String(c.time).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T00:00:00Z';
  else {
    str = str.replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) str += 'Z';
  }
  const ts = Date.parse(str);
  return isNaN(ts) ? 0 : ts;
}

// ── Trade outcome model ──────────────────────────────────────
// Position is split in thirds, one third closing at each of TP1/TP2/TP3 (1:2, 1:3, 1:5).
// After TP1 the stop moves to breakeven (entry). Full stop-out before TP1 = -1R.
// Only CLOSED candles are evaluated, in time order, and if a candle touches both the
// stop and a target the stop is assumed to have been hit first (conservative).
// Trades are matched to candles by TIME (not array index), so the sliding 100-candle
// window can't break them.
const TP_R = [2, 3, 5];

function updateTradeOutcomes() {
  const now = Date.now();
  STATE.tradeLog.forEach(trade => {
    if (trade.status !== 'OPEN') return;

    const candles = STATE.candles[trade.tfKey];
    if (!candles || candles.length === 0) return;

    const tfMs  = TF_MS[trade.tfKey] || TF_MS['1H'];
    const risk  = trade.riskDollars || TRADE.maxRiskDollars;
    const isBuy = trade.type === 'BUY';
    const from  = Math.max(trade.entryTs || trade.id || 0, trade.lastCheckedTs || 0);

    for (let i = 0; i < candles.length; i++) {
      const c  = candles[i];
      const ts = candleTs(c);
      if (!ts || ts <= from) continue;       // before entry / already checked
      if (ts + tfMs > now) break;            // candle still forming — evaluate once it closes

      const stop    = trade.tp1Hit ? trade.entry : trade.sl;   // breakeven after TP1
      const stopped = isBuy ? c.low <= stop : c.high >= stop;
      const hit     = lvl => isBuy ? c.high >= lvl : c.low <= lvl;

      if (stopped) {
        trade.slHit = true;
        if (!trade.tp1Hit) {
          trade.pnl = -risk;
          trade.status = 'SL';
        } else {
          trade.status = trade.tp2Hit ? 'TP2' : 'TP1';   // banked thirds kept, rest closed at breakeven
        }
      } else {
        if (!trade.tp1Hit && hit(trade.tp1)) { trade.tp1Hit = true; trade.pnl += risk * TP_R[0] / 3; }
        if (trade.tp1Hit && !trade.tp2Hit && hit(trade.tp2)) { trade.tp2Hit = true; trade.pnl += risk * TP_R[1] / 3; }
        if (trade.tp2Hit && !trade.tp3Hit && hit(trade.tp3)) {
          trade.tp3Hit = true;
          trade.pnl += risk * TP_R[2] / 3;
          trade.status = 'TP3';
        }
      }

      trade.pnl = Math.round(trade.pnl * 100) / 100;
      trade.lastCheckedTs = ts;
      if (trade.status !== 'OPEN') break;
    }
  });
}

// ============================================================
// UTILITIES
// ============================================================

function updatePriceDisplay(price, change, changePct) {
  const priceEl = document.getElementById('livePrice');
  const changeEl = document.getElementById('priceChange');

  if (STATE.lastPrice && price !== STATE.lastPrice) {
    priceEl.classList.remove('price-flash');
    void priceEl.offsetWidth;
    priceEl.classList.add('price-flash');
  }

  STATE.lastPrice = price;
  priceEl.textContent = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const sign = change >= 0 ? '+' : '';
  changeEl.textContent = `${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`;
  changeEl.className = `price-change ${change >= 0 ? 'up' : 'down'}`;
}

function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  const textEl = document.getElementById('statusText');
  dot.className = `status-dot ${type === 'live' ? '' : type}`;
  textEl.textContent = text;
}

// API setup removed - using Yahoo Finance (no key needed)



function switchTF(tf) {
  STATE.currentTF = tf;
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tf-${tf}`).classList.add('active');

  // Use cache if available; only fetch if we have nothing
  if (STATE.candles[tf] && STATE.candles[tf].length > 5) {
    renderAll();
  } else {
    document.getElementById('loadingOverlay').style.display = 'flex';
    fetchCandles(tf).then(c => {
      if (c) STATE.candles[tf] = c;
      renderAll();
      document.getElementById('loadingOverlay').style.display = 'none';
    });
  }
}

function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
}

// ============================================================
// TIERED REFRESH SYSTEM (free-tier safe)
// ============================================================
// Budget (approximate, free Twelve Data):
//   Price quote:   every 60 s   → ~480 calls/day
//   Signal TFs:    every 3 min  → 1H + 15M = ~960 calls/day max
//                  (but cache TTL reduces actual network calls)
//   Bias TFs:      every 30 min → D1 + 4H = ~96 calls/day
// Real network calls are further reduced by CACHE_TTL.
// ============================================================

const REFRESH = {
  priceMs:   60 * 1000,          // 1 min
  signalMs:  3 * 60 * 1000,      // 3 min
  biasMs:    30 * 60 * 1000,     // 30 min
};

let priceTimer      = null;
let signalTimer     = null;
let biasTimer       = null;
let nextSignalAt    = null;
let nextPriceAt     = null;
let countdownTimer  = null;

// ── Price — every 60 seconds (uses quote cache) ──────────────
async function refreshPrice() {
  nextPriceAt = Date.now() + REFRESH.priceMs;
  const quote = await fetchQuote(); // respects CACHE_TTL.quote
  if (quote && quote.price) {
    updatePriceDisplay(
      parseFloat(quote.price),
      parseFloat(quote.change || 0),
      parseFloat(quote.percent_change || 0)
    );
    if (STATE.liveConfirmed) {
      setStatus('live', 'LIVE ● TWELVEDATA');
      STATE.demoMode = false;
    }
  }
}

// ── Signal candles (1H + 15M) — every 3 minutes ──────────────
async function refreshSignalTFs() {
  nextSignalAt = Date.now() + REFRESH.signalMs;
  let anyLive = false;

  for (const tf of ['1H', '15min']) {
    // Uses cache — only hits network if TTL expired
    const candles = await fetchCandles(tf);
    if (candles && candles.length > 0) {
      STATE.candles[tf] = candles;
      if (Math.abs(candles[candles.length - 1].close - 5170) > 200) anyLive = true;
    }
  }

  if (anyLive) STATE.liveConfirmed = true;

  renderAll();
  checkForAlerts();
  updateTradeOutcomes();
  saveTradeLog();
}

// ── Bias candles (D1 + 4H) — every 30 minutes ────────────────
async function refreshBiasTFs() {
  for (const tf of ['D1', '4H']) {
    const candles = await fetchCandles(tf);
    if (candles && candles.length > 0) STATE.candles[tf] = candles;
  }
  updateMultiTFGrid();
}

// ── Countdown display ────────────────────────────────────────
function startCountdown() {
  nextSignalAt = Date.now() + REFRESH.signalMs;
  nextPriceAt  = Date.now() + REFRESH.priceMs;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(function() {
    const sigRemain   = Math.max(0, nextSignalAt - Date.now());
    const priceRemain = Math.max(0, nextPriceAt  - Date.now());

    const sigMins = Math.floor(sigRemain / 60000);
    const sigSecs = Math.floor((sigRemain % 60000) / 1000);
    const priceSecs = Math.floor(priceRemain / 1000);

    const sigEl   = document.getElementById('countdownDisplay');
    const priceEl = document.getElementById('priceCountdown');

    if (sigEl) sigEl.textContent = sigRemain > 0
      ? 'SIG: ' + sigMins + ':' + sigSecs.toString().padStart(2, '0')
      : 'SIGNALS UPDATING...';

    if (priceEl) priceEl.textContent = priceRemain > 0
      ? 'PRICE: ' + priceSecs + 's'
      : 'PRICE UPDATING...';
  }, 1000);
}

// ── Start all timers ─────────────────────────────────────────
function startAllTimers() {
  if (priceTimer)  clearInterval(priceTimer);
  if (signalTimer) clearInterval(signalTimer);
  if (biasTimer)   clearInterval(biasTimer);

  priceTimer  = setInterval(refreshPrice, REFRESH.priceMs);
  signalTimer = setInterval(refreshSignalTFs, REFRESH.signalMs);
  biasTimer   = setInterval(refreshBiasTFs, REFRESH.biasMs);

  startCountdown();
}

function showRateLimitWarning() {
  const existing = document.getElementById('rateLimitBanner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'rateLimitBanner';
  banner.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
    'background:rgba(13,17,23,0.97);border:1px solid rgba(255,122,122,0.6);' +
    'color:var(--text);font-family:IBM Plex Mono,monospace;font-size:14px;' +
    'padding:12px 20px;border-radius:6px;z-index:200;text-align:center;max-width:90vw;line-height:1.6;';
  banner.innerHTML =
    '<div style="color:#FF7A7A;font-size:15px;margin-bottom:4px;">⚠ API RATE LIMIT REACHED</div>' +
    '<div style="color:var(--text-dim)">TwelveData free tier limit hit. App will retry automatically.</div>' +
    '<button onclick="document.getElementById(\'rateLimitBanner\').remove()" style="' +
    'margin-top:8px;background:rgba(255,122,122,0.15);border:1px solid rgba(255,122,122,0.4);' +
    'color:#FF7A7A;font-family:IBM Plex Mono,monospace;font-size:13px;' +
    'padding:4px 14px;border-radius:3px;cursor:pointer;">DISMISS</button>';
  document.body.appendChild(banner);
  setTimeout(() => { if (banner) banner.remove(); }, 30000);
}

// ── Manual refresh — refreshes everything immediately ────────
// Returns current active kill zone name or null — always in GMT
function getActiveKillZone() {
  var now = new Date();
  var gmtH = now.getUTCHours();
  var gmtM = now.getUTCMinutes();
  var gmtDecimal = gmtH + gmtM / 60;
  if (gmtDecimal >= 0    && gmtDecimal < 3)  return { name: 'ASIAN SESSION',    color: 'rgba(160,100,255,0.9)' };
  if (gmtDecimal >= 8    && gmtDecimal < 10) return { name: 'LONDON OPEN',      color: 'rgba(74,158,255,0.9)'  };
  if (gmtDecimal >= 13   && gmtDecimal < 15) return { name: 'NEW YORK OPEN',    color: 'rgba(224,178,62,0.9)'  };
  if (gmtDecimal >= 15   && gmtDecimal < 17) return { name: 'LONDON CLOSE',     color: 'rgba(255,122,122,0.9)'  };
  return null;
}

function toggleKillZones() {
  STATE.showKillZones = !STATE.showKillZones;
  const btn = document.getElementById('kzBtn');
  if (STATE.showKillZones) {
    btn.style.background    = 'rgba(74,158,255,0.25)';
    btn.style.borderColor   = 'rgba(74,158,255,0.8)';
    btn.style.color         = '#4a9eff';
    btn.textContent         = 'KZ ✓';
  } else {
    btn.style.background    = 'rgba(74,158,255,0.08)';
    btn.style.borderColor   = 'rgba(74,158,255,0.3)';
    btn.style.color         = 'rgba(74,158,255,0.6)';
    btn.textContent         = 'KZ';
  }
  const candles = STATE.candles[STATE.currentTF];
  if (candles) renderChart(candles, STATE.currentTF);
}

function toggleFibo() {
  STATE.showFibo = !STATE.showFibo;
  const btn = document.getElementById('fiboBtn');
  if (STATE.showFibo) {
    btn.style.background = 'rgba(224,178,62,0.25)';
    btn.style.borderColor = 'rgba(224,178,62,0.8)';
    btn.style.color = '#E0B23E';
    btn.textContent = 'FIBO ✓';
  } else {
    btn.style.background = 'rgba(224,178,62,0.08)';
    btn.style.borderColor = 'rgba(224,178,62,0.3)';
    btn.style.color = 'rgba(224,178,62,0.6)';
    btn.textContent = 'FIBO';
  }
  // Redraw chart
  const candles = STATE.candles[STATE.currentTF];
  if (candles) renderChart(candles, STATE.currentTF);
}

async function manualRefresh() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  btn.textContent = '⟳ REFRESHING';

  // Force-refresh everything (user explicitly asked)
  // Throttling still applies via the request queue
  for (const tf of ['D1', '4H', '1H', '15min']) {
    const candles = await fetchCandles(tf, { force: true });
    if (candles && candles.length > 0) STATE.candles[tf] = candles;
  }

  await fetchQuote({ force: true }).then(q => {
    if (q && q.price) {
      updatePriceDisplay(q.price, q.change || 0, q.percent_change || 0);
    }
  });

  renderAll();
  checkForAlerts();
  updateTradeOutcomes();
  saveTradeLog();

  // Restart timers so countdowns reset cleanly
  startAllTimers();

  btn.classList.remove('spinning');
  btn.textContent = '⟳ REFRESH';
}

// ============================================================
// CHART PAN & ZOOM
// ============================================================

function chartZoom(delta) {
  // delta > 0 = zoom out (more candles), delta < 0 = zoom in (fewer)
  STATE.chartCandleCount = Math.max(20, Math.min(200, STATE.chartCandleCount + delta));
  const candles = STATE.candles[STATE.currentTF];
  if (candles) renderChart(candles, STATE.currentTF);
}

function chartGoLive() {
  STATE.chartOffset = 0;
  const candles = STATE.candles[STATE.currentTF];
  if (candles) renderChart(candles, STATE.currentTF);
}

// ── Tooltip drawing ───────────────────────────────────────
function drawTooltip(candleData, xPixel, yPixel) {
  var tc = document.getElementById('tooltipChart');
  if (!tc) return;
  var wrap = tc.parentElement;
  tc.width  = wrap.clientWidth  * window.devicePixelRatio;
  tc.height = wrap.clientHeight * window.devicePixelRatio;
  tc.style.width  = wrap.clientWidth  + 'px';
  tc.style.height = wrap.clientHeight + 'px';

  var ctx = tc.getContext('2d');
  var dpr = window.devicePixelRatio;
  ctx.clearRect(0, 0, tc.width, tc.height);

  if (!candleData) return;

  var c = candleData;
  var isBull = c.close >= c.open;
  var range  = (c.high - c.low).toFixed(2);
  var chg    = (c.close - c.open).toFixed(2);

  // Format candle time
  var timeStr = '';
  try {
    var ts = typeof c.time === 'number' ? c.time * 1000 : new Date(c.time).getTime();
    var d  = new Date(ts + 60 * 60000); // WAT = UTC+1
    // Format: "Thu, 10 Apr 2026 14:00" - trim seconds
    var full = d.toUTCString().replace(' GMT','');
    var parts = full.split(':');
    timeStr = parts.length >= 2 ? parts[0] + ':' + parts[1] : full;
  } catch(e) { timeStr = 'N/A'; }

  var lines = [
    { label: '🕐', value: timeStr, color: 'rgba(200,200,200,0.9)' },
    { label: 'O', value: c.open.toFixed(2),  color: 'rgba(200,200,200,0.85)' },
    { label: 'H', value: c.high.toFixed(2),  color: 'rgba(61,214,160,1.0)'    },
    { label: 'L', value: c.low.toFixed(2),   color: 'rgba(255,122,122,1.0)'   },
    { label: 'C', value: c.close.toFixed(2), color: isBull ? 'rgba(61,214,160,1.0)' : 'rgba(255,122,122,1.0)' },
    { label: 'RNG', value: range + ' pts',   color: 'rgba(224,178,62,0.9)'   },
    { label: '', value: (isBull ? '▲ BULLISH' : '▼ BEARISH'), color: isBull ? 'rgba(61,214,160,1.0)' : 'rgba(255,122,122,1.0)' },
  ];

  var fontSize   = 11 * dpr;
  var lineHeight = 16 * dpr;
  var padX       = 10 * dpr;
  var padY       = 8  * dpr;
  var boxW       = 155 * dpr;
  var boxH       = lines.length * lineHeight + padY * 2;

  // Position tooltip — flip left if near right edge
  var xPos = xPixel * dpr + 16 * dpr;
  var yPos = yPixel * dpr - boxH / 2;

  if (xPos + boxW > tc.width - 80 * dpr) {
    xPos = xPixel * dpr - boxW - 16 * dpr;
  }
  if (yPos < padding_top_ref * dpr) yPos = padding_top_ref * dpr;
  if (yPos + boxH > tc.height - 20 * dpr) yPos = tc.height - boxH - 20 * dpr;

  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 12 * dpr;

  // Background box
  ctx.fillStyle = 'rgba(8,14,22,0.96)';
  ctx.beginPath();
  ctx.roundRect(xPos, yPos, boxW, boxH, 5 * dpr);
  ctx.fill();

  // Border — bull green or bear red
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = isBull ? 'rgba(61,214,160,0.6)' : 'rgba(255,122,122,0.6)';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.beginPath();
  ctx.roundRect(xPos, yPos, boxW, boxH, 5 * dpr);
  ctx.stroke();

  // Draw each line
  ctx.font = fontSize + 'px IBM Plex Mono, monospace';
  lines.forEach(function(line, i) {
    var lineY = yPos + padY + (i + 0.75) * lineHeight;
    // Label
    ctx.fillStyle = 'rgba(90,122,150,0.9)';
    ctx.textAlign = 'left';
    if (line.label) ctx.fillText(line.label, xPos + padX, lineY);
    // Value
    ctx.fillStyle = line.color;
    ctx.textAlign = 'right';
    ctx.fillText(line.value, xPos + boxW - padX, lineY);
  });

  // Crosshair vertical line on main chart position
  ctx.strokeStyle = 'rgba(224,178,62,0.25)';
  ctx.lineWidth   = 1 * dpr;
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(xPixel * dpr, 20 * dpr);
  ctx.lineTo(xPixel * dpr, tc.height - 20 * dpr);
  ctx.stroke();
  ctx.setLineDash([]);
}

// padding_top_ref used by tooltip positioning
var padding_top_ref = 20;

function clearTooltip() {
  STATE.tooltipCandle = null;
  var tc = document.getElementById('tooltipChart');
  if (!tc) return;
  var ctx = tc.getContext('2d');
  ctx.clearRect(0, 0, tc.width, tc.height);
}

function getTooltipCandle(clientX, clientXRelative) {
  // Find which candle index corresponds to the X position
  var candles = STATE.candles[STATE.currentTF];
  if (!candles || candles.length === 0) return null;

  var maxOffset = Math.max(0, candles.length - 20);
  var offset    = Math.max(0, Math.min(STATE.chartOffset, maxOffset));
  var endIdx    = candles.length - offset;
  var startIdx  = Math.max(0, endIdx - STATE.chartCandleCount);
  var displayCandles = candles.slice(startIdx, endIdx);

  var canvas = document.getElementById('mainChart');
  if (!canvas) return null;

  var paddingLeft  = 6;
  var paddingRight = 75;
  var chartW = canvas.clientWidth - paddingLeft - paddingRight;

  var relX = clientXRelative - paddingLeft;
  if (relX < 0 || relX > chartW) return null;

  var candleIndex = Math.round((relX / chartW) * (displayCandles.length - 1));
  candleIndex = Math.max(0, Math.min(displayCandles.length - 1, candleIndex));

  return displayCandles[candleIndex];
}

function chartPan(deltaCandlesRaw) {
  const candles = STATE.candles[STATE.currentTF];
  if (!candles) return;
  const delta = Math.round(deltaCandlesRaw);
  const maxOffset = Math.max(0, candles.length - 20);
  STATE.chartOffset = Math.max(0, Math.min(STATE.chartOffset + delta, maxOffset));
  renderChart(candles, STATE.currentTF);
}

// ── Touch events for mobile swipe pan ────────────────────
(function() {
  var canvas = null;
  var touchStartX = 0;
  var lastTouchX  = 0;
  var isDragging  = false;
  var pixelsPerCandle = 1;

  function getCanvas() {
    if (!canvas) canvas = document.getElementById('mainChart');
    return canvas;
  }

  function calcPixelsPerCandle() {
    var c = getCanvas();
    if (!c) return 8;
    return c.clientWidth / STATE.chartCandleCount;
  }

  document.addEventListener('touchstart', function(e) {
    var c = getCanvas();
    if (!c || !e.target === c) return;
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      lastTouchX  = touchStartX;
      isDragging  = true;
      pixelsPerCandle = calcPixelsPerCandle();
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!isDragging || e.touches.length !== 1) return;
    var c = getCanvas();
    if (!c) return;
    var currentX = e.touches[0].clientX;
    var deltaX   = lastTouchX - currentX; // positive = swipe left = scroll back in time
    lastTouchX   = currentX;
    var deltaCandlesRaw = deltaX / Math.max(1, pixelsPerCandle);
    if (Math.abs(deltaCandlesRaw) >= 0.5) {
      chartPan(deltaCandlesRaw);
    }
  }, { passive: true });

  document.addEventListener('touchend', function() {
    isDragging = false;
  });

  // ── Mouse events for desktop drag pan ────────────────────
  var mouseDown   = false;
  var mouseStartX = 0;
  var lastMouseX  = 0;

  document.addEventListener('mousedown', function(e) {
    var c = getCanvas();
    if (!c || e.target !== c) return;
    mouseDown   = true;
    mouseStartX = e.clientX;
    lastMouseX  = e.clientX;
    pixelsPerCandle = calcPixelsPerCandle();
    c.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', function(e) {
    if (!mouseDown) return;
    var deltaX = lastMouseX - e.clientX;
    lastMouseX = e.clientX;
    var deltaCandlesRaw = deltaX / Math.max(1, pixelsPerCandle);
    if (Math.abs(deltaCandlesRaw) >= 0.3) {
      chartPan(deltaCandlesRaw);
    }
  });

  document.addEventListener('mouseup', function() {
    if (mouseDown) {
      mouseDown = false;
      var c = getCanvas();
      if (c) c.style.cursor = 'crosshair';
    }
  });

  // ── Tooltip on mouse hover ────────────────────────────────
  document.addEventListener('mousemove', function(e) {
    var c = getCanvas();
    if (!c || e.target !== c) { clearTooltip(); return; }
    if (mouseDown) { clearTooltip(); return; } // don't show tooltip while panning
    var rect   = c.getBoundingClientRect();
    var relX   = e.clientX - rect.left;
    var relY   = e.clientY - rect.top;
    var candle = getTooltipCandle(e.clientX, relX);
    if (candle) {
      STATE.tooltipCandle = candle;
      drawTooltip(candle, relX, relY);
    } else {
      clearTooltip();
    }
  });

  document.addEventListener('mouseleave', function(e) {
    var c = getCanvas();
    if (e.target === c) clearTooltip();
  });

  // ── Tooltip on touch hold ─────────────────────────────────
  var tooltipTouchId   = null;
  var tooltipTimeout   = null;
  var isTooltipActive  = false;

  document.addEventListener('touchstart', function(e) {
    var c = getCanvas();
    if (!c || e.target !== c) return;
    if (e.touches.length !== 1) return;
    var touch = e.touches[0];
    var rect  = c.getBoundingClientRect();
    var relX  = touch.clientX - rect.left;
    var relY  = touch.clientY - rect.top;
    tooltipTouchId = touch.identifier;
    // Show tooltip after 300ms hold — shorter than pan threshold
    tooltipTimeout = setTimeout(function() {
      isTooltipActive = true;
      isDragging = false; // cancel pan so tooltip shows
      var candle = getTooltipCandle(touch.clientX, relX);
      if (candle) drawTooltip(candle, relX, relY);
    }, 300);
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!isTooltipActive) return;
    for (var i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === tooltipTouchId) {
        var c = getCanvas();
        if (!c) return;
        var rect  = c.getBoundingClientRect();
        var relX  = e.touches[i].clientX - rect.left;
        var relY  = e.touches[i].clientY - rect.top;
        var candle = getTooltipCandle(e.touches[i].clientX, relX);
        if (candle) drawTooltip(candle, relX, relY);
        return;
      }
    }
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    clearTimeout(tooltipTimeout);
    isTooltipActive  = false;
    tooltipTouchId   = null;
    clearTooltip();
  });

  // ── Pinch zoom for mobile ─────────────────────────────────
  var lastPinchDist = null;

  document.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist = Math.sqrt(dx*dx + dy*dy);
      isDragging = false; // cancel pan when pinching
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (e.touches.length === 2 && lastPinchDist !== null) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var dist = Math.sqrt(dx*dx + dy*dy);
      var ratio = lastPinchDist / dist;
      // ratio > 1 = fingers closer = zoom in (fewer candles)
      // ratio < 1 = fingers apart  = zoom out (more candles)
      var newCount = Math.round(STATE.chartCandleCount * ratio);
      newCount = Math.max(20, Math.min(200, newCount));
      if (newCount !== STATE.chartCandleCount) {
        STATE.chartCandleCount = newCount;
        var candles = STATE.candles[STATE.currentTF];
        if (candles) renderChart(candles, STATE.currentTF);
      }
      lastPinchDist = dist;
    }
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    if (e.touches.length < 2) lastPinchDist = null;
  });
})();

// Handle window resize
window.addEventListener('resize', () => {
  if (STATE.candles[STATE.currentTF]) {
    renderChart(STATE.candles[STATE.currentTF], STATE.currentTF);
  }
});

// Close modal on overlay click
document.getElementById('weeklyModal').addEventListener('click', function(e) {
  if (e.target === this) closeWeeklyReport();
});

// Initialize — restore trade log then load data
function restoreTradeLog() {
  try {
    const saved = localStorage.getItem('xau_trade_log');
    if (saved) {
      const trades = JSON.parse(saved);
      // Only keep trades from the last 7 days
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      STATE.tradeLog = trades.filter(t => t.id > cutoff);
      // Restore seenAlerts so duplicates don't re-register
      STATE.tradeLog.forEach(t => {
        if (t.alertKey) STATE.seenAlerts.set(t.alertKey, t.time || '');
      });
    }
  } catch(e) { console.warn('Could not restore trade log', e); }
}

function saveTradeLog() {
  try {
    localStorage.setItem('xau_trade_log', JSON.stringify(STATE.tradeLog));
  } catch(e) { console.warn('Could not save trade log', e); }
}

function clearWeekTrades() {
  if (!confirm('Clear all trades for this week? This cannot be undone.')) return;
  STATE.tradeLog = [];
  STATE.seenAlerts = new Map();
  localStorage.removeItem('xau_trade_log');
  renderAll();
}



// ── Expose functions used by HTML onclick handlers ────────────
Object.assign(window, {
  switchTF,
  switchTab,
  manualRefresh,
  toggleFibo,
  toggleKillZones,
  chartZoom,
  chartGoLive,
  openWeeklyReport,
  closeWeeklyReport,
  clearWeekTrades,
});

// Initialize
restoreTradeLog();
loadAllData().then(() => {
  startAllTimers();
});
