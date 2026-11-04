/* Earnings-call mention model.

   Signals per market (company × term × call date):
     H  Kalshi history prior — hierarchical shrinkage: company×term ← term-across-companies ×
        company talkativeness ← global base rate. Built only from markets settled BEFORE the date.
     T  Transcript signal — Gamma-Poisson over the term's counts in prior calls, with its prior
        centred on H (so T == H when no transcripts are loaded).
     M  Market — pre-call mid price.
     C  Claude judgment — optional overlay with a user-set weight (not fitted: Claude's training
        data overlaps historical calls, so a backtested weight would be contaminated).

   Blend: logistic regression on [1, logit H, logit T − logit H, logit M], fitted walk-forward with
   an L2 penalty centred on sensible defaults (not on zero), so thin data falls back to "trust the
   prior and the market" instead of to coin flips. */

export const DEFAULTS = {
  kTerm: 4,            // pseudo-markets pulling a term's cross-company rate toward the global rate
  kCompany: 8,         // pseudo-markets pulling a company's hit rate toward the global rate
  kCompanyTerm: 2,     // pseudo-markets pulling company×term history toward the combined base
  ctDecay: 0.75,       // weight per step back in that company's own term history (recency)
  txPriorCalls: 1,     // Gamma prior strength (pseudo-calls) for the transcript signal
  txDecay: 0.85,       // weight per step back in transcript history
  txMaxCalls: 8,
  txGapDays: 20,       // transcripts must predate the call by this much (calls are ~90 days apart; guards against misdated transcripts)
  wMarket: 0.7,        // default market weight in logit space before enough data to fit
  wClaude: 0.2,        // user-set Claude overlay weight
  l2: 2,               // strength of the pull toward default coefficients
  minTrain: 150,       // rows before the blend is fitted instead of using defaults
  refitEvery: 100,     // walk-forward refit cadence (rows)
  minHistory: 200,     // backtest scoring starts once the prior has this many settled markets
  feeRate: 0.07,       // Kalshi taker fee: ceil(rate × C × P × (1−P)) dollars
  minEdge: 0.03,
  kellyFraction: 0.25,
  maxBetPct: 0.05,
  bankroll: 1000,
  flatContracts: 10,
  minVolume: 0,
};

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const clampP = (p) => clamp(p, 0.005, 0.995);
export const logit = (p) => { const q = clampP(p); return Math.log(q / (1 - q)); };
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

export const priorCoefN = () => [0, 1, 1];
export const priorCoefM = (P = DEFAULTS) => [0, 1 - P.wMarket, 1 - P.wMarket, P.wMarket];

/* ---------- H: Kalshi history prior ---------- */
export class HistoryStats {
  constructor() {
    this.g = { y: 0, n: 0 };
    this.term = new Map();
    this.co = new Map();
    this.ct = new Map(); // company|termKey → [{date, y}] ascending
    this.lastDate = null;
  }
  static from(rows, beforeDate = null) {
    const s = new HistoryStats();
    const sorted = rows.filter((r) => r.y != null && r.date && (!beforeDate || r.date < beforeDate)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const r of sorted) s.add(r);
    return s;
  }
  add(r) {
    if (r.y == null) return;
    const bump = (map, k) => { const v = map.get(k) || { y: 0, n: 0 }; v.y += r.y; v.n += 1; map.set(k, v); };
    this.g.y += r.y; this.g.n += 1;
    bump(this.term, r.termKey);
    bump(this.co, r.company);
    const k = `${r.company}|${r.termKey}`;
    const list = this.ct.get(k) || [];
    list.push({ date: r.date, y: r.y });
    this.ct.set(k, list);
    if (!this.lastDate || r.date > this.lastDate) this.lastDate = r.date;
  }
  get n() { return this.g.n; }
  prior(company, key, P = DEFAULTS) {
    const g = (this.g.y + 1) / (this.g.n + 2);
    const list = this.ct.get(`${company}|${key}`) || [];
    const ctY = list.reduce((a, o) => a + o.y, 0);
    const t = this.term.get(key) || { y: 0, n: 0 };
    const tY = t.y - ctY, tN = t.n - list.length; // other companies only
    const pTerm = (tY + P.kTerm * g) / (tN + P.kTerm);
    const c = this.co.get(company) || { y: 0, n: 0 };
    const pCompany = (c.y + P.kCompany * g) / (c.n + P.kCompany);
    const base = sigmoid(logit(pTerm) + logit(pCompany) - logit(g));
    let wy = 0, wn = 0;
    for (let i = list.length - 1, j = 0; i >= 0; i--, j++) { const w = P.ctDecay ** j; wy += w * list[i].y; wn += w; }
    const p = (wy + P.kCompanyTerm * base) / (wn + P.kCompanyTerm);
    return {
      p: clampP(p), g, base, pTerm, nTerm: tN, pCompany, nCompany: c.n,
      nCT: list.length, yCT: ctY, last: list.length ? list[list.length - 1].y : null,
    };
  }
}

