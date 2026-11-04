import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, logit, sigmoid, HistoryStats, transcriptSignal, fitLogistic, orderFee, evaluateSides, sizeBet,
  predictRow, priorCoefN, priorCoefM, walkForward, scoreProbs, calibration, predictOpen,
} from "../../lib/mentions/model.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// Deterministic PRNG so the synthetic tests are reproducible.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test("logit/sigmoid are inverses", () => { for (const p of [0.02, 0.3, 0.5, 0.9]) close(sigmoid(logit(p)), p, 1e-12); });

test("history prior: empty → ~0.5, own history dominates with recency", () => {
  const s = new HistoryStats();
  close(s.prior("A", "ai").p, 0.5, 1e-9);
  for (const [d, y] of [["2026-01-01", 0], ["2026-04-01", 1], ["2026-07-01", 1]]) s.add({ company: "A", termKey: "ai", y, date: d });
  const p = s.prior("A", "ai");
  assert.equal(p.nCT, 3); assert.equal(p.last, 1);
  assert.ok(p.p > 0.6, `recent hits should lift prior: ${p.p}`);
  // Term rate excludes the company's own rows.
  assert.equal(p.nTerm, 0);
});

test("history prior: HistoryStats.from respects the as-of date", () => {
  const rows = [
    { company: "A", termKey: "x", y: 1, date: "2026-01-01" },
    { company: "A", termKey: "x", y: 1, date: "2026-02-01" },
  ];
  assert.equal(HistoryStats.from(rows, "2026-02-01").n, 1);
  assert.equal(HistoryStats.from(rows, "2026-02-02").n, 2);
});

test("transcript signal: no calls == prior; zeros pull down; repeated mentions push up", () => {
  close(transcriptSignal([], 0.4).p, 0.4, 1e-9);
  const zeros = transcriptSignal([0, 0, 0, 0].map((count, i) => ({ date: `2026-0${i + 1}-01`, count })), 0.5);
  const hits = transcriptSignal([3, 2, 4, 5].map((count, i) => ({ date: `2026-0${i + 1}-01`, count })), 0.5);
  assert.ok(zeros.p < 0.3, `zeros ${zeros.p}`);
  assert.ok(hits.p > 0.9, `hits ${hits.p}`);
  assert.equal(hits.hits, 4); assert.equal(hits.last, 5); // most recent first
  // Monotone in the latest count.
  const a = transcriptSignal([{ date: "2026-01-01", count: 0 }], 0.5).p;
  const b = transcriptSignal([{ date: "2026-01-01", count: 1 }], 0.5).p;
  assert.ok(b > a);
});

test("logistic regression recovers known coefficients", () => {
  const r = rng(7); const truth = [-0.5, 1.2, -0.8];
  const X = [], y = [];
  for (let i = 0; i < 20000; i++) {
    const x = [1, (r() - 0.5) * 4, (r() - 0.5) * 4];
    X.push(x); y.push(r() < sigmoid(truth.reduce((s, w, j) => s + w * x[j], 0)) ? 1 : 0);
  }
  const w = fitLogistic(X, y, { l2: 0.01 });
  truth.forEach((t, j) => assert.ok(Math.abs(w[j] - t) < 0.08, `w${j}=${w[j]} vs ${t}`));
});

test("logistic regression with little data stays near its prior", () => {
  const prior = [0, 1, 1];
  const w = fitLogistic([[1, 0.2, 0], [1, -0.4, 0]], [1, 0], { l2: 50, prior });
  w.forEach((v, j) => assert.ok(Math.abs(v - prior[j]) < 0.1));
});

