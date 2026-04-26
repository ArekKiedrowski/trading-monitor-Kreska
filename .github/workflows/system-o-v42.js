// system-o-v42.js
const https = require('https');
const fs = require('fs');

// =============== CONFIG ==================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || 10000);

const TG_THREADS = { SETUP: 2, TRADE: 3, SYSTEM: 4 };

const INSTRUMENTS = [
  { key: 'btc', name: 'BTC', sym: 'BTC-USD', dec: 2, minRR: 4, market: 'CRYPTO' },
  { key: 'tsla', name: 'TSLA', sym: 'TSLA', dec: 2, minRR: 4, market: 'TECH' },
  { key: 'nvda', name: 'NVDA', sym: 'NVDA', dec: 2, minRR: 4, market: 'TECH' },
  { key: 'goog', name: 'GOOG', sym: 'GOOG', dec: 2, minRR: 3, market: 'TECH' }
];

// =============== CACHE ====================
let cache = { pendingSetups: {}, activePositions: {}, lastAlerts: {} };
try {
  if (fs.existsSync('signal-cache.json')) {
    const raw = JSON.parse(fs.readFileSync('signal-cache.json', 'utf8'));
    cache.pendingSetups = raw.pendingSetups || {};
    cache.activePositions = raw.activePositions || {};
    cache.lastAlerts = raw.lastAlerts || {};
  }
} catch {
  cache = { pendingSetups: {}, activePositions: {}, lastAlerts: {} };
}

// =============== HELPERS ==================
function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}] ${msg}`);
}

function money(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

// =============== TELEGRAM =================
async function sendTG(type, message) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  const body = JSON.stringify({
    chat_id: TG_CHAT_ID,
    message_thread_id: TG_THREADS[type],
    text: message,
    parse_mode: 'HTML'
  });

  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise(res => {
    const req = https.request(opts, () => res());
    req.on('error', () => res());
    req.write(body);
    req.end();
  });
}

async function notify(type, message, instr) {
  log(`[${instr}] ${message.replace(/<[^>]*>/g, '')}`);
  await sendTG(type, message);
}

// =============== DATA =====================
async function fetchYahoo(sym) {
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1h&range=60d`,
        res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(d);
              resolve(json.chart.result[0]);
            } catch {
              reject(new Error('Bad Yahoo response'));
            }
          });
        }
      )
      .on('error', reject);
  });
}