/* ---------- T: transcript signal ----------
   counts k_j in prior calls ~ Poisson(λ), λ ~ Gamma(α, β). Posterior predictive
   P(no mention next call) = (β/(β+1))^α. Prior (α0, β0) is chosen so that P(≥1) equals the
   H prior, with β0 = txPriorCalls pseudo-calls of weight. Older calls are down-weighted. */
export function transcriptSignal(calls, pPrior, P = DEFAULTS) {
  const sorted = [...(calls || [])].filter((c) => Number.isFinite(c?.count)).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, P.txMaxCalls);
  const p0 = clamp(pPrior, 0.01, 0.99);
  const b0 = P.txPriorCalls;
  const a0 = Math.log(1 - p0) / Math.log(b0 / (b0 + 1));
  let a = a0, b = b0;
  sorted.forEach((c, i) => { const w = P.txDecay ** i; a += w * c.count; b += w; });
  const p = 1 - Math.pow(b / (b + 1), a);
  const n = sorted.length;
  return {
    p: clampP(p), calls: n, hits: sorted.filter((c) => c.count > 0).length,
    mean: n ? sorted.reduce((s, c) => s + c.count, 0) / n : null, last: n ? sorted[0].count : null,
  };
}

/* ---------- logistic regression (Newton / IRLS) with a Gaussian prior on the coefficients ---------- */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function fitLogistic(X, y, { l2 = 1, prior = null, iters = 30 } = {}) {
  const d = X[0]?.length || 0;
  if (!d) return prior ? [...prior] : [];
  const mu = prior || new Array(d).fill(0);
  let w = [...mu];
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      const p = sigmoid(dot(w, x));
      const r = p - y[i], s = Math.max(p * (1 - p), 1e-9);
      for (let j = 0; j < d; j++) {
        g[j] += r * x[j];
        for (let k = j; k < d; k++) H[j][k] += s * x[j] * x[k];
      }
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
    // Penalise distance from the prior mean; the intercept gets a light touch.
    for (let j = 0; j < d; j++) { const lam = j === 0 ? l2 * 0.1 : l2; g[j] += lam * (w[j] - mu[j]); H[j][j] += lam; }
    const step = solve(H, g);
    w = w.map((v, j) => v - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return w;
}

/* ---------- fees, edge, Kelly ---------- */
export const orderFee = (contracts, price, rate = DEFAULTS.feeRate) =>
  Math.ceil(rate * contracts * price * (1 - price) * 100 - 1e-9) / 100;

// Best side to take given our probability and the current book. Buying NO costs 1 − yes_bid.
export function evaluateSides(p, { bid, ask }, P = DEFAULTS) {
  const opts = [];
  const make = (side, price, prob) => {
    const fee = P.feeRate * price * (1 - price);
    const cost = price + fee;
    const edge = prob - cost;
    const kelly = edge > 0 ? edge / (1 - cost) : 0;
    const stakePct = Math.min(P.kellyFraction * kelly, P.maxBetPct);
    return { side, price, prob, fee, cost, edge, kelly, stakePct };
  };
  if (ask != null && ask > 0 && ask < 1) opts.push(make("yes", ask, p));
  if (bid != null && bid > 0 && bid < 1) opts.push(make("no", 1 - bid, 1 - p));
  const best = opts.reduce((a, o) => (!a || o.edge > a.edge ? o : a), null);
  return { best, opts };
}

export function sizeBet(opt, bankroll) {
  if (!opt || opt.stakePct <= 0) return 0;
  return Math.floor((opt.stakePct * bankroll) / opt.cost);
}

/* ---------- prediction ---------- */
const shiftDate = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

// One market → every signal and the blended probability. `r.tx` is the term's counts in this
// company's prior calls. Leakage guard: only transcripts dated at least txGapDays before the
// call count, so a one-day mismatch between Kalshi's event date and a transcript's date can
// never let a call's own transcript predict it.
export function predictRow(r, stats, coefs, P = DEFAULTS) {
  const h = stats.prior(r.company, r.termKey, P);
  const cutoff = r.date ? shiftDate(r.date, -(P.txGapDays ?? 0)) : null;
  const tx = (r.tx || []).filter((c) => c.date && cutoff && (P.txGapDays ? c.date <= cutoff : c.date < r.date));
  const t = transcriptSignal(tx, h.p, P);
  const lH = logit(h.p), lT = logit(t.p);
  const xN = [1, lH, lT - lH];
  let pModel = sigmoid(dot(coefs.coefN, xN));
  const pM = r.pMid != null && r.pMid > 0 && r.pMid < 1 ? r.pMid : null;
  let xM = null, pFinal = pModel;
  if (pM != null) { xM = [...xN, logit(pM)]; pFinal = sigmoid(dot(coefs.coefM, xM)); }
  const pC = r.pClaude != null && r.pClaude > 0 && r.pClaude < 1 ? r.pClaude : null;
  if (pC != null && P.wClaude > 0) {
    pModel = sigmoid((1 - P.wClaude) * logit(pModel) + P.wClaude * logit(pC));
    pFinal = sigmoid((1 - P.wClaude) * logit(pFinal) + P.wClaude * logit(pC));
  }
  return { pH: h.p, pT: t.p, pM, pC, pModel, pFinal, h, t, xN, xM, nHist: stats.n };
}

// Live use: score open markets against all settled history before each call date.
export function predictOpen(openRows, historyRows, coefs, P = DEFAULTS) {
  const byDate = new Map();
  for (const r of openRows) { const k = r.date || "9999-12-31"; (byDate.get(k) || byDate.set(k, []).get(k)).push(r); }
  const out = new Map();
  for (const [date, rows] of byDate) {
    const stats = HistoryStats.from(historyRows, date);
    for (const r of rows) out.set(r.ticker, predictRow(r, stats, coefs, P));
  }
  return out;
}

/* ---------- scoring ---------- */
export function scoreProbs(pairs) {
  const ok = pairs.filter((x) => x.p != null && x.y != null);
  if (!ok.length) return { n: 0, brier: null, logloss: null };
  let b = 0, l = 0;
  for (const { p, y } of ok) { const q = clampP(p); b += (q - y) ** 2; l += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
  return { n: ok.length, brier: b / ok.length, logloss: l / ok.length };
}

export function calibration(pairs, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, sumY: 0 }));
  for (const { p, y } of pairs) {
    if (p == null || y == null) continue;
    const b = out[Math.min(bins - 1, Math.floor(p * bins))];
    b.n++; b.sumP += p; b.sumY += y;
  }
  return out.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, meanP: b.n ? b.sumP / b.n : null, rate: b.n ? b.sumY / b.n : null }));
}