test("fees, edge and Kelly sizing", () => {
  assert.equal(orderFee(1, 0.5), 0.02);  // 1.75¢ rounds up
  assert.equal(orderFee(100, 0.5), 1.75);
  assert.equal(orderFee(10, 0.95), 0.04); // 3.325¢ → 4¢
  const { best, opts } = evaluateSides(0.7, { bid: 0.55, ask: 0.6 });
  assert.equal(best.side, "yes");
  close(best.edge, 0.7 - 0.6 - 0.07 * 0.6 * 0.4, 1e-12);
  assert.ok(opts.find((o) => o.side === "no").edge < 0);
  const noBest = evaluateSides(0.2, { bid: 0.4, ask: 0.45 }).best;
  assert.equal(noBest.side, "no"); close(noBest.price, 0.6, 1e-12);
  assert.ok(best.stakePct <= DEFAULTS.maxBetPct);
  assert.equal(sizeBet(best, 1000), Math.floor((best.stakePct * 1000) / best.cost));
  assert.equal(evaluateSides(0.5, { bid: null, ask: null }).best, null);
});

test("predictRow ignores transcripts dated on/after the call (leakage guard)", () => {
  const stats = new HistoryStats();
  const coefs = { coefN: priorCoefN(), coefM: priorCoefM() };
  const base = { company: "A", termKey: "ai", date: "2026-05-01" };
  const clean = predictRow({ ...base, tx: [{ date: "2026-02-01", count: 0 }] }, stats, coefs);
  const leaky = predictRow({ ...base, tx: [{ date: "2026-02-01", count: 0 }, { date: "2026-05-01", count: 9 }] }, stats, coefs);
  close(clean.pFinal, leaky.pFinal, 1e-12);
  // A transcript dated two days before the call is treated as possibly the same call.
  const nearby = predictRow({ ...base, tx: [{ date: "2026-02-01", count: 0 }, { date: "2026-04-29", count: 9 }] }, stats, coefs);
  close(clean.pFinal, nearby.pFinal, 1e-12);
});

// Synthetic world: each company×term has a persistent latent probability; markets are priced
// at that probability plus noise. A model that learns persistence should beat the base rate.
function synth(seed = 11, { companies = 30, terms = 25, quarters = 8, priceNoise = 0.15 } = {}) {
  const r = rng(seed); const rows = [];
  const termEff = Array.from({ length: terms }, () => (r() - 0.5) * 3);
  const coEff = Array.from({ length: companies }, () => (r() - 0.5) * 1.5);
  const ctEff = Array.from({ length: companies }, () => Array.from({ length: terms }, () => (r() - 0.5) * 3));
  for (let q = 0; q < quarters; q++) for (let c = 0; c < companies; c++) {
    const month = String((q % 4) * 3 + 1).padStart(2, "0");
    const date = `${2024 + Math.floor(q / 4)}-${month}-${String(1 + (c % 27)).padStart(2, "0")}`;
    for (let t = 0; t < terms; t++) {
      if (r() < 0.4) continue; // not every term listed every quarter
      const p = sigmoid(termEff[t] + coEff[c] + ctEff[c][t]);
      const y = r() < p ? 1 : 0;
      const mid = Math.min(0.97, Math.max(0.03, sigmoid(logit(p) + (r() - 0.5) * 2 * priceNoise * 4)));
      rows.push({ ticker: `S${c}-${q}-${t}`, eventTicker: `S${c}-${q}`, company: `C${c}`, date, term: `t${t}`, termKey: `t${t}`, y, pMid: mid, pBid: mid - 0.02, pAsk: mid + 0.02, volume: 100, pTrue: p });
    }
  }
  return rows;
}

test("walk-forward: no look-ahead — changing future outcomes leaves past predictions unchanged", () => {
  const rows = synth(3, { companies: 12, terms: 10, quarters: 6 });
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)];
  const a = walkForward(rows, { minTrain: 50, refitEvery: 40, minHistory: 0 });
  const flipped = rows.map((r) => (r.date >= cut ? { ...r, y: 1 - r.y } : r));
  const b = walkForward(flipped, { minTrain: 50, refitEvery: 40, minHistory: 0 });
  const byT = new Map(b.preds.map((p) => [p.ticker, p]));
  for (const p of a.preds) {
    if (p.date > cut) continue; // on the cut date itself predictions are still pre-outcome
    close(p.pFinal, byT.get(p.ticker).pFinal, 1e-12);
    close(p.pH, byT.get(p.ticker).pH, 1e-12);
  }
});