function candlesFromRaw(r) {
  const q = r.indicators.quote[0];
  const t = r.timestamp;
  const out = [];

  for (let i = 0; i < t.length; i++) {
    if (q.close[i] && q.high[i] && q.low[i] && q.open[i]) {
      out.push({ t: t[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    }
  }
  return out;
}

// =============== INDICATORS ===============
function ema(data, period) {
  if (!data.length) return NaN;
  const k = 2 / (period + 1);
  let val = data[0];
  for (let i = 1; i < data.length; i++) {
    val = data[i] * k + val * (1 - k);
  }
  return val;
}

function atr(highs, lows, closes, p = 14) {
  if (closes.length <= 1) return NaN;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  const slice = trs.slice(-p);
  if (!slice.length) return NaN;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// =============== LOGIC ====================
function detectTrend(c) {
  const closes = c.map(x => x.c);
  if (closes.length < 220) return false;

  const ema50 = ema(closes.slice(-60), 50);
  const ema200 = ema(closes.slice(-220), 200);

  return closes.at(-1) > ema50 && ema50 > ema200;
}

function detectBoneZone(c) {
  const closes = c.map(x => x.c);
  if (closes.length < 40) return false;

  const ema9 = ema(closes.slice(-20), 9);
  const ema20 = ema(closes.slice(-40), 20);
  const price = closes.at(-1);

  // Bone Zone: pod EMA9, powyżej EMA20
  return price < ema9 && price > ema20;
}

function detectTrigger(c) {
  if (c.length < 2) return false;

  const prevHigh = c.at(-2).h;
  const last = c.at(-1);

  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  if (!range) return false;

  const bodyRatio = body / range;

  // prosty cheat trigger: wybicie high poprzedniej świecy + solidne ciało
  return last.c > prevHigh && bodyRatio > 0.45;
}

// =============== POSITION SIZE ============
function calcSize(balance, risk, entry, sl) {
  const riskUSD = balance * risk;
  const riskPerUnit = Math.abs(entry - sl);
  if (!riskUSD || !riskPerUnit) {
    return { size: 0, value: 0, riskUSD: 0 };
  }
  const size = riskUSD / riskPerUnit;
  return {
    size,
    value: size * entry,
    riskUSD
  };
}

// =============== SCORE ====================
function scoreSetup({ trend, bone, trigger }) {
  let s = 0;
  if (trend) s += 30;
  if (bone) s += 30;
  if (trigger) s += 30;
  return s;
}

function gradeFromScore(score) {
  if (score >= 85) return { grade: 'A+', risk: 0.10 };
  if (score >= 70) return { grade: 'A', risk: 0.06 };
  if (score >= 55) return { grade: 'WATCH', risk: 0 };
  return { grade: 'INVALID', risk: 0 };
}

// =============== CORE SCAN ================
async function scan(instr) {
  const raw = await fetchYahoo(instr.sym);
  const candles = candlesFromRaw(raw);

  if (candles.length < 220) {
    log(`[SCAN] ${instr.name} | skipped (not enough candles)`);
    return;
  }

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const atrVal = atr(highs, lows, closes);
  const price = closes.at(-1);
  const lastCandleT = candles.at(-1).t;

  const trend = detectTrend(candles);
  const bone = detectBoneZone(candles);
  const trigger = detectTrigger(candles);

  const score = scoreSetup({ trend, bone, trigger });
  const { grade, risk } = gradeFromScore(score);

  log(`[SCAN] ${instr.name} | Score ${score} | ${grade}`);

  if (grade === 'INVALID') return;

  // anti-spam: ten sam instrument + ta sama świeca + ten sam grade
  const lastA = cache.lastAlerts[instr.key];
  if (lastA && lastA.lastCandleT === lastCandleT && lastA.grade === grade) {
    return;
  }

  if (trigger && (grade === 'A' || grade === 'A+')) {
    const recent = candles.slice(-10);
    const sl = recent.reduce((m, c) => Math.min(m, c.l), Infinity);
    const tp2 = price + (price - sl) * (instr.minRR || 4);

    const pos = calcSize(ACCOUNT_BALANCE, risk, price, sl);

    const msg =
      `🚀 <b>${instr.name}</b>\n` +
      `Grade: ${grade}\nScore: ${score}\n\n` +
      `Entry: ${money(price)}\n` +
      `SL: ${money(sl)}\n` +
      `TP2: ${money(tp2)}\n\n` +
      `Size: ${money(pos.size, 4)}\n` +
      `Value: $${money(pos.value, 0)}\n` +
      `Risk: $${money(pos.riskUSD, 0)}`;

    await notify('SETUP', msg, instr.name);

    const baseRisk = risk;
    cache.pendingSetups[instr.key] = {
      instr: instr.name,
      key: instr.key,
      status: 'ENTRY ZONE',
      grade,
      baseRisk,
      score,
      dir: 'LONG',
      entry: price,
      sl,
      tp1: price + Math.abs(price - sl) * 1.5,
      tp2,
      targetR: instr.minRR || 4,
      atr: atrVal,
      dec: instr.dec,
      timestamp: Date.now(),
      why: [
        trend ? 'Trend: price > EMA50 > EMA200' : 'Trend: weak',
        bone ? 'Bone Zone: between EMA9 & EMA20' : 'Bone Zone: no',
        trigger ? 'Trigger: cheat breakout' : 'Trigger: not active'
      ],
      alerts: [],
      positionSize: pos,
      lastCandleT
    };

    cache.lastAlerts[instr.key] = {
      lastCandleT,
      grade,
      score,
      kind: 'SETUP'
    };
  }
}

// =============== MAIN =====================
async function main() {
  log('--- SYSTEM O v4.2 START ---');
  log(`[SYSTEM] Balance: $${money(ACCOUNT_BALANCE, 0)}`);
  log(`[SYSTEM] TG: ${TG_TOKEN && TG_CHAT_ID ? 'OK' : 'MISSING'}`);

  for (const instr of INSTRUMENTS) {
    process.stdout.write(`[SCANNING] ${instr.name}... `);
    try {
      await scan(instr);
      process.stdout.write('DONE\n');
    } catch (e) {
      process.stdout.write('FAIL\n');
      log(`[ERROR] ${instr.name}: ${e.message || e}`);
    }
  }

  fs.writeFileSync(
    'signal-cache.json',
    JSON.stringify(
      {
        pendingSetups: cache.pendingSetups,
        activePositions: cache.activePositions,
        lastAlerts: cache.lastAlerts
      },
      null,
      2
    )
  );

  log('--- SYSTEM O v4.2 END ---');
}

main().catch(e => {
  log(`[FATAL] ${e.message || e}`);
});