/* ---------- walk-forward backtest ----------
   Dates are processed in order. For each call date: (1) refit the blend on rows from strictly
   earlier dates, (2) predict every market that day from history before that date, (3) only then
   add that day's outcomes to history. Same-day calls never see each other's results. */
export function walkForward(rows, params = {}) {
  const P = { ...DEFAULTS, ...params };
  const usable = rows.filter((r) => r.y != null && r.date && r.termKey);
  const byDate = new Map();
  for (const r of usable) (byDate.get(r.date) || byDate.set(r.date, []).get(r.date)).push(r);
  const dates = [...byDate.keys()].sort();

  const stats = new HistoryStats();
  const XN = [], yN = [], XM = [], yM = [];
  let coefs = { coefN: priorCoefN(), coefM: priorCoefM(P) };
  let fitN = 0, fitM = 0;
  const preds = [];
  let bankroll = P.bankroll, flatPnl = 0;
  const equity = [], bets = [];

  for (const date of dates) {
    // Refit when training data has grown by refitEvery rows or 10%, whichever is larger —
    // keeps the number of fits logarithmic in history size.
    if (XN.length >= P.minTrain && XN.length - fitN >= Math.max(P.refitEvery, 0.1 * fitN)) {
      coefs = { ...coefs, coefN: fitLogistic(XN, yN, { l2: P.l2, prior: priorCoefN() }) }; fitN = XN.length;
    }
    if (XM.length >= P.minTrain && XM.length - fitM >= Math.max(P.refitEvery, 0.1 * fitM)) {
      coefs = { ...coefs, coefM: fitLogistic(XM, yM, { l2: P.l2, prior: priorCoefM(P) }) }; fitM = XM.length;
    }
    const day = byDate.get(date);
    const dayPreds = day.map((r) => ({ r, pr: predictRow(r, stats, coefs, P) }));
    const startBank = bankroll;
    let dayPnl = 0;
    for (const { r, pr } of dayPreds) {
      const rec = { ticker: r.ticker, eventTicker: r.eventTicker, company: r.company, date, term: r.term, y: r.y, pH: pr.pH, pT: pr.pT, pM: pr.pM, pModel: pr.pModel, pFinal: pr.pFinal, nHist: pr.nHist, nCT: pr.h.nCT, txCalls: pr.t.calls };
      preds.push(rec);
      XN.push(pr.xN); yN.push(r.y);
      if (pr.xM) { XM.push(pr.xM); yM.push(r.y); }
      // Trade simulation at the pre-call quote.
      if (pr.nHist >= P.minHistory && (r.volume ?? 0) >= P.minVolume && (r.pBid != null || r.pAsk != null)) {
        const { best } = evaluateSides(pr.pFinal, { bid: r.pBid, ask: r.pAsk }, P);
        if (best && best.edge >= P.minEdge) {
          const won = best.side === "yes" ? r.y === 1 : r.y === 0;
          const n = sizeBet(best, startBank);
          const pnl = n ? (won ? n : 0) - n * best.price - orderFee(n, best.price, P.feeRate) : 0;
          const fc = P.flatContracts;
          const flat = (won ? fc : 0) - fc * best.price - orderFee(fc, best.price, P.feeRate);
          dayPnl += pnl; flatPnl += flat;
          bets.push({ date, ticker: r.ticker, term: r.term, company: r.company, side: best.side, price: best.price, p: pr.pFinal, edge: best.edge, contracts: n, won, pnl, flat });
        }
      }
    }
    bankroll += dayPnl;
    equity.push({ date, bankroll, flatPnl });
    for (const r of day) stats.add(r);
  }

  const scored = preds.filter((p) => p.nHist >= P.minHistory);
  const priced = scored.filter((p) => p.pM != null);
  const pick = (arr, k) => arr.map((p) => ({ p: p[k], y: p.y }));
  const staked = bets.filter((b) => b.contracts > 0);
  const flatCost = bets.reduce((s, b) => s + P.flatContracts * b.price, 0);
  const finalCoefs = {
    coefN: XN.length ? fitLogistic(XN, yN, { l2: P.l2, prior: priorCoefN() }) : priorCoefN(),
    coefM: XM.length ? fitLogistic(XM, yM, { l2: P.l2, prior: priorCoefM(P) }) : priorCoefM(P),
    nN: XN.length, nM: XM.length,
  };
  return {
    params: P,
    counts: { rows: usable.length, dates: dates.length, events: new Set(usable.map((r) => r.eventTicker)).size, scored: scored.length, priced: priced.length, withTx: preds.filter((p) => p.txCalls > 0).length },
    baseRate: scored.length ? scored.reduce((s, p) => s + p.y, 0) / scored.length : null,
    metrics: {
      all: { H: scoreProbs(pick(scored, "pH")), T: scoreProbs(pick(scored, "pT")), model: scoreProbs(pick(scored, "pModel")) },
      priced: { market: scoreProbs(pick(priced, "pM")), H: scoreProbs(pick(priced, "pH")), model: scoreProbs(pick(priced, "pModel")), final: scoreProbs(pick(priced, "pFinal")) },
    },
    calibration: { final: calibration(pick(priced, "pFinal")), market: calibration(pick(priced, "pM")), model: calibration(pick(scored, "pModel")) },
    trading: {
      bets: bets.length,
      wins: bets.filter((b) => b.won).length,
      kellyPnl: bankroll - P.bankroll,
      kellyRoi: staked.length ? (bankroll - P.bankroll) / staked.reduce((s, b) => s + b.contracts * b.price, 0) : null,
      flatPnl,
      flatRoi: flatCost ? flatPnl / flatCost : null,
      avgEdge: bets.length ? bets.reduce((s, b) => s + b.edge, 0) / bets.length : null,
      yesShare: bets.length ? bets.filter((b) => b.side === "yes").length / bets.length : null,
    },
    equity,
    bets,
    preds,
    coefs: finalCoefs,
  };
}