test("walk-forward: learns persistence and beats the naive base rate", () => {
  const rows = synth(11);
  const res = walkForward(rows, { minHistory: 300 });
  const base = res.baseRate;
  const naive = scoreProbs(res.preds.filter((p) => p.nHist >= 300).map((p) => ({ p: base, y: p.y }))).brier;
  assert.ok(res.metrics.all.H.brier < naive - 0.01, `H ${res.metrics.all.H.brier} vs naive ${naive}`);
  // With noisy prices the blend should be at least as good as the market alone.
  assert.ok(res.metrics.priced.final.brier <= res.metrics.priced.market.brier + 0.002,
    `final ${res.metrics.priced.final.brier} vs market ${res.metrics.priced.market.brier}`);
  assert.ok(res.coefs.coefM.length === 4 && res.coefs.nM > 0);
  assert.equal(res.counts.rows, rows.length);
  const cal = calibration(res.preds.map((p) => ({ p: p.pFinal, y: p.y })));
  assert.equal(cal.reduce((s, b) => s + b.n, 0), res.preds.length);
});

test("predictOpen scores open markets against history before their date", () => {
  const hist = [{ company: "A", termKey: "ai", y: 1, date: "2026-01-01" }, { company: "A", termKey: "ai", y: 1, date: "2026-06-01" }];
  const coefs = { coefN: priorCoefN(), coefM: priorCoefM() };
  const out = predictOpen([{ ticker: "T1", company: "A", termKey: "ai", date: "2026-03-01" }, { ticker: "T2", company: "A", termKey: "ai", date: "2026-09-01" }], hist, coefs);
  assert.equal(out.get("T1").h.nCT, 1);
  assert.equal(out.get("T2").h.nCT, 2);
});

test("walk-forward scoring window: earlier calls train, only window calls are scored and traded", () => {
  const rows = synth(5, { companies: 15, terms: 10, quarters: 6 });
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const from = dates[Math.floor(dates.length * 0.8)];
  const all = walkForward(rows, { minHistory: 0 });
  const win = walkForward(rows, { minHistory: 0, scoreFrom: from });
  // Same predictions — the window only changes what is scored.
  const byT = new Map(all.preds.map((p) => [p.ticker, p.pFinal]));
  for (const p of win.preds) close(p.pFinal, byT.get(p.ticker), 1e-12);
  assert.equal(win.counts.scored, rows.filter((r) => r.date >= from).length);
  assert.ok(win.bets.every((b) => b.date >= from));
  assert.ok(win.equity.every((e) => e.date >= from));
  assert.equal(win.window.date, from);
  assert.ok(win.window.trainRows > 0 && win.window.fitM > 0);
});

test("Kelly sim never commits more than the day's exposure cap", () => {
  const rows = synth(9, { companies: 25, terms: 20, quarters: 4, priceNoise: 0.35 });
  const res = walkForward(rows, { minHistory: 0, minEdge: 0, kellyFraction: 1, maxBetPct: 0.2, maxDayExposure: 0.5 });
  const start = new Map(res.equity.map((e, i, a) => [e.date, i ? a[i - 1].bankroll : res.params.bankroll]));
  const byDate = new Map();
  for (const b of res.bets) byDate.set(b.date, (byDate.get(b.date) || 0) + b.contracts * (b.price + 0.07 * b.price * (1 - b.price)));
  assert.ok(byDate.size > 0);
  for (const [d, c] of byDate) assert.ok(c <= 0.5 * start.get(d) + 1e-9, `${d}: ${c} > half of ${start.get(d)}`);
  assert.ok(res.trading.naiveNo.bets > 0);
});
