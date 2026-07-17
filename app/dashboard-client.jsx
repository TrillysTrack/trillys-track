"use client";
import { useState, useEffect, useMemo, useRef } from "react";

/* ================= SADDLE CLOTH COLORS (NA standard) ================= */
const CLOTH = {
  1:["#D31145","#FFFFFF"], 2:["#F4F1E9","#141414"], 3:["#1F4FA3","#FFFFFF"],
  4:["#F2C500","#141414"], 5:["#0B6E4F","#FFFFFF"], 6:["#141414","#F2C500"],
  7:["#E86A17","#141414"], 8:["#F49AC1","#141414"], 9:["#37BFC7","#141414"],
  10:["#5E2B97","#FFFFFF"], 11:["#9EA3A8","#B3202C"], 12:["#A6CE39","#141414"],
  13:["#6B4A2B","#FFFFFF"], 14:["#7B1E3B","#F2C500"], 15:["#B4A76C","#141414"],
  16:["#6E9CD2","#B3202C"],
};
const clothOf = (p) => CLOTH[p] || ["#3A3A3A", "#FFFFFF"];

/* ================= STORAGE ================= */
const K_RACES = "hrm-races-v1";
const K_AUTO = "hrm-autoload-v1";
// The user's LOCAL calendar date. Never use toISOString() for "today": it's UTC and rolls
// to tomorrow at 8 PM Eastern, which hides the evening card and breaks "Load today's card".
// Cap concurrent API calls: unbounded Promise.all caused rate-limit storms that made
// every call fail and look like "no data exists". 3 in flight is fast AND reliable.
const pLimit = (max) => {
  let active = 0; const queue = [];
  const next = () => { active--; if (queue.length) queue.shift()(); };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => { active++; fn().then((v) => { next(); resolve(v); }, (e) => { next(); reject(e); }); };
    active < max ? run() : queue.push(run);
  });
};

const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const AUTO_RAN = { done: false };
const K_ENT = "hrm-entities-v1";
const K_PINK = "hrm-pinksheet-v1";
const K_BETS = "hrm-bets-v1";

/* tiny CSV parser (handles quoted fields) */
function parseCSV(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (cur !== "" || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// Parse a distance string ("5 1/2F", "7F", "1 3/8M", "1 1/16M", "1M") into furlongs.
// Miles are converted at 8 furlongs/mile. Returns null if unrecognized. A bare number
// is treated as furlongs (so a numeric distance_f column still works).
function parseDistanceF(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (str === "") return null;
  const asNum = parseFloat(str);
  if (/^\s*\d+(\.\d+)?\s*$/.test(str)) return asNum;               // already furlongs
  const m = str.match(/^\s*(\d+)?\s*(?:(\d+)\/(\d+))?\s*([FfMm])\s*$/);
  if (m) {
    const whole = m[1] ? parseFloat(m[1]) : 0;
    const frac = m[2] ? parseFloat(m[2]) / parseFloat(m[3]) : 0;
    const val = whole + frac;
    return /[Mm]/.test(m[4]) ? Math.round(val * 8 * 1000) / 1000 : Math.round(val * 1000) / 1000;
  }
  return isFinite(asNum) ? asNum : null;
}

// Shrink an observed win rate toward a prior by sample size (Beta-style):
// (wins + prior*K) / (starts + K). Small meet samples (a 2-start owner) collapse
// toward the prior; large samples (a 60-start jockey) keep their real rate.
function shrinkPct(wins, starts, prior, K) {
  const w = Number(wins), s = Number(starts);
  if (!isFinite(s) || s <= 0 || !isFinite(w)) return prior;
  return (w + prior * K) / (s + K);
}

// Real database-backed storage (Postgres via our own /api/kv route) — replaces the
// Claude-artifact window.storage that turned out not to persist reliably. Same
// function signatures as before, so nothing else in this file needs to change.
async function loadKey(key, fallback) {
  try {
    const r = await fetch(`/api/kv?key=${encodeURIComponent(key)}`, { cache: "no-store" });
    if (r.status === 404) return fallback;
    if (!r.ok) { console.error("load failed", r.status, await r.text().catch(() => "")); return fallback; }
    const data = await r.json();
    return data && typeof data.value === "string" ? JSON.parse(data.value) : fallback;
  } catch (e) { console.error("load failed", e); return fallback; }
}
async function saveKey(key, obj) {
  try {
    const r = await fetch("/api/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: JSON.stringify(obj) }),
    });
    if (!r.ok) { console.error("save failed", r.status, await r.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("save failed", e); return false; }
}

/* ================= SEED DATA: Saratoga 2026 meet, July 3-9 (merged on load, deduped by track|date|race) ================= */
const SEED_RACES = [{"id":"Saratoga-2026-07-03-R1-import","track":"Saratoga","date":"2026-07-03","raceNumber":1,"surface":"Dirt","distanceF":9.0,"condition":"unknown","raceType":"Allowance","purse":"$120,000","entries":[{"post":1,"horse":"Nogradi","jockey":"Martin Chuan","trainer":"Keri Brion","owner":"","ml":"5/1","scratched":false},{"post":2,"horse":"McAfee","jockey":"John R. Velazquez","trainer":"George Weaver","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Chillax","jockey":"Tyler Gaffalione","trainer":"David Jacobson","owner":"","ml":"8/1","scratched":false},{"post":4,"horse":"Fact","jockey":"Flavien Prat","trainer":"William Walden","owner":"","ml":"5/2","scratched":false},{"post":5,"horse":"Pretty Boy Miah","jockey":"Ricardo Santana Jr.","trainer":"Jeremiah C. Englehart","owner":"","ml":"6/1","scratched":false},{"post":6,"horse":"Founders","jockey":"Manuel Franco","trainer":"Saffie A. Joseph Jr.","owner":"","ml":"3/1","scratched":false},{"post":7,"horse":"Copious","jockey":"Jose L. Ortiz","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false}],"results":["McAfee","Chillax","Pretty Boy Miah","Nogradi","Founders","Copious","Fact"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R2-import","track":"Saratoga","date":"2026-07-03","raceNumber":2,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Maiden Special Weight","purse":"$115,000","entries":[{"post":3,"horse":"Charlotte's Beach","jockey":"Jose L. Ortiz","trainer":"Mark E. Casse","owner":"","ml":"7/2","scratched":false},{"post":4,"horse":"Girls Wear Pearls","jockey":"Flavien Prat","trainer":"Jena M. Antonucci","owner":"","ml":"9/2","scratched":false},{"post":5,"horse":"Timbertop","jockey":"John R. Velazquez","trainer":"Wesley A. Ward","owner":"","ml":"3/1","scratched":false},{"post":6,"horse":"Pavlova's Palace (GB)","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"8/1","scratched":false},{"post":7,"horse":"Allura","jockey":"Tyler Gaffalione","trainer":"Kelsey Danner","owner":"","ml":"12/1","scratched":false},{"post":8,"horse":"Bourbon Madness","jockey":"Dylan Davis","trainer":"Mark A. Hennig","owner":"","ml":"20/1","scratched":false},{"post":9,"horse":"Rockabye","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"4/1","scratched":false}],"results":["Allura","Rockabye","Girls Wear Pearls","Charlotte's Beach","Pavlova's Palace (GB)","Timbertop","Bourbon Madness"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R3-import","track":"Saratoga","date":"2026-07-03","raceNumber":3,"surface":"Dirt","distanceF":6.0,"condition":"unknown","raceType":"Allowance","purse":"$105,000","entries":[{"post":1,"horse":"Mo for the King","jockey":"Flavien Prat","trainer":"Robert N. Falcone Jr.","owner":"","ml":"8/5","scratched":false},{"post":2,"horse":"Liberty Rising","jockey":"Omar Hernandez Moreno","trainer":"Patrick J. Quick","owner":"","ml":"30/1","scratched":false},{"post":3,"horse":"Anyway","jockey":"Manuel Franco","trainer":"Linda Rice","owner":"","ml":"5/2","scratched":false},{"post":4,"horse":"Fireballin","jockey":"Tyler Gaffalione","trainer":"Michael J. Maker","owner":"","ml":"5/1","scratched":false},{"post":6,"horse":"B Provocateur","jockey":"Ricardo Santana Jr.","trainer":"Rudy R. Rodriguez","owner":"","ml":"15/1","scratched":false},{"post":7,"horse":"The Toy Cannon","jockey":"Jaime Rodriguez","trainer":"Linda K. Dixon","owner":"","ml":"6/1","scratched":false}],"results":["Anyway","B Provocateur","Mo for the King","Liberty Rising","The Toy Cannon","Fireballin"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R4-import","track":"Saratoga","date":"2026-07-03","raceNumber":4,"surface":"Dirt","distanceF":7.0,"condition":"unknown","raceType":"Maiden Claiming $20k","purse":"$41,000","entries":[{"post":1,"horse":"Rumblyoungmanrumbl","jockey":"Javier Castellano","trainer":"David G. Donk","owner":"","ml":"10/1","scratched":false},{"post":2,"horse":"Trail Blaze","jockey":"Jose L. Ortiz","trainer":"Linda Rice","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Private Flight","jockey":"Jose Lezcano","trainer":"Mark A. Hennig","owner":"","ml":"5/2","scratched":false},{"post":4,"horse":"Bellamy","jockey":"Ricardo Santana Jr.","trainer":"Ricardo E. Legall","owner":"","ml":"15/1","scratched":false},{"post":5,"horse":"Ryan's Shadow","jockey":"Manuel Franco","trainer":"Brad H. Cox","owner":"","ml":"4/1","scratched":false},{"post":7,"horse":"Mr R T","jockey":"Flavien Prat","trainer":"Jose M. Jimenez","owner":"","ml":"7/2","scratched":false},{"post":8,"horse":"Restless Renegade","jockey":"Ruben Silvera","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false},{"post":9,"horse":"United Steins","jockey":"Omar Hernandez Moreno","trainer":"Wayne Potts","owner":"","ml":"30/1","scratched":false}],"results":["Rumblyoungmanrumbl","Mr R T","Private Flight","Trail Blaze","Ryan's Shadow","United Steins","Bellamy","Restless Renegade"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R5-import","track":"Saratoga","date":"2026-07-03","raceNumber":5,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Allowance","purse":"$120,000","entries":[{"post":1,"horse":"Minute by Minute","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Next On Stage","jockey":"Manuel Franco","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false},{"post":3,"horse":"Paula's a Star","jockey":"Ricardo Santana Jr.","trainer":"Thomas Morley","owner":"","ml":"4/1","scratched":false},{"post":4,"horse":"Ratu Jawa","jockey":"Cesar Gonzalez","trainer":"Douglas J. Seyler","owner":"","ml":"15/1","scratched":false},{"post":5,"horse":"Oscar Bound","jockey":"Shaun Bridgmohan","trainer":"Melanie Giddings","owner":"","ml":"20/1","scratched":false},{"post":6,"horse":"One Last Knock","jockey":"Jaime Rodriguez","trainer":"Keri Brion","owner":"","ml":"6/1","scratched":false},{"post":7,"horse":"Oscar's Encore","jockey":"Jose L. Ortiz","trainer":"Joe Sharp","owner":"","ml":"5/1","scratched":false},{"post":8,"horse":"Kilby Girl","jockey":"Dylan Davis","trainer":"Wesley A. Ward","owner":"","ml":"8/1","scratched":false},{"post":9,"horse":"One More Guitar","jockey":"Jose Lezcano","trainer":"Thomas F. Proctor","owner":"","ml":"9/2","scratched":false}],"results":["Oscar's Encore","Kilby Girl","One Last Knock","Ratu Jawa","Paula's a Star","One More Guitar","Oscar Bound","Next On Stage","Minute by Minute"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R6-import","track":"Saratoga","date":"2026-07-03","raceNumber":6,"surface":"Dirt","distanceF":9.0,"condition":"unknown","raceType":"Claiming $12,500","purse":"$37,000","entries":[{"post":1,"horse":"Polar Bear Plunge","jockey":"Ricardo Santana Jr.","trainer":"Mertkan Kantarmaci","owner":"","ml":"5/1","scratched":false},{"post":2,"horse":"Catch the Smoke","jockey":"Reylu Gutierrez","trainer":"Robert N. Falcone Jr.","owner":"","ml":"8/1","scratched":false},{"post":3,"horse":"Prove Worthy","jockey":"Edgard J. Zayas","trainer":"William E. Morey","owner":"","ml":"7/2","scratched":false},{"post":4,"horse":"Metatron's Muse","jockey":"Jose L. Ortiz","trainer":"Orlando Noda","owner":"","ml":"5/2","scratched":false},{"post":5,"horse":"Shipsational","jockey":"Silvestre Gonzalez","trainer":"Ilkay Kantarmaci","owner":"","ml":"9/2","scratched":false},{"post":6,"horse":"Petrolo","jockey":"Manuel Franco","trainer":"H. James Bond","owner":"","ml":"6/1","scratched":false},{"post":7,"horse":"Laughing Boy","jockey":"Ruben Silvera","trainer":"Michael A. Simmonds","owner":"","ml":"20/1","scratched":false}],"results":["Metatron's Muse","Polar Bear Plunge","Petrolo","Shipsational","Catch the Smoke","Prove Worthy","Laughing Boy"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R7-import","track":"Saratoga","date":"2026-07-03","raceNumber":7,"surface":"Dirt","distanceF":7.0,"condition":"unknown","raceType":"Allowance","purse":"$120,000","entries":[{"post":1,"horse":"Silver Talent","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Belgian","jockey":"Javier Castellano","trainer":"George Weaver","owner":"","ml":"3/1","scratched":false},{"post":3,"horse":"Hit the Post","jockey":"Shaun Bridgmohan","trainer":"Melanie Giddings","owner":"","ml":"7/2","scratched":false},{"post":4,"horse":"Private Desire","jockey":"Jaime Rodriguez","trainer":"Thomas Morley","owner":"","ml":"15/1","scratched":false},{"post":5,"horse":"Fort Nelson","jockey":"Jose L. Ortiz","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false},{"post":6,"horse":"Magnanimous Max","jockey":"Manuel Franco","trainer":"Linda Rice","owner":"","ml":"4/1","scratched":false},{"post":7,"horse":"White Smoke Rising","jockey":"John R. Velazquez","trainer":"Charlton Baker","owner":"","ml":"9/2","scratched":false}],"results":["White Smoke Rising","Private Desire","Silver Talent","Belgian","Hit the Post","Fort Nelson","Magnanimous Max"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R8-import","track":"Saratoga","date":"2026-07-03","raceNumber":8,"surface":"Inner turf","distanceF":8.0,"condition":"unknown","raceType":"Wild Applause S.","purse":"$150,000","entries":[{"post":1,"horse":"Scratch It","jockey":"Manuel Franco","trainer":"Brad H. Cox","owner":"","ml":"12/1","scratched":false},{"post":2,"horse":"Paris Carver","jockey":"Javier Castellano","trainer":"Jorge Delgado","owner":"","ml":"12/1","scratched":false},{"post":3,"horse":"Alone Time","jockey":"John R. Velazquez","trainer":"Cherie DeVaux","owner":"","ml":"20/1","scratched":false},{"post":4,"horse":"Candy Moonshine","jockey":"Jaime Rodriguez","trainer":"Michael E. Gorham","owner":"","ml":"15/1","scratched":false},{"post":6,"horse":"Smexy (IRE)","jockey":"Tyler Gaffalione","trainer":"Brendan P. Walsh","owner":"","ml":"7/2","scratched":false},{"post":7,"horse":"To a Flame","jockey":"Jose L. Ortiz","trainer":"George R. Arnold II","owner":"","ml":"9/2","scratched":false},{"post":8,"horse":"Lovely Grey","jockey":"Dylan Davis","trainer":"Kelsey Danner","owner":"","ml":"4/1","scratched":false},{"post":9,"horse":"I Love Giraffes","jockey":"Paco Lopez","trainer":"Chad Summers","owner":"","ml":"6/1","scratched":false},{"post":10,"horse":"Code","jockey":"Flavien Prat","trainer":"Steven Hampson","owner":"","ml":"5/1","scratched":false},{"post":11,"horse":"Pillar of Beauty","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"8/1","scratched":false}],"results":["To a Flame","Pillar of Beauty","Code","Candy Moonshine","Scratch It","Alone Time","Smexy (IRE)","Lovely Grey","Paris Carver","I Love Giraffes"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R9-import","track":"Saratoga","date":"2026-07-03","raceNumber":9,"surface":"Dirt","distanceF":6.0,"condition":"unknown","raceType":"Schuylerville S. (G3)","purse":"$200,000","entries":[{"post":1,"horse":"Voyager","jockey":"Jose L. Ortiz","trainer":"Mark E. Casse","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Prime Aurora","jockey":"John R. Velazquez","trainer":"Abraham Gardea","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Pot's Right","jockey":"Ricardo Santana Jr.","trainer":"Philip Antonacci","owner":"","ml":"12/1","scratched":false},{"post":4,"horse":"Madeleine Swann","jockey":"Javier Castellano","trainer":"Jorge Delgado","owner":"","ml":"8/1","scratched":false},{"post":6,"horse":"Harper's Corner","jockey":"Paco Lopez","trainer":"Cathal A. Lynch","owner":"","ml":"6/1","scratched":false},{"post":8,"horse":"Luminous Beauty","jockey":"Flavien Prat","trainer":"Jena M. Antonucci","owner":"","ml":"3/1","scratched":false}],"results":["Harper's Corner","Voyager","Prime Aurora","Pot's Right","Luminous Beauty","Madeleine Swann"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R10-import","track":"Saratoga","date":"2026-07-03","raceNumber":10,"surface":"Turf","distanceF":8.5,"condition":"unknown","raceType":"Saranac S. (G3)","purse":"$150,000","entries":[{"post":1,"horse":"Siyouincanada (FR)","jockey":"Jose L. Ortiz","trainer":"Joe Sharp","owner":"","ml":"9/2","scratched":false},{"post":2,"horse":"Heeere's Johnny","jockey":"Dylan Davis","trainer":"Raymond Handal","owner":"","ml":"20/1","scratched":false},{"post":3,"horse":"Go Grey","jockey":"Paco Lopez","trainer":"Michael J. Trombetta","owner":"","ml":"12/1","scratched":false},{"post":4,"horse":"Teddy's Rocket","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Tiz Trouble","jockey":"Junior Alvarado","trainer":"Lisa L. Lewis","owner":"","ml":"20/1","scratched":false},{"post":6,"horse":"My Favorite Bird","jockey":"Tyler Gaffalione","trainer":"J. Kent Sweezey","owner":"","ml":"20/1","scratched":false},{"post":7,"horse":"Glavine","jockey":"John R. Velazquez","trainer":"Thomas Morley","owner":"","ml":"4/1","scratched":false},{"post":8,"horse":"Print","jockey":"Ricardo Santana Jr.","trainer":"Robert Ribaudo","owner":"","ml":"20/1","scratched":false},{"post":9,"horse":"Blinging It Back","jockey":"Edgard J. Zayas","trainer":"Mark E. Casse","owner":"","ml":"12/1","scratched":false},{"post":10,"horse":"Zeppelin","jockey":"Jose Lezcano","trainer":"George R. Arnold II","owner":"","ml":"10/1","scratched":false},{"post":11,"horse":"Arizona Territory","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"5/2","scratched":false}],"results":["Heeere's Johnny","Blinging It Back","Glavine","Arizona Territory","Print","Siyouincanada (FR)","Tiz Trouble","Go Grey","Teddy's Rocket","Zeppelin","My Favorite Bird"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-03-R11-import","track":"Saratoga","date":"2026-07-03","raceNumber":11,"surface":"Inner turf","distanceF":8.5,"condition":"unknown","raceType":"Starter Opt. Claiming $45k","purse":"$78,000","entries":[{"post":2,"horse":"Spying","jockey":"Tyler Gaffalione","trainer":"Brendan P. Walsh","owner":"","ml":"10/1","scratched":false},{"post":3,"horse":"Salt Princess","jockey":"John R. Velazquez","trainer":"David G. Donk","owner":"","ml":"8/1","scratched":false},{"post":4,"horse":"Lotus Petal","jockey":"Edgard J. Zayas","trainer":"Jena M. Antonucci","owner":"","ml":"20/1","scratched":false},{"post":5,"horse":"Dividend Recap","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"2/1","scratched":false},{"post":6,"horse":"Pretty Lavish (IRE)","jockey":"Jaime Rodriguez","trainer":"Amelia J. Green","owner":"","ml":"4/1","scratched":false},{"post":7,"horse":"Lady River Lily","jockey":"Cesar Gonzalez","trainer":"Douglas J. Seyler","owner":"","ml":"30/1","scratched":false},{"post":9,"horse":"River Tay (IRE)","jockey":"Dylan Davis","trainer":"Bruce R. Brown","owner":"","ml":"6/1","scratched":false},{"post":10,"horse":"Brokealltherules","jockey":"Flavien Prat","trainer":"Richard E. Dutrow Jr.","owner":"","ml":"7/2","scratched":false}],"results":["Brokealltherules","Dividend Recap","Lotus Petal","River Tay (IRE)","Pretty Lavish (IRE)","Salt Princess","Lady River Lily","Spying"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-04-R1-import","track":"Saratoga","date":"2026-07-04","raceNumber":1,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Feminism","jockey":"Jose L. Ortiz","trainer":"Steven M. Asmussen","owner":"","ml":"3/1","scratched":false},{"post":2,"horse":"Irresistible","jockey":"Flavien Prat","trainer":"Steven M. Asmussen","owner":"","ml":"15/1","scratched":false},{"post":3,"horse":"Lovely Christina","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"5/2","scratched":false},{"post":4,"horse":"Mashallah","jockey":"Tyler Gaffalione","trainer":"Brendan P. Walsh","owner":"","ml":"3/5","scratched":false},{"post":5,"horse":"Lightscape","jockey":"Jose Lezcano","trainer":"Thomas F. Proctor","owner":"","ml":"15/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-04-R2-import","track":"Saratoga","date":"2026-07-04","raceNumber":2,"surface":"Inner turf","distanceF":8.0,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Ori","jockey":"Ruben Silvera","trainer":"Michelle Nevin","owner":"","ml":"8/1","scratched":false},{"post":2,"horse":"Accent (GB)","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"8/5","scratched":false},{"post":3,"horse":"Vekoma View","jockey":"Manuel Franco","trainer":"George Weaver","owner":"","ml":"6/1","scratched":false},{"post":4,"horse":"Eponine (IRE)","jockey":"Jose L. Ortiz","trainer":"Kevin Attard","owner":"","ml":"5/2","scratched":false},{"post":5,"horse":"Make You Mine (IRE)","jockey":"Tyler Gaffalione","trainer":"Chad C. Brown","owner":"","ml":"6/1","scratched":false},{"post":6,"horse":"New Rose","jockey":"Edgard J. Zayas","trainer":"Jena M. Antonucci","owner":"","ml":"10/1","scratched":false},{"post":7,"horse":"Bourbon Betty","jockey":"Dylan Davis","trainer":"Mark A. Hennig","owner":"","ml":"20/1","scratched":false},{"post":8,"horse":"Special Wood (FR)","jockey":"Jose Lezcano","trainer":"Thomas F. Proctor","owner":"","ml":"12/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-04-R3-import","track":"Saratoga","date":"2026-07-04","raceNumber":3,"surface":"Turf","distanceF":8.5,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Saint Tropez","jockey":"Ricardo Santana Jr.","trainer":"Philip Antonacci","owner":"","ml":"8/1","scratched":false},{"post":2,"horse":"Fango Creek","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"8/1","scratched":false},{"post":3,"horse":"Madeline's Agenda","jockey":"Jose Lezcano","trainer":"Jorge R. Abreu","owner":"","ml":"30/1","scratched":false},{"post":4,"horse":"Romala","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"10/1","scratched":false},{"post":5,"horse":"Secretly Delighted","jockey":"Javier Castellano","trainer":"Mark E. Casse","owner":"","ml":"9/2","scratched":false},{"post":6,"horse":"Shelzawa (FR)","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"5/2","scratched":false},{"post":7,"horse":"Home Wrecker","jockey":"Joel Rosario","trainer":"Danny Gargan","owner":"","ml":"10/1","scratched":false},{"post":8,"horse":"Nonconsecutivetrms","jockey":"Tyler Gaffalione","trainer":"Brendan P. Walsh","owner":"","ml":"7/2","scratched":false},{"post":9,"horse":"River Empress","jockey":"Edgard J. Zayas","trainer":"Melanie Giddings","owner":"","ml":"20/1","scratched":false},{"post":10,"horse":"Bourbon Milk Punch","jockey":"Jose L. Ortiz","trainer":"Horacio De Paz","owner":"","ml":"8/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-04-R4-import","track":"Saratoga","date":"2026-07-04","raceNumber":4,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Lightning Strike","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"9/5","scratched":false},{"post":2,"horse":"Graceful Rose","jockey":"Ricardo Santana Jr.","trainer":"Michael E. Gorham","owner":"","ml":"15/1","scratched":false},{"post":3,"horse":"Princess Wadadli","jockey":"Flavien Prat","trainer":"Robert N. Falcone Jr.","owner":"","ml":"8/1","scratched":false},{"post":4,"horse":"Angel Gift","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"12/1","scratched":false},{"post":5,"horse":"Queens Cat","jockey":"Nazario Alvarado","trainer":"Linda K. Dixon","owner":"","ml":"6/1","scratched":false},{"post":6,"horse":"Baseball Lady","jockey":"Jose L. Ortiz","trainer":"Linda Rice","owner":"","ml":"8/1","scratched":false},{"post":7,"horse":"Britain","jockey":"Javier Castellano","trainer":"Jorge Delgado","owner":"","ml":"4/1","scratched":false},{"post":8,"horse":"Grace and Grit","jockey":"Jaime Rodriguez","trainer":"Amelia J. Green","owner":"","ml":"7/2","scratched":false}],"results":null},{"id":"Saratoga-2026-07-04-R5-import","track":"Saratoga","date":"2026-07-04","raceNumber":5,"surface":"Dirt","distanceF":6.0,"condition":"unknown","raceType":"Sanford S. (G3)","purse":"","entries":[{"post":1,"horse":"Waggley","jockey":"Junior Alvarado","trainer":"Wesley A. Ward","owner":"","ml":"6/1","scratched":false},{"post":2,"horse":"Booked","jockey":"Ricardo Santana Jr.","trainer":"Steven M. Asmussen","owner":"","ml":"3/1","scratched":false},{"post":3,"horse":"Goodbye to Romance","jockey":"Flavien Prat","trainer":"Jena M. Antonucci","owner":"","ml":"10/1","scratched":false},{"post":4,"horse":"Pocket Listing","jockey":"Manuel Franco","trainer":"Doug F. O'Neill","owner":"","ml":"9/2","scratched":false},{"post":5,"horse":"Vissino","jockey":"Jose L. Ortiz","trainer":"Mark E. Casse","owner":"","ml":"6/1","scratched":false},{"post":6,"horse":"Jack's Golden Goal","jockey":"Joel Rosario","trainer":"Antonio Arriaga","owner":"","ml":"8/1","scratched":false},{"post":7,"horse":"Ashcroft Lane","jockey":"Dylan Davis","trainer":"Robert N. Falcone Jr.","owner":"","ml":"5/1","scratched":false},{"post":8,"horse":"Regent's Park","jockey":"John R. Velazquez","trainer":"Jorge Delgado","owner":"","ml":"8/1","scratched":false},{"post":9,"horse":"Rasasi","jockey":"Tyler Gaffalione","trainer":"Antonio Sano","owner":"","ml":"10/1","scratched":false}],"results":["Booked","Vissino","Goodbye to Romance"],"resultsMeta":{"partial":true,"source":"Racing Post top 3 (seeded)"}},{"id":"Saratoga-2026-07-04-R6-import","track":"Saratoga","date":"2026-07-04","raceNumber":6,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Punto Forty","jockey":"Jose Lezcano","trainer":"Linda Rice","owner":"","ml":"10/1","scratched":false},{"post":2,"horse":"Cristobal","jockey":"Manuel Franco","trainer":"Robert N. Falcone Jr.","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Diamond Child","jockey":"Junior Alvarado","trainer":"Melanie Giddings","owner":"","ml":"30/1","scratched":false},{"post":4,"horse":"Truman's Commander","jockey":"Edgard J. Zayas","trainer":"Mark E. Casse","owner":"","ml":"5/1","scratched":false},{"post":5,"horse":"Rhyton","jockey":"Flavien Prat","trainer":"Miguel Clement","owner":"","ml":"6/1","scratched":false},{"post":6,"horse":"Stormy Birthday","jockey":"Jaime Rodriguez","trainer":"Robert Ribaudo","owner":"","ml":"15/1","scratched":false},{"post":7,"horse":"Mozambique","jockey":"Ruben Silvera","trainer":"Rudy R. Rodriguez","owner":"","ml":"20/1","scratched":false},{"post":8,"horse":"Guilty","jockey":"Tyler Gaffalione","trainer":"Bruce N. Levine","owner":"","ml":"20/1","scratched":false},{"post":9,"horse":"Three Thirteen","jockey":"Shaun Bridgmohan","trainer":"Melanie Giddings","owner":"","ml":"12/1","scratched":false},{"post":10,"horse":"Diliello","jockey":"Ricardo Santana Jr.","trainer":"Thomas Morley","owner":"","ml":"12/1","scratched":false},{"post":11,"horse":"Van Vollenhoven","jockey":"Javier Castellano","trainer":"David P. Duggan","owner":"","ml":"7/2","scratched":false},{"post":12,"horse":"King Puck","jockey":"John R. Velazquez","trainer":"Michael J. Maker","owner":"","ml":"6/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-04-R7-import","track":"Saratoga","date":"2026-07-04","raceNumber":7,"surface":"Inner turf","distanceF":9.0,"condition":"unknown","raceType":"Belmont Oaks Invitational (G1)","purse":"","entries":[{"post":1,"horse":"Just Aloof","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"8/1","scratched":false},{"post":2,"horse":"Time to Dream","jockey":"Edgard J. Zayas","trainer":"Todd A. Pletcher","owner":"","ml":"12/1","scratched":false},{"post":3,"horse":"Kensington Lane (IRE)","jockey":"Joel Rosario","trainer":"Donnacha O'Brien","owner":"","ml":"10/1","scratched":false},{"post":4,"horse":"Faithful Departed","jockey":"Jose L. Ortiz","trainer":"Grant T. Forster","owner":"","ml":"5/1","scratched":false},{"post":5,"horse":"Storm's Wake","jockey":"Dylan Davis","trainer":"Brian A. Lynch","owner":"","ml":"10/1","scratched":false},{"post":6,"horse":"Fitz Right","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"6/1","scratched":false},{"post":7,"horse":"Carmensita (ARG)","jockey":"Ricardo Santana Jr.","trainer":"Horacio De Paz","owner":"","ml":"30/1","scratched":false},{"post":8,"horse":"Abashiri (GB)","jockey":"William Buick","trainer":"Charles Appleby","owner":"","ml":"5/2","scratched":false},{"post":9,"horse":"Ultimate Love","jockey":"John R. Velazquez","trainer":"Michael J. Trombetta","owner":"","ml":"10/1","scratched":false},{"post":10,"horse":"Imaginationthelady","jockey":"Tyler Gaffalione","trainer":"Brendan P. Walsh","owner":"","ml":"4/1","scratched":false}],"results":["Kensington Lane (IRE)","Faithful Departed","Fitz Right"],"resultsMeta":{"partial":true,"source":"Racing Post top 3 (seeded)"}},{"id":"Saratoga-2026-07-04-R8-import","track":"Saratoga","date":"2026-07-04","raceNumber":8,"surface":"Dirt","distanceF":10.0,"condition":"unknown","raceType":"Suburban S. (G2)","purse":"","entries":[{"post":1,"horse":"Classicist","jockey":"Javier Castellano","trainer":"Todd A. Pletcher","owner":"","ml":"20/1","scratched":false},{"post":2,"horse":"Forged Steel","jockey":"Flavien Prat","trainer":"Saffie A. Joseph Jr.","owner":"","ml":"4/1","scratched":false},{"post":3,"horse":"Yo Daddy","jockey":"Ricardo Santana Jr.","trainer":"Linda Rice","owner":"","ml":"15/1","scratched":false},{"post":4,"horse":"Parchment Party","jockey":"Jose Lezcano","trainer":"William I. Mott","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Tiztastic","jockey":"Jose L. Ortiz","trainer":"Steven M. Asmussen","owner":"","ml":"12/1","scratched":false},{"post":6,"horse":"Phileas Fogg","jockey":"Kendrick Carmouche","trainer":"Gustavo Rodriguez","owner":"","ml":"8/1","scratched":false},{"post":7,"horse":"Antiquarian","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"3/1","scratched":false},{"post":8,"horse":"Hit Show","jockey":"Manuel Franco","trainer":"Brad H. Cox","owner":"","ml":"5/1","scratched":false},{"post":9,"horse":"Stars and Stripes","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"6/1","scratched":false},{"post":10,"horse":"Original Sin","jockey":"Tyler Gaffalione","trainer":"Brendan P. Walsh","owner":"","ml":"10/1","scratched":false},{"post":11,"horse":"Obstacle (BRZ)","jockey":"Joel Rosario","trainer":"Paulo H. Lobo","owner":"","ml":"30/1","scratched":false}],"results":["Phileas Fogg","Hit Show","Tiztastic"],"resultsMeta":{"partial":true,"source":"Racing Post top 3 (seeded)"}},{"id":"Saratoga-2026-07-04-R9-import","track":"Saratoga","date":"2026-07-04","raceNumber":9,"surface":"Turf","distanceF":9.0,"condition":"unknown","raceType":"Belmont Derby Invitational (G1)","purse":"","entries":[{"post":1,"horse":"Blackmail","jockey":"Javier Castellano","trainer":"Mark E. Casse","owner":"","ml":"12/1","scratched":false},{"post":2,"horse":"Bottas","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"10/1","scratched":false},{"post":3,"horse":"Remember Mamba","jockey":"Jose L. Ortiz","trainer":"Cherie DeVaux","owner":"","ml":"7/2","scratched":false},{"post":4,"horse":"Third Coast","jockey":"Jose Lezcano","trainer":"Thomas F. Proctor","owner":"","ml":"20/1","scratched":false},{"post":5,"horse":"Turf Star","jockey":"Dylan Davis","trainer":"H. Graham Motion","owner":"","ml":"30/1","scratched":false},{"post":6,"horse":"Pacific Avenue (IRE)","jockey":"William Buick","trainer":"Charles Appleby","owner":"","ml":"6/1","scratched":false},{"post":7,"horse":"Tiernanogue","jockey":"Ricardo Santana Jr.","trainer":"Brendan P. Walsh","owner":"","ml":"10/1","scratched":false},{"post":8,"horse":"West End Kid","jockey":"Tyler Gaffalione","trainer":"William Walden","owner":"","ml":"3/1","scratched":false},{"post":9,"horse":"Title Role (GB)","jockey":"John R. Velazquez","trainer":"Simon Crisford","owner":"","ml":"5/1","scratched":false},{"post":10,"horse":"Touch of Fire","jockey":"Flavien Prat","trainer":"Brad H. Cox","owner":"","ml":"5/1","scratched":false}],"results":["Title Role (GB)","West End Kid","Remember Mamba"],"resultsMeta":{"partial":true,"source":"Racing Post top 3 (seeded)"}},{"id":"Saratoga-2026-07-04-R10-import","track":"Saratoga","date":"2026-07-04","raceNumber":10,"surface":"Dirt","distanceF":8.0,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Bank Frenzy","jockey":"Manuel Franco","trainer":"Rudy R. Rodriguez","owner":"","ml":"8/1","scratched":false},{"post":2,"horse":"Tarantino","jockey":"Tyler Gaffalione","trainer":"David Jacobson","owner":"","ml":"8/1","scratched":false},{"post":3,"horse":"Full Screen","jockey":"Jose L. Ortiz","trainer":"Saffie A. Joseph Jr.","owner":"","ml":"7/2","scratched":false},{"post":4,"horse":"Bourbon Day","jockey":"Jose Lezcano","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false},{"post":5,"horse":"Reasoned Analysis","jockey":"Dylan Davis","trainer":"Chad C. Brown","owner":"","ml":"8/1","scratched":false},{"post":6,"horse":"Tuscan Sky","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"10/1","scratched":false},{"post":7,"horse":"Capital Idea","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"4/1","scratched":false},{"post":8,"horse":"Bramito","jockey":"Ricardo Santana Jr.","trainer":"Steven I. Schauer","owner":"","ml":"5/1","scratched":false},{"post":9,"horse":"Warp Nine","jockey":"Javier Castellano","trainer":"Harold Wyner","owner":"","ml":"15/1","scratched":false},{"post":10,"horse":"Flood Zone","jockey":"Flavien Prat","trainer":"Brad H. Cox","owner":"","ml":"12/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-04-R11-import","track":"Saratoga","date":"2026-07-04","raceNumber":11,"surface":"Inner turf","distanceF":8.5,"condition":"unknown","raceType":"","purse":"","entries":[{"post":1,"horse":"Morning Prayer","jockey":"Ricardo Santana Jr.","trainer":"Thomas Morley","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Coach of the Year","jockey":"Jose Lezcano","trainer":"George Weaver","owner":"","ml":"12/1","scratched":false},{"post":3,"horse":"Lyn's Legacy","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"5/1","scratched":false},{"post":4,"horse":"No Ordinary Love","jockey":"Jaime Rodriguez","trainer":"Jorge R. Abreu","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Chaumet","jockey":"Edgard J. Zayas","trainer":"John P. Terranova II","owner":"","ml":"30/1","scratched":false},{"post":6,"horse":"Nobody Knows","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"10/1","scratched":false},{"post":7,"horse":"Probable Choice","jockey":"Javier Castellano","trainer":"Oscar S. Barrera III","owner":"","ml":"15/1","scratched":false},{"post":8,"horse":"Zap That Ghost","jockey":"Jose L. Ortiz","trainer":"Jorge R. Abreu","owner":"","ml":"10/1","scratched":false},{"post":9,"horse":"Tank Girl","jockey":"Cesar Gonzalez","trainer":"Richard Metivier","owner":"","ml":"30/1","scratched":false},{"post":10,"horse":"Force of Mischief","jockey":"Dylan Davis","trainer":"David G. Donk","owner":"","ml":"15/1","scratched":false},{"post":11,"horse":"Silly Season","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"2/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-05-R1-import","track":"Saratoga","date":"2026-07-05","raceNumber":1,"surface":"Hurdle","distanceF":19.0,"condition":"unknown","raceType":"Hurdle Stakes","purse":"","entries":[{"post":1,"horse":"Merry Maker (IRE)","jockey":"Freddie Procter","trainer":"Archibald J. Kingsley Jr.","owner":"","ml":"5/2","scratched":false},{"post":3,"horse":"St James the Great","jockey":"Stephen Mulqueen","trainer":"Keri Brion","owner":"","ml":"15/1","scratched":false},{"post":4,"horse":"Take Your Seats (IRE)","jockey":"Evan Dwan","trainer":"Thomas Garner","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Sweet Will (IRE)","jockey":"Dan Nevin","trainer":"Archibald J. Kingsley Jr.","owner":"","ml":"12/1","scratched":false},{"post":6,"horse":"McTigue (IRE)","jockey":"Graham Watters","trainer":"Cyril Murphy","owner":"","ml":"9/2","scratched":false},{"post":7,"horse":"Fil Dor (FR)","jockey":"Jake Coen","trainer":"Richard J. Hendriks","owner":"","ml":"7/2","scratched":false},{"post":8,"horse":"Rocket One","jockey":"Jamie Bargary","trainer":"Jack Fisher","owner":"","ml":"3/1","scratched":false}],"results":["McTigue (IRE)","Rocket One","St James the Great","Take Your Seats (IRE)","Sweet Will (IRE)","Fil Dor (FR)","Merry Maker (IRE)"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R2-import","track":"Saratoga","date":"2026-07-05","raceNumber":2,"surface":"Dirt","distanceF":6.0,"condition":"unknown","raceType":"Maiden Special Weight","purse":"$100,000","entries":[{"post":1,"horse":"Recurring Revenue","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Isthereanormalwife","jockey":"John R. Velazquez","trainer":"David G. Donk","owner":"","ml":"6/1","scratched":false},{"post":3,"horse":"Happy Go More","jockey":"Javier Castellano","trainer":"Jena M. Antonucci","owner":"","ml":"3/1","scratched":false},{"post":4,"horse":"Onebigbeautfulbill","jockey":"Flavien Prat","trainer":"Brad H. Cox","owner":"","ml":"5/2","scratched":false},{"post":5,"horse":"Bye for Now","jockey":"Dylan Davis","trainer":"Raymond Handal","owner":"","ml":"7/2","scratched":false},{"post":6,"horse":"Music in Motion","jockey":"Jose L. Ortiz","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false}],"results":["Onebigbeautfulbill","Isthereanormalwife","Music in Motion","Happy Go More","Bye for Now","Recurring Revenue"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R3-import","track":"Saratoga","date":"2026-07-05","raceNumber":3,"surface":"Dirt","distanceF":8.0,"condition":"unknown","raceType":"Claiming $20k","purse":"$52,000","entries":[{"post":1,"horse":"Pistol Liz Ablazen","jockey":"Ruben Silvera","trainer":"Gustavo Rodriguez","owner":"","ml":"9/2","scratched":false},{"post":2,"horse":"Pens Street","jockey":"Ricardo Santana Jr.","trainer":"Linda Rice","owner":"","ml":"3/1","scratched":false},{"post":3,"horse":"Kyle's Mom","jockey":"Jose Lezcano","trainer":"Jeremiah C. Englehart","owner":"","ml":"9/2","scratched":false},{"post":4,"horse":"Always Angels","jockey":"Jaime Rodriguez","trainer":"Rob Atras","owner":"","ml":"2/1","scratched":false},{"post":5,"horse":"Shezanarcticqueen","jockey":"Reylu Gutierrez","trainer":"Eduardo E. Jones","owner":"","ml":"30/1","scratched":false},{"post":6,"horse":"Princess Becca","jockey":"Jose L. Ortiz","trainer":"Orlando Noda","owner":"","ml":"4/1","scratched":false}],"results":["Princess Becca","Pens Street","Kyle's Mom","Shezanarcticqueen","Always Angels","Pistol Liz Ablazen"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R4-import","track":"Saratoga","date":"2026-07-05","raceNumber":4,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"Maiden Special Weight","purse":"$115,000","entries":[{"post":1,"horse":"Spherical","jockey":"Dylan Davis","trainer":"Chad Summers","owner":"","ml":"8/1","scratched":false},{"post":2,"horse":"Sidearm","jockey":"Manuel Franco","trainer":"Edward R. Barker","owner":"","ml":"5/1","scratched":false},{"post":3,"horse":"Commitment Fund","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"5/2","scratched":false},{"post":5,"horse":"Neigh Baby","jockey":"Jaime Rodriguez","trainer":"Jeremiah C. Englehart","owner":"","ml":"12/1","scratched":false},{"post":6,"horse":"Party Animal","jockey":"Edgard J. Zayas","trainer":"Jena M. Antonucci","owner":"","ml":"7/2","scratched":false},{"post":7,"horse":"Holy Seven","jockey":"Jose L. Ortiz","trainer":"Steven M. Asmussen","owner":"","ml":"2/1","scratched":false}],"results":["Neigh Baby","Commitment Fund","Spherical","Party Animal","Sidearm","Holy Seven"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R5-import","track":"Saratoga","date":"2026-07-05","raceNumber":5,"surface":"Turf","distanceF":8.5,"condition":"unknown","raceType":"Maiden Claiming $55k","purse":"$62,000","entries":[{"post":2,"horse":"Dynadee","jockey":"Jose Lezcano","trainer":"Michael Dini","owner":"","ml":"5/1","scratched":false},{"post":3,"horse":"Dixie Hex","jockey":"Dylan Davis","trainer":"Raymond Handal","owner":"","ml":"20/1","scratched":false},{"post":4,"horse":"Harrier","jockey":"Taylor Kingsley","trainer":"Archibald J. Kingsley Jr.","owner":"","ml":"10/1","scratched":false},{"post":5,"horse":"Languid","jockey":"John R. Velazquez","trainer":"Richard E. Dutrow Jr.","owner":"","ml":"8/1","scratched":false},{"post":6,"horse":"Crowned Moment (GB)","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"6/1","scratched":false},{"post":7,"horse":"Inherent Promise","jockey":"Tyler Gaffalione","trainer":"Lisa L. Lewis","owner":"","ml":"7/2","scratched":false},{"post":8,"horse":"Capricious Outcome","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"8/5","scratched":false},{"post":9,"horse":"No Filter","jockey":"Ruben Silvera","trainer":"Chris J. Englehart","owner":"","ml":"20/1","scratched":false}],"results":["Capricious Outcome","Languid","Dynadee","Dixie Hex","Crowned Moment (GB)","Harrier","No Filter","Inherent Promise"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R6-import","track":"Saratoga","date":"2026-07-05","raceNumber":6,"surface":"Inner turf","distanceF":8.0,"condition":"unknown","raceType":"Kelso S.","purse":"$225,000","entries":[{"post":1,"horse":"Zulu Kingdom (IRE)","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"5/2","scratched":false},{"post":8,"horse":"Mi Bago","jockey":"Jose L. Ortiz","trainer":"Mark E. Casse","owner":"","ml":"12/1","scratched":false},{"post":5,"horse":"Pass the Hat","jockey":"John R. Velazquez","trainer":"William I. Mott","owner":"","ml":"6/1","scratched":false},{"post":11,"horse":"Capitol Hill","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"10/1","scratched":false},{"post":10,"horse":"Tiz Dashing","jockey":"Javier Castellano","trainer":"Barclay Tagg","owner":"","ml":"10/1","scratched":false},{"post":7,"horse":"Itsallcomintogetha","jockey":"Jaime Rodriguez","trainer":"Lisa Bartkowski","owner":"","ml":"30/1","scratched":false},{"post":3,"horse":"My Boy Prince","jockey":"Dylan Davis","trainer":"Mark E. Casse","owner":"","ml":"9/2","scratched":false},{"post":6,"horse":"Cruise the Nile","jockey":"Jorge Ruiz","trainer":"H. Graham Motion","owner":"","ml":"8/1","scratched":false},{"post":9,"horse":"Cosmic Year (GB)","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"6/1","scratched":false},{"post":4,"horse":"Neat","jockey":"Reylu Gutierrez","trainer":"Rob Atras","owner":"","ml":"15/1","scratched":false}],"results":["Mi Bago","Zulu Kingdom (IRE)","Pass the Hat","Capitol Hill","Tiz Dashing","Itsallcomintogetha","My Boy Prince","Cruise the Nile","Cosmic Year (GB)","Neat"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R7-import","track":"Saratoga","date":"2026-07-05","raceNumber":7,"surface":"Dirt","distanceF":6.0,"condition":"unknown","raceType":"Maiden Special Weight","purse":"$100,000","entries":[{"post":1,"horse":"Midnight Honor","jockey":"Reylu Gutierrez","trainer":"Barclay Tagg","owner":"","ml":"5/1","scratched":false},{"post":2,"horse":"Luckbeourlady","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"4/1","scratched":false},{"post":3,"horse":"Liberty's Secret","jockey":"Dylan Davis","trainer":"Patrick J. Quick","owner":"","ml":"5/1","scratched":false},{"post":4,"horse":"Lively Pal","jockey":"Jose Lezcano","trainer":"Chris J. Englehart","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Carmen Amalia","jockey":"John R. Velazquez","trainer":"David G. Donk","owner":"","ml":"15/1","scratched":false},{"post":6,"horse":"Garden of Grace","jockey":"Javier Castellano","trainer":"Wayne Potts","owner":"","ml":"6/1","scratched":false},{"post":7,"horse":"Run On States","jockey":"Tyler Gaffalione","trainer":"Robert Medina","owner":"","ml":"8/1","scratched":false},{"post":8,"horse":"Liberty's Advance","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"5/2","scratched":false},{"post":9,"horse":"Run Flat","jockey":"Favinho Villa Pino","trainer":"Chandradat Goberdhan","owner":"","ml":"30/1","scratched":false}],"results":["Liberty's Secret","Carmen Amalia","Liberty's Advance","Garden of Grace","Luckbeourlady","Midnight Honor","Lively Pal","Run Flat","Run On States"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R8-import","track":"Saratoga","date":"2026-07-05","raceNumber":8,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Harvey Pack S.","purse":"$200,000","entries":[{"post":1,"horse":"Bring Theband Home","jockey":"Javier Castellano","trainer":"Mark E. Casse","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Boss Sully","jockey":"Joel Rosario","trainer":"Brian J. Koriner","owner":"","ml":"5/1","scratched":false},{"post":3,"horse":"Possiblemente","jockey":"Jose L. Ortiz","trainer":"Joe Sharp","owner":"","ml":"4/1","scratched":false},{"post":4,"horse":"Twenty Six Black","jockey":"Manuel Franco","trainer":"Horacio De Paz","owner":"","ml":"3/1","scratched":false},{"post":6,"horse":"Coppola","jockey":"Edgard J. Zayas","trainer":"Tareq Moubarak","owner":"","ml":"30/1","scratched":false},{"post":7,"horse":"Chasing Liberty","jockey":"Dylan Davis","trainer":"Rob Atras","owner":"","ml":"8/1","scratched":false},{"post":9,"horse":"Full Disclosure","jockey":"Tyler Gaffalione","trainer":"Amzadali Jehaludi","owner":"","ml":"15/1","scratched":false},{"post":10,"horse":"We're in Trouble","jockey":"Flavien Prat","trainer":"Michael W. McCarthy","owner":"","ml":"12/1","scratched":false}],"results":["Twenty Six Black","Possiblemente","Coppola","Chasing Liberty","We're in Trouble","Bring Theband Home","Full Disclosure","Boss Sully"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-05-R9-import","track":"Saratoga","date":"2026-07-05","raceNumber":9,"surface":"Inner turf","distanceF":12.0,"condition":"unknown","raceType":"Allowance Opt. Claiming $55k","purse":"$120,000","entries":[{"post":1,"horse":"Miztertonic","jockey":"Javier Castellano","trainer":"Keri Brion","owner":"","ml":"4/1","scratched":false},{"post":2,"horse":"Complex Agenda","jockey":"Ricardo Santana Jr.","trainer":"Thomas Morley","owner":"","ml":"12/1","scratched":false},{"post":3,"horse":"Bettrluckythangood","jockey":"Flavien Prat","trainer":"Miguel Clement","owner":"","ml":"6/1","scratched":false},{"post":4,"horse":"Fort Thomas","jockey":"Jose L. Ortiz","trainer":"George R. Arnold II","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Alakan","jockey":"Jorge Ruiz","trainer":"H. Graham Motion","owner":"","ml":"10/1","scratched":false},{"post":6,"horse":"Blue Pill","jockey":"Favinho Villa Pino","trainer":"James W. Ferraro","owner":"","ml":"50/1","scratched":false},{"post":8,"horse":"Offlee Naughty","jockey":"Manuel Franco","trainer":"Joe Sharp","owner":"","ml":"10/1","scratched":false},{"post":9,"horse":"Versailles Road","jockey":"Tyler Gaffalione","trainer":"Todd A. Pletcher","owner":"","ml":"10/1","scratched":false},{"post":10,"horse":"Noble Dynasty","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"5/2","scratched":false},{"post":12,"horse":"Noble Factor","jockey":"Joel Rosario","trainer":"Keri Brion","owner":"","ml":"15/1","scratched":false},{"post":13,"horse":"Write Off Jerry","jockey":"John R. Velazquez","trainer":"Michael J. Maker","owner":"","ml":"8/1","scratched":false}],"results":["Bettrluckythangood","Noble Factor","Versailles Road","Complex Agenda","Noble Dynasty","Alakan","Offlee Naughty","Write Off Jerry","Fort Thomas","Miztertonic","Blue Pill"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-09-R1-import","track":"Saratoga","date":"2026-07-09","raceNumber":1,"surface":"Dirt","distanceF":8.0,"condition":"unknown","raceType":"Claiming $40k","purse":"","entries":[{"post":3,"horse":"Tough Street","jockey":"Manuel Franco","trainer":"Rob Atras","owner":"","ml":"5/2","scratched":false},{"post":4,"horse":"Malu","jockey":"Ricardo Santana Jr.","trainer":"Gustavo Rodriguez","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Street View","jockey":"Tyler Gaffalione","trainer":"Saffie A. Joseph Jr.","owner":"","ml":"4/1","scratched":false},{"post":6,"horse":"Bow Draw","jockey":"Jose L. Ortiz","trainer":"Steven M. Asmussen","owner":"","ml":"9/2","scratched":false}],"results":["Bow Draw","Tough Street","Malu","Street View"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-09-R2-import","track":"Saratoga","date":"2026-07-09","raceNumber":2,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Maiden Special Weight","purse":"","entries":[{"post":1,"horse":"Magical Mikel","jockey":"Christopher Elliott","trainer":"Kenneth G. McPeek","owner":"","ml":"15/1","scratched":false},{"post":2,"horse":"Excessif","jockey":"Manuel Franco","trainer":"H. Graham Motion","owner":"","ml":"8/1","scratched":false},{"post":3,"horse":"Just a Holiday","jockey":"Dylan Davis","trainer":"Wesley A. Ward","owner":"","ml":"9/2","scratched":false},{"post":4,"horse":"Captain G","jockey":"Javier Castellano","trainer":"Mark E. Casse","owner":"","ml":"12/1","scratched":false},{"post":5,"horse":"Beach Sandals","jockey":"Jose L. Ortiz","trainer":"Mark E. Casse","owner":"","ml":"7/2","scratched":false},{"post":6,"horse":"Generational","jockey":"Flavien Prat","trainer":"Steven M. Asmussen","owner":"","ml":"5/2","scratched":false},{"post":7,"horse":"Call Attendant","jockey":"Ricardo Santana Jr.","trainer":"Thomas Morley","owner":"","ml":"6/1","scratched":false},{"post":8,"horse":"Pirate Ship","jockey":"Tyler Gaffalione","trainer":"Joe Sharp","owner":"","ml":"4/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R3-import","track":"Saratoga","date":"2026-07-09","raceNumber":3,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"Maiden Special Weight","purse":"","entries":[{"post":1,"horse":"Collective Bargain","jockey":"Edgard J. Zayas","trainer":"Chad Summers","owner":"","ml":"15/1","scratched":false},{"post":2,"horse":"Ames","jockey":"Tyler Gaffalione","trainer":"Chad Summers","owner":"","ml":"20/1","scratched":false},{"post":3,"horse":"Rose to Riches","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"8/1","scratched":false},{"post":4,"horse":"Fletch's Rockette","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"9/2","scratched":false},{"post":5,"horse":"Cold Spell","jockey":"John R. Velazquez","trainer":"Wesley A. Ward","owner":"","ml":"2/5","scratched":false},{"post":6,"horse":"Giant Sense","jockey":"Jaime Rodriguez","trainer":"Dimitrios K. Synnefias","owner":"","ml":"20/1","scratched":false},{"post":7,"horse":"Lil Tipsy","jockey":"Manuel Franco","trainer":"Linda Rice","owner":"","ml":"8/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R4-import","track":"Saratoga","date":"2026-07-09","raceNumber":4,"surface":"Dirt","distanceF":8.0,"condition":"unknown","raceType":"Claiming $20k","purse":"","entries":[{"post":1,"horse":"Miss American Pie","jockey":"Tyler Gaffalione","trainer":"Domenick L. Schettino","owner":"","ml":"6/1","scratched":false},{"post":2,"horse":"Twirly","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"7/2","scratched":false},{"post":3,"horse":"Amelia's Echo","jockey":"Manuel Franco","trainer":"Ilkay Kantarmaci","owner":"","ml":"7/2","scratched":false},{"post":4,"horse":"Margarita Molly","jockey":"Flavien Prat","trainer":"Keri Brion","owner":"","ml":"3/1","scratched":false},{"post":5,"horse":"Karey","jockey":"Christopher Elliott","trainer":"Ilkay Kantarmaci","owner":"","ml":"5/1","scratched":false},{"post":6,"horse":"Defining Role","jockey":"Ricardo Santana Jr.","trainer":"Anthony W. Dutrow","owner":"","ml":"5/1","scratched":false},{"post":7,"horse":"Heavens Lee","jockey":"Ruben Silvera","trainer":"Bruce N. Levine","owner":"","ml":"8/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R5-import","track":"Saratoga","date":"2026-07-09","raceNumber":5,"surface":"Dirt","distanceF":8.0,"condition":"unknown","raceType":"Allowance Opt. Claiming $55k","purse":"","entries":[{"post":1,"horse":"Madam Opus","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"7/2","scratched":false},{"post":2,"horse":"Brunch With Amy","jockey":"Flavien Prat","trainer":"Linda Rice","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Soaring High","jockey":"Jose L. Ortiz","trainer":"Cherie DeVaux","owner":"","ml":"1/1","scratched":false},{"post":4,"horse":"Will Not Be Swayed","jockey":"Ricardo Santana Jr.","trainer":"Lolita Shivmangal","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Hidden Rose","jockey":"Tyler Gaffalione","trainer":"Miguel Clement","owner":"","ml":"8/1","scratched":false},{"post":6,"horse":"I'm a Cutie Pie","jockey":"Jaime Rodriguez","trainer":"Michael E. Gorham","owner":"","ml":"15/1","scratched":false},{"post":7,"horse":"Fast and Frisky","jockey":"Ruben Silvera","trainer":"Gregory E. Charlerie","owner":"","ml":"10/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R6-import","track":"Saratoga","date":"2026-07-09","raceNumber":6,"surface":"Inner turf","distanceF":8.0,"condition":"unknown","raceType":"Allowance Opt. Claiming $80k","purse":"","entries":[{"post":1,"horse":"Queen of Hawaii (IRE)","jockey":"Jose L. Ortiz","trainer":"Philip Antonacci","owner":"","ml":"9/2","scratched":false},{"post":2,"horse":"Play With Fire","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"3/1","scratched":false},{"post":3,"horse":"Scythian","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"10/1","scratched":false},{"post":4,"horse":"Strutsherstuff","jockey":"Jaime Rodriguez","trainer":"Madison F. Meyers","owner":"","ml":"10/1","scratched":false},{"post":5,"horse":"Brisbane (FR)","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"5/1","scratched":false},{"post":6,"horse":"Pop Art","jockey":"Jose Lezcano","trainer":"Thomas F. Proctor","owner":"","ml":"15/1","scratched":false},{"post":7,"horse":"Opulent Restraint (IRE)","jockey":"John R. Velazquez","trainer":"William I. Mott","owner":"","ml":"7/2","scratched":false},{"post":8,"horse":"Being Myself","jockey":"Dylan Davis","trainer":"Cherie DeVaux","owner":"","ml":"15/1","scratched":false},{"post":9,"horse":"Ashikidah (FR)","jockey":"Tyler Gaffalione","trainer":"Philip Antonacci","owner":"","ml":"6/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R7-import","track":"Saratoga","date":"2026-07-09","raceNumber":7,"surface":"Dirt","distanceF":6.0,"condition":"unknown","raceType":"Claiming $20k","purse":"","entries":[{"post":1,"horse":"Screaming Uncle","jockey":"Reylu Gutierrez","trainer":"Gregory E. Charlerie","owner":"","ml":"15/1","scratched":false},{"post":2,"horse":"Gatsby","jockey":"Manuel Franco","trainer":"Ilkay Kantarmaci","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Factually Correct","jockey":"Ruben Silvera","trainer":"Fernando Abreu","owner":"","ml":"6/1","scratched":false},{"post":4,"horse":"War Master","jockey":"Flavien Prat","trainer":"Michael E. Gorham","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Burninhunkoflove","jockey":"Jose L. Ortiz","trainer":"Wayne Potts","owner":"","ml":"8/1","scratched":false},{"post":6,"horse":"Big Hat Willie","jockey":"Jaime Rodriguez","trainer":"Rob Atras","owner":"","ml":"8/1","scratched":false},{"post":7,"horse":"Stewie","jockey":"Dylan Davis","trainer":"Mitchell E. Friedman","owner":"","ml":"12/1","scratched":false},{"post":8,"horse":"Timaeus","jockey":"Silvestre Gonzalez","trainer":"Ilkay Kantarmaci","owner":"","ml":"12/1","scratched":false},{"post":9,"horse":"Red State","jockey":"Ricardo Santana Jr.","trainer":"Michael J. Maker","owner":"","ml":"7/5","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R8-import","track":"Saratoga","date":"2026-07-09","raceNumber":8,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Starter Opt. Claiming $45k","purse":"","entries":[{"post":1,"horse":"Ambassador Blue","jockey":"Joel Rosario","trainer":"Danny Gargan","owner":"","ml":"10/1","scratched":false},{"post":2,"horse":"Bridle a Butterfly","jockey":"Flavien Prat","trainer":"Amelia J. Green","owner":"","ml":"9/2","scratched":false},{"post":3,"horse":"Russi","jockey":"Edgard J. Zayas","trainer":"H. James Bond","owner":"","ml":"6/1","scratched":false},{"post":4,"horse":"Roar of the Crowd","jockey":"Reylu Gutierrez","trainer":"Gregory DiPrima","owner":"","ml":"30/1","scratched":false},{"post":5,"horse":"Kid Billy","jockey":"Ruben Silvera","trainer":"Rudy R. Rodriguez","owner":"","ml":"15/1","scratched":false},{"post":6,"horse":"Launch Control","jockey":"Ricardo Santana Jr.","trainer":"Keri Brion","owner":"","ml":"10/1","scratched":false},{"post":7,"horse":"Joker On Fire","jockey":"Jose Lezcano","trainer":"Bruce N. Levine","owner":"","ml":"4/1","scratched":false},{"post":8,"horse":"Counter Move","jockey":"Tyler Gaffalione","trainer":"George Weaver","owner":"","ml":"7/2","scratched":false},{"post":9,"horse":"Peyton","jockey":"Manuel Franco","trainer":"Domenick L. Schettino","owner":"","ml":"15/1","scratched":false},{"post":10,"horse":"Global Prosperity","jockey":"Javier Castellano","trainer":"Lisa L. Lewis","owner":"","ml":"10/1","scratched":false},{"post":11,"horse":"After Taxes (IRE)","jockey":"Dylan Davis","trainer":"Bruce R. Brown","owner":"","ml":"8/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-09-R9-import","track":"Saratoga","date":"2026-07-09","raceNumber":9,"surface":"Inner turf","distanceF":8.5,"condition":"unknown","raceType":"Maiden Special Weight","purse":"","entries":[{"post":1,"horse":"Pay the Piper","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"8/1","scratched":false},{"post":2,"horse":"Iron Palace","jockey":"Edgard J. Zayas","trainer":"George Weaver","owner":"","ml":"12/1","scratched":false},{"post":3,"horse":"Luz de Guia","jockey":"Ruben Silvera","trainer":"Nicholas P. Zito","owner":"","ml":"30/1","scratched":false},{"post":4,"horse":"Democracy Defender","jockey":"Jose L. Ortiz","trainer":"Jorge R. Abreu","owner":"","ml":"8/1","scratched":false},{"post":5,"horse":"Coordinator","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"2/1","scratched":false},{"post":6,"horse":"Point Guard","jockey":"Ricardo Santana Jr.","trainer":"Philip Antonacci","owner":"","ml":"15/1","scratched":false},{"post":7,"horse":"Bull Shoals","jockey":"Jose E. Morelos","trainer":"Jena M. Antonucci","owner":"","ml":"10/1","scratched":false},{"post":8,"horse":"Feline Curious","jockey":"John R. Velazquez","trainer":"Kelsey Danner","owner":"","ml":"12/1","scratched":false},{"post":9,"horse":"Okefenokee","jockey":"Dylan Davis","trainer":"Thomas Morley","owner":"","ml":"8/1","scratched":false},{"post":10,"horse":"C J Star","jockey":"Javier Castellano","trainer":"Mark E. Casse","owner":"","ml":"9/2","scratched":false},{"post":11,"horse":"Ollie Luke Out","jockey":"Tyler Gaffalione","trainer":"Richard E. Dutrow Jr.","owner":"","ml":"10/1","scratched":false}],"results":null},{"id":"Saratoga-2026-07-10-R1-import","track":"Saratoga","date":"2026-07-10","raceNumber":1,"surface":"Dirt","distanceF":9,"condition":"unknown","raceType":"Maiden Special Weight","purse":"$115,000","entries":[{"post":2,"horse":"Asked and Answered","jockey":"Jaime Rodriguez","trainer":"Antonio Arriaga","owner":"","ml":"8/1","scratched":false,"figs":[120]},{"post":3,"horse":"Pauillac","jockey":"Manuel Franco","trainer":"Chad C. Brown","owner":"","ml":"8/1","scratched":false,"figs":[94]},{"post":4,"horse":"Commerce","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"7/2","scratched":false,"figs":[95]},{"post":5,"horse":"Presidential Power","jockey":"Jose L. Ortiz","trainer":"Todd A. Pletcher","owner":"","ml":"5/1","scratched":false,"figs":[93]},{"post":6,"horse":"Sorrentino","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"8/1","scratched":false,"figs":[91]}],"results":["Commerce","Presidential Power","Pauillac","Asked and Answered","Sorrentino"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R2-import","track":"Saratoga","date":"2026-07-10","raceNumber":2,"surface":"Inner turf","distanceF":8,"condition":"unknown","raceType":"Maiden Special Weight","purse":"$115,000","entries":[{"post":1,"horse":"Pros and Cons","jockey":"Jose L. Ortiz","trainer":"Mark E. Casse","owner":"","ml":"2/1","scratched":false,"figs":[90]},{"post":2,"horse":"Golden Siren","jockey":"Flavien Prat","trainer":"Mark E. Casse","owner":"","ml":"6/1","scratched":false},{"post":3,"horse":"Fire Angel","jockey":"Manuel Franco","trainer":"George Weaver","owner":"","ml":"10/1","scratched":false},{"post":5,"horse":"Inside Edge","jockey":"Christopher Elliott","trainer":"Kenneth G. McPeek","owner":"","ml":"12/1","scratched":false},{"post":6,"horse":"So Angelina","jockey":"Joel Rosario","trainer":"Antonio Arriaga","owner":"","ml":"20/1","scratched":false,"figs":[56]},{"post":7,"horse":"Mary's Gunna Run","jockey":"Jaime Rodriguez","trainer":"H. Graham Motion","owner":"","ml":"8/5","scratched":false,"figs":[90]}],"results":["Pros and Cons","Golden Siren","Mary's Gunna Run","Inside Edge","So Angelina","Fire Angel"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R3-import","track":"Saratoga","date":"2026-07-10","raceNumber":3,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"Allowance Opt. Claiming $45k","purse":"$110,000","entries":[{"post":1,"horse":"New York Scrappy","jockey":"Silvestre Gonzalez","trainer":"Ilkay Kantarmaci","owner":"","ml":"6/1","scratched":false,"figs":[88]},{"post":2,"horse":"B Thedonald","jockey":"Manuel Franco","trainer":"Horacio De Paz","owner":"","ml":"8/5","scratched":false,"figs":[111]},{"post":3,"horse":"Runaway Joke","jockey":"Tyler Gaffalione","trainer":"Chad Summers","owner":"","ml":"12/1","scratched":false,"figs":[95]},{"post":4,"horse":"On the Hill","jockey":"Edgard J. Zayas","trainer":"H. James Bond","owner":"","ml":"9/2","scratched":false,"figs":[94]},{"post":5,"horse":"Kenny Be","jockey":"Ricardo Santana Jr.","trainer":"David P. Duggan","owner":"","ml":"5/2","scratched":false,"figs":[96]},{"post":6,"horse":"Share the Ludt","jockey":"Christopher Elliott","trainer":"Melanie Giddings","owner":"","ml":"10/1","scratched":false,"figs":[105]},{"post":7,"horse":"Trust Fund","jockey":"Dylan Davis","trainer":"Antonio Arriaga","owner":"","ml":"8/1","scratched":false,"figs":[91]}],"results":["New York Scrappy","Kenny Be","On the Hill","B Thedonald","Trust Fund","Runaway Joke","Share the Ludt"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R4-import","track":"Saratoga","date":"2026-07-10","raceNumber":4,"surface":"Turf","distanceF":8.5,"condition":"unknown","raceType":"Allowance Opt. Claiming $55k","purse":"$120,000","entries":[{"post":1,"horse":"Sardis","jockey":"Tyler Gaffalione","trainer":"Ilkay Kantarmaci","owner":"","ml":"12/1","scratched":false,"figs":[79]},{"post":2,"horse":"Thirteen Colonies","jockey":"Ricardo Santana Jr.","trainer":"Philip Antonacci","owner":"","ml":"6/1","scratched":false,"figs":[68]},{"post":3,"horse":"Chips and Fish","jockey":"Ruben Silvera","trainer":"Antonio Arriaga","owner":"","ml":"30/1","scratched":false,"figs":[87]},{"post":4,"horse":"Favorable Scenario","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"9/5","scratched":false,"figs":[105]},{"post":6,"horse":"Elnajd","jockey":"Manuel Franco","trainer":"Brad H. Cox","owner":"","ml":"5/2","scratched":false,"figs":[100]},{"post":7,"horse":"Golden Channel","jockey":"Jose L. Ortiz","trainer":"George Weaver","owner":"","ml":"7/2","scratched":false,"figs":[95]}],"results":["Elnajd","Favorable Scenario","Sardis","Golden Channel","Thirteen Colonies","Chips and Fish"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R5-import","track":"Saratoga","date":"2026-07-10","raceNumber":5,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"Allowance Opt. Claiming $80k","purse":"$125,000","entries":[{"post":1,"horse":"Tiger Twenty Four","jockey":"Junior Alvarado","trainer":"William I. Mott","owner":"","ml":"8/1","scratched":false,"figs":[108]},{"post":3,"horse":"Vibrant Express","jockey":"Flavien Prat","trainer":"George Weaver","owner":"","ml":"5/2","scratched":false,"figs":[83]},{"post":4,"horse":"Contrary Thinking","jockey":"Jaime Rodriguez","trainer":"Amelia J. Green","owner":"","ml":"2/1","scratched":false,"figs":[127]},{"post":5,"horse":"Whatchatalkinabout","jockey":"Jose L. Ortiz","trainer":"Wesley A. Ward","owner":"","ml":"7/2","scratched":false,"figs":[78]},{"post":6,"horse":"Commuted","jockey":"Ricardo Santana Jr.","trainer":"Linda Rice","owner":"","ml":"6/1","scratched":false,"figs":[93]},{"post":7,"horse":"Dapper Moon","jockey":"Brian Joseph Hernandez Jr.","trainer":"Dallas Stewart","owner":"","ml":"6/1","scratched":false,"figs":[103]}],"results":["Whatchatalkinabout","Contrary Thinking","Commuted","Tiger Twenty Four","Vibrant Express","Dapper Moon"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R6-import","track":"Saratoga","date":"2026-07-10","raceNumber":6,"surface":"Inner turf","distanceF":8.5,"condition":"unknown","raceType":"Maiden Claiming $100k","purse":"$75,000","entries":[{"post":1,"horse":"Gum","jockey":"Tyler Gaffalione","trainer":"H. Graham Motion","owner":"","ml":"6/1","scratched":false,"figs":[102]},{"post":2,"horse":"Resort (FR)","jockey":"John R. Velazquez","trainer":"Michael J. Trombetta","owner":"","ml":"8/1","scratched":false,"figs":[102]},{"post":3,"horse":"Felixyn","jockey":"Dylan Davis","trainer":"Thomas Morley","owner":"","ml":"9/2","scratched":false,"figs":[89]},{"post":4,"horse":"U Vicky","jockey":"Jose L. Ortiz","trainer":"Lindsay Schultz","owner":"","ml":"12/1","scratched":false,"figs":[98]},{"post":5,"horse":"Loveontheleftbank","jockey":"Manuel Franco","trainer":"Miguel Clement","owner":"","ml":"3/1","scratched":false,"figs":[88]},{"post":6,"horse":"Jordan's Love","jockey":"Junior Alvarado","trainer":"Thomas Morley","owner":"","ml":"8/1","scratched":false,"figs":[89]},{"post":7,"horse":"Epic Selloff","jockey":"Flavien Prat","trainer":"Chad C. Brown","owner":"","ml":"7/2","scratched":false,"figs":[91]},{"post":8,"horse":"Private Property (IRE)","jockey":"Ruben Silvera","trainer":"Michelle Nevin","owner":"","ml":"9/2","scratched":false,"figs":[103]}],"results":["Jordan's Love","Felixyn","Gum","U Vicky","Resort (FR)","Loveontheleftbank","Epic Selloff","Private Property (IRE)"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R7-import","track":"Saratoga","date":"2026-07-10","raceNumber":7,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Allowance Opt. Claiming $80k","purse":"$125,000","entries":[{"post":1,"horse":"Capturing","jockey":"Jose L. Ortiz","trainer":"Todd A. Pletcher","owner":"","ml":"6/1","scratched":false,"figs":[102]},{"post":2,"horse":"Shades of Jade","jockey":"Ricardo Santana Jr.","trainer":"Philip Antonacci","owner":"","ml":"5/1","scratched":false,"figs":[90]},{"post":3,"horse":"Sadie Earp","jockey":"Edgard J. Zayas","trainer":"Wesley A. Ward","owner":"","ml":"2/1","scratched":false,"figs":[114]},{"post":4,"horse":"Something Stronger","jockey":"Flavien Prat","trainer":"Albert M. Stall Jr.","owner":"","ml":"6/1","scratched":false,"figs":[105]},{"post":5,"horse":"Vekomancer","jockey":"Jose Lezcano","trainer":"Linda Rice","owner":"","ml":"15/1","scratched":false,"figs":[100]},{"post":6,"horse":"Quiet Confidence","jockey":"Christopher Elliott","trainer":"James T. Ryerson","owner":"","ml":"4/1","scratched":false,"figs":[98]},{"post":8,"horse":"Abientot","jockey":"Dylan Davis","trainer":"Mark E. Casse","owner":"","ml":"9/2","scratched":false,"figs":[71]}],"results":["Capturing","Quiet Confidence","Abientot","Shades of Jade","Something Stronger","Sadie Earp","Vekomancer"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R8-import","track":"Saratoga","date":"2026-07-10","raceNumber":8,"surface":"Dirt","distanceF":7,"condition":"unknown","raceType":"Starter Opt. Claiming $12.5k","purse":"$37,000","entries":[{"post":1,"horse":"Ah Ca Ira","jockey":"Christopher Elliott","trainer":"Linda K. Dixon","owner":"","ml":"6/1","scratched":false,"figs":[100]},{"post":2,"horse":"Baby Sassicaia","jockey":"Heman K. Harkie","trainer":"Norman C. Follett","owner":"","ml":"5/1","scratched":false,"figs":[83]},{"post":4,"horse":"Miss Lao","jockey":"Silvestre Gonzalez","trainer":"Mertkan Kantarmaci","owner":"","ml":"8/1","scratched":false,"figs":[89]},{"post":5,"horse":"Jackie the Joker","jockey":"Jose Lezcano","trainer":"James W. Ferraro","owner":"","ml":"8/5","scratched":false,"figs":[100]},{"post":6,"horse":"Play Good Pay Good","jockey":"Ricardo Santana Jr.","trainer":"Chris J. Englehart","owner":"","ml":"4/1","scratched":false,"figs":[104]},{"post":7,"horse":"Dream On Cara","jockey":"Jose Baez","trainer":"Dana Saul","owner":"","ml":"12/1","scratched":false,"figs":[86]},{"post":8,"horse":"Curlin's Magic","jockey":"Dalila A. Rivera","trainer":"Marcelo Arenas","owner":"","ml":"10/1","scratched":false,"figs":[88]},{"post":9,"horse":"Whistler's Style","jockey":"Dylan Davis","trainer":"Emron Ibrahim","owner":"","ml":"12/1","scratched":false,"figs":[85]}],"results":["Baby Sassicaia","Ah Ca Ira","Curlin's Magic","Whistler's Style","Miss Lao","Play Good Pay Good","Dream On Cara","Jackie the Joker"],"resultsMeta":{"partial":false,"source":"HRN chart (seeded)"}},{"id":"Saratoga-2026-07-10-R9-import","track":"Saratoga","date":"2026-07-10","raceNumber":9,"surface":"Dirt","distanceF":6.5,"condition":"unknown","raceType":"Victory Ride S. (G3)","purse":"$225,000","entries":[{"post":1,"horse":"Sippin Pretty","jockey":"Ricardo Santana Jr.","trainer":"Ian R. Wilkes","owner":"","ml":"20/1","scratched":false,"figs":[96]},{"post":2,"horse":"Iron Orchard","jockey":"Joel Rosario","trainer":"Steven M. Asmussen","owner":"","ml":"5/1","scratched":false,"figs":[42]},{"post":3,"horse":"Carmel Coast","jockey":"Tyler Gaffalione","trainer":"D. Whitworth Beckman","owner":"","ml":"8/1","scratched":false,"figs":[111]},{"post":4,"horse":"Sneaky Good","jockey":"Jose L. Ortiz","trainer":"Brad H. Cox","owner":"","ml":"8/1","scratched":false,"figs":[99]},{"post":5,"horse":"Tommy Jo","jockey":"John R. Velazquez","trainer":"Todd A. Pletcher","owner":"","ml":"7/2","scratched":false,"figs":[97]},{"post":6,"horse":"Peach Tie","jockey":"Manuel Franco","trainer":"Brittany T. Russell","owner":"","ml":"12/1","scratched":false,"figs":[105]},{"post":7,"horse":"Mythical","jockey":"Edgard J. Zayas","trainer":"Jorge Delgado","owner":"","ml":"9/2","scratched":false,"figs":[110]},{"post":8,"horse":"Tessellate","jockey":"Dylan Davis","trainer":"Saffie A. Joseph Jr.","owner":"","ml":"20/1","scratched":false,"figs":[101]},{"post":9,"horse":"A Fine Chardonnay","jockey":"Brian Joseph Hernandez Jr.","trainer":"Ian R. Wilkes","owner":"","ml":"12/1","scratched":false,"figs":[102]},{"post":10,"horse":"Goodall","jockey":"Flavien Prat","trainer":"Steven M. Asmussen","owner":"","ml":"3/1","scratched":false,"figs":[115]}],"results":null},{"id":"Saratoga-2026-07-10-R10-import","track":"Saratoga","date":"2026-07-10","raceNumber":10,"surface":"Turf","distanceF":5.5,"condition":"unknown","raceType":"Maiden Claiming $55k","purse":"$62,000","entries":[{"post":1,"horse":"Two Ducks","jockey":"Tyler Gaffalione","trainer":"Carlos F. Martin","owner":"","ml":"5/2","scratched":false,"figs":[79]},{"post":2,"horse":"Funky See Funky Do","jockey":"Edgard J. Zayas","trainer":"Chad Summers","owner":"","ml":"8/1","scratched":false,"figs":[73]},{"post":3,"horse":"Yahearmenow","jockey":"Cesar Gonzalez","trainer":"James Hooper","owner":"","ml":"20/1","scratched":false},{"post":4,"horse":"Ink Lies","jockey":"Jose L. Ortiz","trainer":"Wesley A. Ward","owner":"","ml":"8/5","scratched":false,"figs":[62]},{"post":5,"horse":"Twenty Two Black","jockey":"Christopher Elliott","trainer":"Kenneth G. McPeek","owner":"","ml":"5/1","scratched":false,"figs":[93]},{"post":6,"horse":"Bourbon Hangover","jockey":"Heman K. Harkie","trainer":"Rachael Keithan","owner":"","ml":"20/1","scratched":false,"figs":[64]},{"post":7,"horse":"Relative Risk","jockey":"Jaime Rodriguez","trainer":"Lisa Bartkowski","owner":"","ml":"15/1","scratched":false},{"post":8,"horse":"Rare Eclipse","jockey":"Ricardo Santana Jr.","trainer":"Keri Brion","owner":"","ml":"10/1","scratched":false,"figs":[73]},{"post":9,"horse":"Nod to Tran","jockey":"Reylu Gutierrez","trainer":"Gregory DiPrima","owner":"","ml":"10/1","scratched":false,"figs":[72]}],"results":null}];

/* ================= ODDS & MATH ================= */
function parseOdds(s) {
  if (!s) return null;
  const t = String(s).trim().toUpperCase().replace(/\s/g, "");
  if (t === "EVEN" || t === "EVS" || t === "EV") return 1;
  let m = t.match(/^(\d+(?:\.\d+)?)[/\-](\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]) / parseFloat(m[2]);
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]); // "5" -> 5/1
  return null;
}
const impliedProb = (frac) => (frac == null ? null : 1 / (frac + 1));
const fmtPct = (p) => (p * 100 >= 9.95 ? Math.round(p * 100) : (p * 100).toFixed(1)) + "%";
const probToOdds = (p) => {
  if (p <= 0) return "—";
  const f = (1 - p) / p;
  if (f < 1) return (Math.round(f * 20) / 20).toFixed(2) + "/1";
  if (f < 10) return (Math.round(f * 2) / 2).toFixed(1) + "/1";
  return Math.round(f) + "/1";
};
const distBucket = (f) => (f == null ? null : f < 8 ? "sprint" : "route");
const OFF_TRACKS = ["MUDDY", "SLOPPY", "YIELDING", "SOFT", "GOOD", "HEAVY", "WET"];

/* ================= MODEL ================= */
// Derive local (from stored results) stats for every entity + head-to-head pairs
// Class rating from race type + purse: graded > stakes > AOC/ALW > SOC > MSW > CLM > MCL,
// nudged by claiming price and purse. Used for class-movement scoring.
function classRating(raceType, purse) {
  const t = (raceType || "").toUpperCase();
  const p = parseInt(String(purse || "").replace(/[^0-9]/g, ""), 10) || 0;
  let base = null;
  if (/\bG1\b|GRADE I(?![IV])/.test(t)) base = 10;
  else if (/\bG2\b|GRADE II(?!I)/.test(t)) base = 9;
  else if (/\bG3\b|GRADE III/.test(t)) base = 8;
  else if (/STAKES|\bS\.|INVITATIONAL|HANDICAP|\bH\.|HURDLE/.test(t)) base = 7;
  else if (/AOC|ALLOWANCE OPT|OPTIONAL CLAIM/.test(t)) base = 6;
  else if (/ALLOWANCE|\bALW\b/.test(t)) base = 5.5;
  else if (/STARTER|\bSOC\b/.test(t)) base = 4.5;
  else if (/MAIDEN SPECIAL|\bMSW\b/.test(t)) base = 4;
  else if (/MAIDEN CLAIM|\bMCL\b|\bMC\s?\d/.test(t)) base = 2.5;
  else if (/CLAIM|\bCLM\b/.test(t)) base = 3;
  if (base == null && p) base = 3 + Math.min(4, Math.max(0, Math.log10(p / 10000)));
  if (base == null) return null;
  const cm = t.match(/\$?(\d+(?:\.\d+)?)\s*K/) || t.match(/\$(\d{1,3}),(\d{3})/);
  if (cm && /CLAIM|CLM|SOC|MCL|STARTER/.test(t)) {
    const kv = cm[2] ? parseInt(cm[1] + cm[2], 10) / 1000 : parseFloat(cm[1]);
    if (kv > 0) base += Math.max(-1, Math.min(1, Math.log10(kv / 25)));
  }
  if (p) base += Math.max(-0.5, Math.min(0.5, Math.log10(p / 80000) * 0.5));
  return base;
}

// Pace fit: value of a run style given the projected race shape. Roughly [-1, +1].
function paceFactor(style, fieldStyles) {
  const eC = fieldStyles.filter((x) => x === "E").length;
  const epC = fieldStyles.filter((x) => x === "EP").length;
  const early = eC + 0.5 * epC;
  if (style === "E") {
    if (eC === 1 && epC <= 1) return 1;      // lone speed — the strongest single angle
    if (eC >= 3) return -0.8;                 // speed duel
    if (eC === 2) return -0.35;
    return 0.3;
  }
  if (style === "EP") { if (eC === 0) return 0.6; if (eC >= 2) return -0.3; return 0.1; }
  if (style === "P") return early >= 3 ? 0.45 : 0;
  if (style === "S") return early >= 3.5 ? 0.7 : early >= 2.5 ? 0.3 : -0.25;
  return 0;
}

function deriveLocal(races) {
  const mk = () => ({ starts: 0, wins: 0, top3: 0 });
  const horses = {}, jockeys = {}, trainers = {}, owners = {}, h2h = {};
  for (const r of races) {
    if (!r.results || !r.results.length) continue;
    const posOf = {};
    r.results.forEach((name, i) => { posOf[name.toLowerCase()] = i + 1; });
    const rTurf = (r.surface || "").toLowerCase().includes("turf");
    const rBucket = distBucket(r.distanceF);
    const rOff = OFF_TRACKS.some((w) => (r.condition || "").toUpperCase().includes(w));
    for (const e of r.entries || []) {
      if (e.scratched) continue;
      const fin = posOf[(e.horse || "").toLowerCase()];
      if (!fin) continue;
      for (const [map, key] of [[horses, e.horse], [jockeys, e.jockey], [trainers, e.trainer], [owners, e.owner]]) {
        if (!key) continue;
        const k = key.trim();
        map[k] = map[k] || mk();
        map[k].starts++;
        if (fin === 1) map[k].wins++;
        if (fin <= 3) map[k].top3++;
      }
      const hk = (e.horse || "").trim();
      if (hk) {
        horses[hk].hist = horses[hk].hist || [];
        horses[hk].hist.push({ id: r.id, date: r.date, fin, turf: rTurf, bucket: rBucket, off: rOff, cls: classRating(r.raceType, r.purse) });
      }
    }
    // head-to-head among finishers in this race
    const finished = (r.entries || []).filter((e) => !e.scratched && posOf[(e.horse || "").toLowerCase()]);
    for (let i = 0; i < finished.length; i++) {
      for (let j = i + 1; j < finished.length; j++) {
        const a = finished[i].horse.trim(), b = finished[j].horse.trim();
        const [x, y] = [a, b].sort((s, t) => s.localeCompare(t));
        const key = x + "||" + y;
        h2h[key] = h2h[key] || { a: x, b: y, meetings: 0, aAhead: 0, bAhead: 0, races: [] };
        const rec = h2h[key];
        rec.meetings++;
        const pa = posOf[a.toLowerCase()], pb = posOf[b.toLowerCase()];
        const aWon = (x === a ? pa : pb) < (x === a ? pb : pa);
        if (aWon) rec.aAhead++; else rec.bAhead++;
        rec.races.push(`${r.track} R${r.raceNumber} ${r.date}`);
        (rec.byRace = rec.byRace || []).push({ id: r.id, ahead: aWon ? "a" : "b" });
      }
    }
  }
  return { horses, jockeys, trainers, owners, h2h };
}

// Effective win% blending AI-enriched baseline with locally recorded results
function effWinPct(aiStats, local, fallback) {
  const aW = aiStats?.wins ?? (aiStats?.winPct != null && aiStats?.starts ? (aiStats.winPct / 100) * aiStats.starts : null);
  const aS = aiStats?.starts ?? null;
  const lW = local?.wins || 0, lS = local?.starts || 0;
  if (aS != null && aW != null) return (aW + lW + fallback * 5) / (aS + lS + 5);
  if (aiStats?.winPct != null) return (aiStats.winPct / 100 * 20 + lW + fallback * 5) / (25 + lS);
  if (lS > 0) return (lW + fallback * 5) / (lS + 5);
  return fallback;
}

function computeRows(race, entities, local, marketW, excludeId) {
  const live = (race.entries || []).filter((e) => !e.scratched);
  if (live.length < 2) return null;
  const isTurf = (race.surface || "").toLowerCase().includes("turf");
  const bucket = distBucket(race.distanceF);
  const off = OFF_TRACKS.some((w) => (race.condition || "").toUpperCase().includes(w));

  // ---- Tier 1 field context: figures, run styles, class level ----
  const figsOf = (e) => {
    const raw = e.figs ?? entities.horses?.[e.horse]?.ai?.recentFigs;
    if (!Array.isArray(raw)) return null;
    const nums = raw.map(Number).filter((x) => x > 0 && x < 130).slice(0, 3);
    return nums.length ? nums : null;
  };
  const styleOf = (e) => {
    const s = String(e.style ?? entities.horses?.[e.horse]?.ai?.runStyle ?? "").toUpperCase().trim();
    return ["E", "EP", "P", "S"].includes(s) ? s : null;
  };
  const fieldFigAvgs = live.map(figsOf).filter(Boolean).map((f) => f.reduce((s, x) => s + x, 0) / f.length);
  const fieldFigMean = fieldFigAvgs.length >= Math.max(3, Math.ceil(live.length / 2)) ? fieldFigAvgs.reduce((s, x) => s + x, 0) / fieldFigAvgs.length : null;
  const fieldStyles = live.map(styleOf).filter(Boolean);
  const raceCls = classRating(race.raceType, race.purse);

  // ---- Official meet-stats connection factor (NYRA leaders CSV) ----
  // A prior-on-probation: shrink each connection's meet win% by sample size, combine
  // jockey/trainer/owner, then score FIELD-RELATIVE so it measures within-race edge, not
  // "favored barns" globally. Only active when at least half the field carries meet stats.
  // NOTE (double-count risk, logged intentionally): jockey/trainer strength is already partly
  // in the morning line, and ML carries ~62% of the blend — so this rides the 38% factor side.
  // The Factor Audit tracks whether it actually predicts before its weight is ever trusted.
  const connStrength = (e) => {
    const hasAny = [e.jStarts, e.tStarts, e.oStarts].some((v) => v != null && v !== "" && isFinite(Number(v)));
    if (!hasAny) return null;
    const jw = shrinkPct(e.jWins, e.jStarts, 0.12, 6);
    const tw = shrinkPct(e.tWins, e.tStarts, 0.14, 6);
    const ow = shrinkPct(e.oWins, e.oStarts, 0.13, 10);
    return 0.5 * jw + 0.4 * tw + 0.1 * ow;
  };
  const connRaw = live.map(connStrength);
  const connVals = connRaw.filter((v) => v != null);
  const connMean = connVals.length >= Math.max(3, Math.ceil(live.length / 2))
    ? connVals.reduce((s, x) => s + x, 0) / connVals.length : null;

  const rows = live.map((e, _i) => {
    const hAI = entities.horses?.[e.horse]?.ai || {};
    const jP = effWinPct(entities.jockeys?.[e.jockey]?.ai, local.jockeys?.[e.jockey], 0.12);
    const tP = effWinPct(entities.trainers?.[e.trainer]?.ai, local.trainers?.[e.trainer], 0.14);
    const oP = effWinPct(entities.owners?.[e.owner]?.ai, local.owners?.[e.owner], 0.13);

    // Locally logged history for this horse (excluding the graded race itself — no leakage)
    const lh = (local.horses?.[(e.horse || "").trim()]?.hist || [])
      .filter((h) => h.id !== excludeId)
      .sort((h1, h2) => (h1.date < h2.date ? 1 : -1));

    // Form: logged finishes first (most recent), padded with AI-researched recent finishes
    let fins = lh.map((h) => h.fin);
    if (Array.isArray(hAI.recentFinishes)) fins = fins.concat(hAI.recentFinishes);
    fins = fins.slice(0, 5);
    let form = null;
    if (fins.length) {
      let num = 0, den = 0;
      fins.forEach((f, i) => { const w = Math.pow(0.75, i); num += w * (1 / Math.max(1, f)); den += w; });
      form = num / den;
    }

    // Blend AI split stats (0-100 pct) with locally logged splits; either alone still works
    const splitBlend = (aiPct, subset) => {
      const ls = subset.length, lw = subset.filter((h) => h.fin === 1).length;
      if (aiPct != null && ls > 0) return ((aiPct / 100) * 12 + lw + 0.12 * 2) / (12 + ls + 2);
      if (aiPct != null) return aiPct / 100;
      if (ls > 0) return (lw + 0.12 * 3) / (ls + 3);
      return null;
    };
    const surf = splitBlend(hAI.surface ? (isTurf ? hAI.surface.turfWinPct : hAI.surface.dirtWinPct) : null, lh.filter((h) => h.turf === isTurf));
    const dist = bucket ? splitBlend(hAI[bucket + "WinPct"] ?? null, lh.filter((h) => h.bucket === bucket)) : null;
    const cond = off ? splitBlend(hAI.offTrackWinPct ?? null, lh.filter((h) => h.off)) : null;

    // Head-to-head edge vs today's field from logged meetings (-1..+1, recency-agnostic)
    let h2hF = null;
    {
      let hNum = 0, hDen = 0;
      const me = (e.horse || "").trim();
      for (const o of live) {
        if (o === e) continue;
        const ok = (o.horse || "").trim();
        if (!me || !ok) continue;
        const [hx, hy] = [me, ok].sort((s, t) => s.localeCompare(t));
        const rec = local.h2h?.[hx + "||" + hy];
        if (!rec) continue;
        const meets = (rec.byRace || []).filter((m) => m.id !== excludeId);
        if (!meets.length) continue;
        const mine = hx === me ? "a" : "b";
        const ahead = meets.filter((m) => m.ahead === mine).length;
        const w = Math.min(meets.length, 3) / 3;
        hNum += w * ((2 * ahead - meets.length) / meets.length);
        hDen += w;
      }
      if (hDen > 0) h2hF = hNum / hDen;
    }

    // Speed figures: field-relative average of last 3, plus trend (improving/declining)
    let fig = null, figTrend = null;
    const myFigs = figsOf(e);
    if (myFigs && fieldFigMean != null) {
      const avg = myFigs.reduce((s, x) => s + x, 0) / myFigs.length;
      fig = Math.max(-1.2, Math.min(1.2, (avg - fieldFigMean) / 12));
      if (myFigs.length >= 3) figTrend = Math.max(-1, Math.min(1, (myFigs[0] - myFigs[2]) / 10));
    }
    // Pace fit — only scored when at least half the field has a known run style
    const style = styleOf(e);
    const pace = style && fieldStyles.length >= Math.ceil(live.length / 2) ? paceFactor(style, fieldStyles) : null;
    // Class move vs last 2 logged starts (positive = dropping in class)
    let clsMove = null;
    if (raceCls != null) {
      const past = lh.map((h) => h.cls).filter((c) => c != null).slice(0, 2);
      if (past.length) clsMove = Math.max(-1, Math.min(1, (past.reduce((s, x) => s + x, 0) / past.length - raceCls) / 2));
    }
    // Connections meet factor: field-centered, clamped. null when the field lacks stats.
    let connF = null;
    if (connMean != null && connRaw[_i] != null) {
      connF = Math.max(-1.2, Math.min(1.2, (connRaw[_i] - connMean) / 0.09));
    }
    let post = 0;
    const p = Number(e.post) || 0;
    if ((race.track || "").toLowerCase().includes("saratoga")) {
      if (isTurf && race.distanceF >= 8) { if (p >= 9) post = -0.18; else if (p <= 4) post = 0.05; }
      else if (!isTurf && race.distanceF <= 6.5) { if (p === 1) post = 0.03; else if (p >= 10) post = -0.06; }
    }

    let score = 0;
    // Weight scaled to backtest-proven edge, not raw magnitude: jockey cleared only
    // 56.2% above-average-on-winner (marginal) vs trainer's 60.2% (real) — jockey was
    // previously weighted HIGHER than trainer (3.2 vs 3.0), which let jockey identity
    // (especially high-mount-volume riders) dominate the score more than the evidence
    // supports. Rescaled proportionally to the edge each factor actually showed.
    score += 1.8 * (jP - 0.12);
    score += 3.0 * (tP - 0.14);
    // Owner factor computed for diagnostic/audit display only (see Performance tab).
    // NOT scored: backtest showed 46.7% above-average-on-winner — worse than a coin
    // flip, i.e. noise, not signal. Re-enable only if a larger sample proves otherwise.
    // score += 1.0 * (oP - 0.13);
    if (form != null) score += 2.4 * (form - 0.33);
    if (surf != null) score += 1.8 * (surf - 0.12);
    if (dist != null) score += 1.4 * (dist - 0.12);
    if (cond != null) score += 1.6 * (cond - 0.12);
    if (h2hF != null) score += 0.8 * h2hF;
    if (fig != null) score += 3.4 * fig;          // heaviest horse factor — figures earn it
    if (figTrend != null) score += 0.7 * figTrend;
    if (pace != null) score += 1.2 * pace;
    if (clsMove != null) score += 0.9 * clsMove;
    if (connF != null) score += 1.6 * connF;      // official meet stats — prior on probation
    score += post;

    const mp = impliedProb(parseOdds(e.liveOdds || e.ml));
    return { e, jP, tP, oP, form, surf, dist, cond, h2h: h2hF, fig, figTrend, pace, style, clsMove, connF, post, score, mp };
  });

  const mx = Math.max(...rows.map((r) => r.score));
  let fSum = 0;
  rows.forEach((r) => { r.fRaw = Math.exp(r.score - mx); fSum += r.fRaw; });
  rows.forEach((r) => { r.fP = r.fRaw / fSum; });

  const withM = rows.filter((r) => r.mp != null);
  if (withM.length >= Math.max(2, rows.length - 1)) {
    const mSum = rows.reduce((s, r) => s + (r.mp ?? 0.03), 0);
    rows.forEach((r) => { r.mP = (r.mp ?? 0.03) / mSum; });
  }

  const MW = marketW == null ? 0.62 : marketW;
  // Data-richness guard: the global calibrated weight assumes a "typical" mix of factors.
  // A race running on jockey%/trainer% alone (form, figs, pace, surf/dist splits, connF —
  // all null) has almost nothing real behind fP beyond two thin percentages, but softmax
  // still stretches small differences between them into visible win% gaps. That let deep
  // longshots (e.g. two 30/1 horses with unremarkable jockey/trainer stats) land within a
  // point or two of legitimate 3/1-7/1 contenders, because the calibrated weight — tuned
  // on races that DID have richer data — wasn't forced to defer to market here. Count how
  // many of the richer factors are actually live for at least half the field; if none are,
  // floor the effective weight high so market (which prices in real-world info this model
  // simply doesn't have for this race) dominates instead of two noisy percentages.
  const richKeys = ["form", "surf", "dist", "cond", "h2h", "fig", "pace", "clsMove", "connF"];
  const richCoverage = richKeys.filter((k) =>
    rows.filter((r) => r[k] != null).length >= Math.ceil(rows.length / 2)
  ).length;
  const effMW = richCoverage === 0 ? Math.max(MW, 0.88) : MW;
  let bSum = 0;
  rows.forEach((r) => {
    r.bRaw = r.mP != null ? Math.pow(r.mP, effMW) * Math.pow(r.fP, 1 - effMW) : r.fP;
    bSum += r.bRaw;
  });
  rows.forEach((r) => { r.win = r.bRaw / bSum; });
  return { rows, off, bucket, dataRich: richCoverage > 0 };
}

function analyzeRace(race, entities, local, marketW) {
  const base = computeRows(race, entities, local, marketW);
  if (!base) return null;
  const { rows, off, bucket, dataRich } = base;

  // Exponential-race sampling: E_i = -ln(U)/s_i, sort ascending = one exact Plackett–Luce
  // draw of the FULL finish order. Statistically identical to sequential removal (verified
  // to 3 decimals vs the old method), ~3x faster compute with far less GC churn — matters
  // most on mobile, where every scratch/ML edit re-runs this.
  const N = rows.length, SIMS = 6000;
  const pos = rows.map(() => new Array(N).fill(0));
  const exacta = {}, trifecta = {}, superfecta = {};
  const s = rows.map((r) => Math.max(r.win, 1e-6));
  const keys = new Float64Array(N);
  for (let t = 0; t < SIMS; t++) {
    const order = new Array(N);
    for (let i = 0; i < N; i++) { keys[i] = -Math.log(Math.random()) / s[i]; order[i] = i; }
    order.sort((a, b) => keys[a] - keys[b]);
    for (let place = 0; place < N; place++) pos[order[place]][place]++;
    const ex = order[0] + ">" + order[1];
    exacta[ex] = (exacta[ex] || 0) + 1;
    if (N >= 3) {
      const tr = ex + ">" + order[2];
      trifecta[tr] = (trifecta[tr] || 0) + 1;
      if (N >= 4) { const sf = tr + ">" + order[3]; superfecta[sf] = (superfecta[sf] || 0) + 1; }
    }
  }
  rows.forEach((r, i) => {
    r.winS = pos[i][0] / SIMS;
    r.place = (pos[i][0] + (pos[i][1] || 0)) / SIMS;
    r.show = (pos[i][0] + (pos[i][1] || 0) + (pos[i][2] || 0)) / SIMS;
  });
  const proj = rows.slice().sort((a, b) => b.win - a.win);
  const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, c]) => ({ combo: k.split(">").map((i) => rows[+i].e), p: c / SIMS }));
  return { rows, proj, exactas: top(exacta, 5), trifectas: top(trifecta, 5), superfectas: N >= 4 ? top(superfecta, 5) : [], off, bucket, dataRich };
}

/* ---- Model grading & self-calibration ---- */
function gradeAll(races, entities, local, marketW) {
  const out = [];
  for (const r of races) {
    if (!r.results || !r.results.length) continue;
    const base = computeRows(r, entities, local, marketW, r.id);
    if (!base || base.rows.length < 3) continue;
    const { rows } = base;
    const proj = rows.slice().sort((a, b) => b.win - a.win);
    const find = (name) => rows.find((x) => x.e.horse.toLowerCase() === String(name || "").toLowerCase()) || null;
    const wRow = find(r.results[0]);
    if (!wRow) continue;
    const rank = proj.indexOf(wRow) + 1;
    const sRow = r.results[1] ? find(r.results[1]) : null;
    const factors = {};
    for (const f of ["jP", "tP", "oP", "form", "surf", "dist", "cond", "h2h", "fig", "figTrend", "pace", "clsMove", "connF", "post"]) {
      const vals = rows.map((x) => x[f]).filter((v) => v != null && isFinite(v));
      const wv = wRow[f];
      if (wv == null || !isFinite(wv) || vals.length < 3) continue;
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      factors[f] = { above: wv > mean, diff: wv - mean };
    }
    out.push({
      race: r,
      winner: r.results[0],
      rank,
      p: wRow.win,
      fieldSize: rows.length,
      hit: rank === 1,
      top3: rank <= 3,
      exacta: !!(rank === 1 && sRow && proj[1] === sRow),
      factors,
    });
  }
  return out.sort((a, b) => (a.race.date < b.race.date ? 1 : -1));
}

const BLEND_CANDIDATES = [0.35, 0.5, 0.62, 0.75, 0.85, 0.9, 0.95, 1.0];
function calibrate(races, entities, local) {
  const graded = races.filter((r) => r.results?.length && (r.entries || []).filter((e) => !e.scratched).length >= 3);
  if (graded.length < 5) return { marketW: 0.62, n: graded.length, tuned: false };
  let best = 0.62, bestLL = -Infinity;
  for (const w of BLEND_CANDIDATES) {
    let ll = 0, n = 0;
    for (const r of graded) {
      const base = computeRows(r, entities, local, w, r.id);
      if (!base) continue;
      const wRow = base.rows.find((x) => x.e.horse.toLowerCase() === String(r.results[0] || "").toLowerCase());
      if (!wRow) continue;
      ll += Math.log(Math.max(wRow.win, 1e-4)); n++;
    }
    if (n > 0 && ll > bestLL) { bestLL = ll; best = w; }
  }
  return { marketW: best, n: graded.length, tuned: true };
}

/* ---- Bet grading ---- */
function gradeBet(bet, races) {
  if (!bet.raceId) return { status: "open" };
  const r = races.find((x) => x.id === bet.raceId);
  if (!r) return { status: "open" };
  if (!r.results || !r.results.length) return { status: "open" };
  const postOf = (name) => {
    const e = (r.entries || []).find((x) => x.horse.toLowerCase() === String(name || "").toLowerCase());
    return e ? Number(e.post) : null;
  };
  const finPosts = r.results.map(postOf);
  const sel = String(bet.selection || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  if (!sel.length) return { status: "open" };
  const t = bet.type;
  const need = t === "Win" ? 1 : t === "Place" ? 2 : t === "Show" ? 3 : t === "Exacta" ? 2 : t === "Trifecta" ? 3 : t === "Superfecta" ? 4 : 0;
  if (!need) return { status: "open" };
  if (t === "Win" || t === "Place" || t === "Show") {
    const topN = finPosts.slice(0, need);
    if (topN.includes(sel[0])) return { status: "won" };
    if (finPosts.length >= need && topN.every((p) => p != null)) return { status: "lost" };
    return { status: "open" };
  }
  if (finPosts.length >= need && finPosts.slice(0, need).every((p) => p != null)) {
    const win = sel.length >= need && finPosts.slice(0, need).every((p, i) => p === sel[i]);
    return { status: win ? "won" : "lost" };
  }
  return { status: "open" };
}

/* ================= CLAUDE API ================= */
async function askClaude(prompt, useSearch, useFetch) {
  const tools = [];
  if (useSearch) tools.push({ type: "web_search_20250305", name: "web_search" });
  if (useFetch) tools.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 });
  const headers = { "Content-Type": "application/json" };
  if (useFetch) headers["anthropic-beta"] = "web-fetch-2025-09-10";
  let messages = [{ role: "user", content: prompt }];
  let rateRetries = 0; // 429/concurrency errors get their own backoff budget, not shared with hops
  for (let hop = 0; hop < 6; hop++) {
    const body = { model: "claude-sonnet-4-6", max_tokens: 1000, messages };
    if (tools.length) body.tools = tools;

    let res;
    try {
      res = await fetch("/api/claude", { method: "POST", headers, body: JSON.stringify(body) });
    } catch (netErr) {
      // Network/bridge threw before any response (CORS, connection reset, bridge down)
      if (hop === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw new Error("Network/bridge error: " + (netErr?.message || "request failed"));
    }

    // Read the raw body ONCE as text, then try to parse. The platform bridge sometimes
    // returns a non-JSON body (an HTML error page, or a bare "Invalid response format"
    // string). Calling res.json() on those throws a cryptic SyntaxError that used to
    // masquerade as "no data". Parse defensively and surface the real status instead.
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }

    // 429 = rate/concurrency limit. This is transient and expected when several pulls run
    // at once ("representativeClaim":"concurrents"). Wait it out with growing backoff and
    // retry the SAME request up to 4 times before giving up — don't burn a hop, don't fail
    // to the user for something that clears in a couple of seconds.
    if (res.status === 429) {
      if (rateRetries < 4) {
        const wait = 2000 * Math.pow(2, rateRetries); // 2s, 4s, 8s, 16s
        rateRetries++;
        await new Promise((r) => setTimeout(r, wait));
        hop--; // this attempt doesn't count as a pause-turn hop
        continue;
      }
      throw new Error("Rate limit (concurrent requests) — too many pulls at once. Wait a moment and hit Pull again.");
    }
    if (!res.ok) {
      if (res.status >= 500 && hop === 0) { await new Promise((r) => setTimeout(r, 1800)); continue; }
      const detail = data?.error?.message || (raw ? raw.slice(0, 160) : "");
      throw new Error(`API HTTP ${res.status}${detail ? " — " + detail : ""}`);
    }
    if (data == null) {
      // 200 OK but body wasn't JSON — this is the "Invalid response format" bridge case.
      if (hop === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw new Error("Bridge returned a non-JSON response" + (raw ? ": " + raw.slice(0, 120) : " (empty body)"));
    }
    if (data.error) {
      // Some bridges wrap a 429 as a 200 with an error body — catch that shape too.
      const et = String(data.error?.type || data.error?.message || "");
      if (/429|rate|concurr|exceeded_limit/i.test(et) && rateRetries < 4) {
        const wait = 2000 * Math.pow(2, rateRetries); rateRetries++;
        await new Promise((r) => setTimeout(r, wait)); hop--; continue;
      }
      if (useFetch) return askClaude(prompt, useSearch, false); // fetch tool unavailable → search-only
      if (hop === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw new Error(data.error?.message || "API error");
    }
    // Server tools (web_fetch especially) can pause mid-task; continue the turn.
    if (data.stop_reason === "pause_turn") { messages = [...messages, { role: "assistant", content: data.content }]; continue; }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    // stop_reason "max_tokens" means the JSON was cut off mid-answer. Return what we have —
    // repairJSON downstream salvages complete leading items — but if it's empty, say so.
    if (!text && data.stop_reason === "max_tokens") throw new Error("Response hit the token cap before any text — batch too large");
    return text;
  }
  throw new Error("Model kept pausing mid-task — try again");
}
function repairJSON(raw) {
  const a = raw.indexOf("{");
  if (a === -1) throw new Error("No JSON in response");
  const s = raw.slice(a);
  // candidate cut points: end of string, then each structural char from the end
  const cuts = [s.length];
  for (let i = s.length - 1; i >= 0 && cuts.length < 250; i--) {
    if ("}],\"".includes(s[i])) cuts.push(i + 1);
  }
  for (const end of cuts) {
    let c = s.slice(0, end).replace(/,\s*$/, "");
    let inStr = false, esc = false; const stack = [];
    for (const ch of c) {
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
    if (inStr) c += '"';
    c = c.replace(/,\s*$/, "");
    while (stack.length) c += stack.pop() === "{" ? "}" : "]";
    try { return JSON.parse(c); } catch { /* try next cut */ }
  }
  throw new Error("Response was not valid JSON");
}
function pluckJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a === -1) throw new Error("No JSON in response");
  try { return JSON.parse(clean.slice(a, b + 1)); }
  catch { return repairJSON(clean); }
}
// Ask for JSON with a second-chance reformat pass if the first response can't be parsed
async function askForJSON(prompt, useSearch, useFetch) {
  const text = await askClaude(prompt, useSearch, useFetch);
  try { return pluckJSON(text); }
  catch (e1) {
    const fixed = await askClaude(
      "Convert the following into ONE valid, complete JSON object. Output ONLY the JSON — no fences, no commentary. Preserve the data; if the input is cut off mid-item, drop the incomplete trailing items:\n\n" + text.slice(0, 6000),
      false
    );
    return pluckJSON(fixed);
  }
}

const pullRacePrompt = (track, date, num) =>
`Find the official entries for ${track} Race ${num} on ${date} (thoroughbred racing).
If you have a web page fetch tool, FIRST fetch this URL — it carries the full card with posts, connections and morning lines:
https://entries.horseracingnation.com/entries-results/${trackSlug(track)}/${date}
Locate the "Race # ${num}" section and read its entries table (program number, horse, trainer/jockey, ML odds). Otherwise use web search.
Respond with ONLY a JSON object, no markdown fences, no commentary:
{"track":"${track}","date":"${date}","raceNumber":${num},"racesOnCard":number (total races on this card) or null,"surface":"Dirt or Turf","distanceFurlongs":number,"condition":"Fast/Firm/Muddy/Sloppy/Yielding/Good/unknown","raceType":"e.g. Allowance, Grade 1 Stakes, Maiden","purse":"string or null","entries":[{"post":number,"horse":"name","jockey":"name","trainer":"name","owner":"name or null","mlOdds":"e.g. 5/2 or null"}]}
Include every entrant. Mark scratches by adding "scratched":true. If you cannot find the race, respond {"error":"brief reason"}.`;

// Compact multi-race pull: 3 races per call keeps the JSON safely under the token cap,
// and one HRN page fetch covers every race in the batch.
const pullCardBatchPrompt = (track, date, fromN, toN) =>
  `Extract the entries for races ${fromN} through ${toN} at ${track} on ${date}. Work this source cascade IN ORDER and stop at the first that works:
SOURCE 1: fetch https://entries.horseracingnation.com/entries-results/${track.toLowerCase().replace(/ /g, "-")}/${date}
SOURCE 2 (if source 1 fails or is incomplete): fetch https://www.nyra.com/saratoga/racing/entries/ (full card with ML, jockeys, trainers)
SOURCE 3 (if both fetches fail): web search "${track} entries ${date}" and build from results.
Respond with ONLY minified JSON, no prose, EXACTLY this shape (short keys matter — the payload must stay small):
{"racesOnCard":number,"races":[{"n":raceNumber,"s":"Dirt|Turf|Inner turf","d":distanceInFurlongs,"c":"condition or unknown","rt":"race type","e":[{"p":post,"h":"horse","j":"jockey","t":"trainer","ml":"morning line"}]}]}
Rules: include every non-scratched entry; add "scr":true instead of omitting a scratched horse if the page marks it; skip races above ${toN}; if a race number does not exist on the card, omit it.
If the page fetch fails, that does NOT mean the card doesn't exist — fall back to web search ("${track} entries ${date}") and build the races from search results. Only respond {"error":"not found"} if you have positively confirmed ${track} is dark on ${date}.`;

const enrichPrompt = (type, name) => {
  const base = `Use web search to find current career statistics for the thoroughbred racing ${type} "${name}" (North America). Respond with ONLY JSON, no fences:`;
  if (type === "horse")
    return base + `
{"starts":number,"wins":number,"places":number,"shows":number,"winPct":number,"recentFinishes":[last 5 finish positions as numbers, most recent first],"surface":{"dirtWinPct":number or null,"turfWinPct":number or null},"sprintWinPct":number or null,"routeWinPct":number or null,"offTrackWinPct":number or null,"recentFigs":[up to 3 most recent speed figures as numbers, most recent first — Beyer, Equibase Speed, or HRN figure, whichever is published],"runStyle":"E, EP, P or S (E=front-runner, EP=presser, P=stalker, S=closer)","earnings":"string or null","note":"one line, max 120 chars (running style, class, anything notable)"}
Use null for anything you can't find. Estimates from partial data are fine if labeled in note.`;
  return base + `
{"starts":number,"wins":number,"places":number,"shows":number,"winPct":number (0-100),"saratogaWinPct":number or null,"note":"one line, max 120 chars"}
Prefer current-year or current-meet stats; use null when unknown.`;
};

const pinkPrompt = (date) =>
`Use web search to find publicly available, FREE handicapper selections for Saratoga Race Course on ${date}. Check multiple sources: The Saratogian "Pink Sheet", Albany Times Union, New York Post, The Daily Gazette, Horse Racing Nation free picks, America's Best Racing, NYRA analyst picks, and any other free public selections you can find. Be concise. Respond ONLY with JSON, no fences:
{"date":"${date}","handicappers":[{"name":"handicapper name","source":"outlet, e.g. Saratogian Pink Sheet / NY Post / HRN","record":"published record if stated, else null","winPct":number or null,"picks":[{"race":number,"horse":"top pick name"}]}],"top10":[{"rank":1,"race":number,"horse":"name","pickedBy":["handicapper names"]}],"note":"one line listing which sources were found, max 140 chars"}
Include up to 8 handicappers, max 3 strongest picks each. Keep every string short — no citations, no URLs, no extra fields. Build top10 as the 10 strongest consensus selections across ALL sources combined (most agreement first, then conviction). If nothing is publicly available: {"error":"brief reason"}.`;

const trackSlug = (t) => (t || "").toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
const liveOddsPrompt = (r) =>
`Find CURRENT live tote odds (win pool — NOT the morning line) for ${r.track} Race ${r.raceNumber} on ${r.date}, thoroughbred. Fetch https://entries.horseracingnation.com/entries-results/${trackSlug(r.track)}/${r.date} FIRST if you have a fetch tool; fall back to searching NYRA, TwinSpires or DRF live odds. Respond ONLY minified JSON: {"odds":{"<program number>":"odds string like 5/2 or 7"}} covering every live runner you can see. If live odds are not posted yet: {"error":"not posted"}.`;
const resultsBatchPrompt = (track, date, nums) =>
`Find the official order of finish for these ${track} races on ${date} (thoroughbred) — ALL have been run: races ${nums.join(", ")}.
STEP 1 (do this FIRST if you have a fetch tool): fetch https://entries.horseracingnation.com/entries-results/${trackSlug(track)}/${date} — when fresh, every race's payout table (= finishing order) is on that one page.
STEP 2 fallback per race: Equibase chart, DRF, TwinSpires, local recaps. Never trust NYRA's "Results not available".
Respond ONLY minified JSON, no prose:
{"races":[{"n":raceNumber,"finishOrder":["horse names in exact finish order, winner first"],"partial":true|false,"source":"short source name"}]}
Include a race ONLY if you verified at least its top 2 finishers; omit races you cannot verify. Keep it compact.`;
const resultsPrompt = (r) =>
`Find the order of finish for ${r.track} Race ${r.raceNumber} on ${r.date} (thoroughbred). This race has been run.
STEP 1 (do this FIRST if you have a web page fetch tool): fetch this exact URL — Horse Racing Nation posts payouts on it within minutes of each race going official:
https://entries.horseracingnation.com/entries-results/${trackSlug(r.track)}/${r.date}
Locate the "Race # ${r.raceNumber}" section. Below the entries there is a results/payout table listing horses with Win/Place/Show payouts — the horses in that table are listed IN FINISHING ORDER (first row = winner). The Exacta pool row (e.g. "6-3") confirms the top two program numbers. Ignore the pre-race picks text.
STEP 2 (if step 1 unavailable or the section has no payout table yet): search exhaustively with several different searches — "Equibase ${r.track} results ${r.date}", "Equibase ${r.track} race ${r.raceNumber} chart", "${r.track} race ${r.raceNumber} results ${r.date}" with the date written out, DRF / TwinSpires / OffTrackBetting / NYRA results, racing recaps and track social posts. Search snippets are often STALE (pre-race) — prefer any source showing payouts or a winner over sources showing only entries.
A PARTIAL order is valuable — top 3 or 4 is enough. Respond ONLY with JSON, no fences:
{"finishOrder":["winner name","2nd place","3rd place",...],"partial":true or false,"source":"where you found it"}
List as many finishers as you can confirm, in finishing order. Only respond {"error":"reason"} if you truly cannot confirm even the winner after fetching the URL and running at least 3 distinct searches.`;

/* ================= UI PRIMITIVES ================= */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,500;6..96,600;6..96,700&family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
:root{
  --paddock:#0E271C; --paddock2:#123425; --rail:#2C5A42; --rail2:#1B4030;
  --program:#F6F1E3; --program2:#EFE7D2; --ink:#221F17; --ink2:#5C564A;
  --brass:#C9A24B; --brassD:#8F6E2B; --silks:#BE1E2D; --tote:#F2C14E; --toteDim:#9B8B57;
  --good:#2F7D4F;
}
.hrm *{box-sizing:border-box}
.hrm{font-family:'Archivo',sans-serif;color:var(--program);background:
  radial-gradient(1200px 500px at 70% -200px, #1A4530 0%, transparent 60%), var(--paddock);
  min-height:100vh}
.hrm .disp{font-family:'Bodoni Moda',serif}
.hrm .mono{font-family:'IBM Plex Mono',monospace}
.hrm .card{background:var(--program);color:var(--ink);border:1px solid #D8CFB6;border-radius:6px;
  box-shadow:0 2px 0 rgba(0,0,0,.25)}
.hrm .hairline{border-top:1px solid var(--brassD);opacity:.55}
.hrm button{cursor:pointer;font-family:'Archivo',sans-serif}
.hrm .btn{background:var(--silks);color:#fff;border:none;border-radius:4px;padding:9px 16px;font-weight:600;font-size:13px;letter-spacing:.02em}
.hrm .btn:disabled{opacity:.45;cursor:default}
.hrm .btn2{background:transparent;color:var(--brass);border:1px solid var(--brassD);border-radius:4px;padding:8px 14px;font-weight:600;font-size:12.5px}
.hrm .btn3{background:#fff;color:var(--ink);border:1px solid #C9BFA4;border-radius:4px;padding:6px 10px;font-weight:600;font-size:12px}
.hrm input,.hrm select{background:#FFFDF6;border:1px solid #C9BFA4;border-radius:4px;padding:8px 10px;font-size:13px;color:var(--ink);font-family:'Archivo',sans-serif}
.hrm input:focus,.hrm select:focus{outline:2px solid var(--brass);outline-offset:1px}
.hrm .tab{background:transparent;border:none;color:#B9C7B4;padding:10px 2px;font-weight:600;font-size:13px;letter-spacing:.06em;text-transform:uppercase;border-bottom:2px solid transparent}
.hrm .tab.on{color:var(--tote);border-bottom-color:var(--tote)}
.hrm table{border-collapse:collapse;width:100%}
.hrm th{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);text-align:left;padding:8px 10px;border-bottom:1px solid #C9BFA4}
.hrm td{padding:9px 10px;border-bottom:1px solid #E4DCC5;font-size:13.5px;vertical-align:middle}
.hrm tr:last-child td{border-bottom:none}
.hrm .chip{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:4px;font-weight:700;font-size:14px;border:1px solid rgba(0,0,0,.25);box-shadow:inset 0 -2px 0 rgba(0,0,0,.15)}
.hrm .totebar{background:#0B1F16;border:1px solid var(--rail2);border-radius:6px}
.hrm .err{background:#3A1418;border:1px solid #7A2A32;color:#F2C9CD;border-radius:6px;padding:10px 14px;font-size:13px}
.hrm .note{color:var(--ink2);font-size:12px}
.hrm ::placeholder{color:#A79E8B}
@media (prefers-reduced-motion: no-preference){ .hrm .fade{animation:fadeIn .35s ease} @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}} }
`;

const Chip = ({ post }) => {
  const [bg, fg] = clothOf(Number(post));
  return <span className="chip" style={{ background: bg, color: fg }}>{post}</span>;
};
const Bar = ({ p, color = "var(--silks)" }) => (
  <div style={{ background: "#E4DCC5", borderRadius: 3, height: 8, width: "100%", minWidth: 60 }}>
    <div style={{ width: `${Math.min(100, p * 100)}%`, background: color, height: 8, borderRadius: 3 }} />
  </div>
);

/* ================= MAIN APP ================= */
export default function App() {
  const [tab, setTab] = useState("races");
  const [races, setRaces] = useState(null);
  const [entities, setEntities] = useState(null);
  const [pink, setPink] = useState(null);
  const [bets, setBets] = useState(null);
  const [openRace, setOpenRace] = useState(null);
  const [err, setErr] = useState(null);
  const [autoMsg, setAutoMsg] = useState(null);
  // null = checking, true = storage confirmed working, false = writes are silently failing
  // (the #1 cause: this artifact isn't published yet — persistent storage only activates
  // after Publish, and until then every save quietly no-ops instead of erroring).
  const [storageOk, setStorageOk] = useState(null);

  useEffect(() => {
    (async () => {
      let r0 = await loadKey(K_RACES, []);
      let e0 = await loadKey(K_ENT, { horses: {}, jockeys: {}, trainers: {}, owners: {} });
      const have = new Set(r0.map((r) => `${r.track}|${r.date}|${r.raceNumber}`));
      const add = SEED_RACES.filter((r) => !have.has(`${r.track}|${r.date}|${r.raceNumber}`));
      if (add.length) {
        r0 = [...r0, ...add];
        for (const sr of add) {
          for (const e of sr.entries) {
            if (e.horse) e0.horses[e.horse] = e0.horses[e.horse] || {};
            if (e.jockey) e0.jockeys[e.jockey] = e0.jockeys[e.jockey] || {};
            if (e.trainer) e0.trainers[e.trainer] = e0.trainers[e.trainer] || {};
            if (e.owner) e0.owners[e.owner] = e0.owners[e.owner] || {};
          }
        }
        await saveKey(K_RACES, r0);
        await saveKey(K_ENT, e0);
      }
      // Self-heal any pre-existing id collisions (older auto-loads could mint a shared
      // "…-Rundefined-auto" id when the model omitted a race number, which made every
      // board click open the first such race). Keep first occurrence of each id.
      {
        const seen = new Set();
        const cleaned = r0.filter((r) => (r && r.id != null && !seen.has(r.id)) ? (seen.add(r.id), true) : false);
        if (cleaned.length !== r0.length) { r0 = cleaned; await saveKey(K_RACES, r0); }
      }
      setRaces(r0);
      setEntities(e0);
      setPink(await loadKey(K_PINK, {}));
      setBets(await loadKey(K_BETS, []));
    })();
  }, []);

  // Synchronous mirror of entities: parallel enrichment merges read/write this ref so
  // concurrent researchers never clobber each other with stale closures.
  const entRef = useRef(entities);
  useEffect(() => { entRef.current = entities; }, [entities]);

  // Storage health probe: write a throwaway value, read it back. If the round-trip
  // doesn't come back, every save this session (races, scratches, bets) is quietly
  // going nowhere — the board LOOKS like it updated (React state changed) but nothing
  // persists to reload. This is silent by design in unpublished artifacts, so we check
  // for it explicitly rather than letting the user discover it a day later.
  useEffect(() => {
    (async () => {
      const probe = String(Date.now());
      const wrote = await saveKey("hrm-storage-probe", probe);
      const read = wrote ? await loadKey("hrm-storage-probe", null) : null;
      setStorageOk(read === probe);
    })();
  }, []);

  const local = useMemo(() => deriveLocal(races || []), [races]);
  const tune = useMemo(
    () => (races && entities ? calibrate(races, entities, local) : { marketW: 0.62, n: 0, tuned: false }),
    [races, entities, local]
  );

  const persistRaces = async (next) => {
    // Last line of defense against id collisions: two races sharing an id makes
    // races.find(r => r.id === openRace) resolve every click to the first match.
    // Keep the FIRST occurrence of each id (incoming/newer is unshifted to the front
    // by callers), dropping any later duplicate.
    const seen = new Set();
    const deduped = (next || []).filter((r) => (r && r.id != null && !seen.has(r.id)) ? (seen.add(r.id), true) : false);
    setRaces(deduped); await saveKey(K_RACES, deduped);
  };
  const persistEntities = async (next) => { setEntities(next); await saveKey(K_ENT, next); };
  const persistPink = async (next) => { setPink(next); await saveKey(K_PINK, next); };
  const persistBets = async (next) => { setBets(next); await saveKey(K_BETS, next); };

  // ---- Backup / Restore: your data must survive artifact updates ----
  // New artifact versions start with fresh storage; this moves everything across in one paste.
  const exportBackup = () => JSON.stringify({
    app: "trillys-track", version: 3, exportedAt: new Date().toISOString(),
    races: races || [], entities: entities || { horses: {}, jockeys: {}, trainers: {}, owners: {} },
    pink: pink || {}, bets: bets || [],
  });
  const restoreBackup = async (text) => {
    let b = null;
    try { b = JSON.parse(text); } catch { return { error: "That's not valid backup JSON — paste the whole blob, nothing else." }; }
    if (!b || b.app !== "trillys-track") return { error: "This doesn't look like a Trilly's Track backup." };
    // Merge, never clobber: union races/bets by id (backup wins), merge entity maps and pink dates.
    const byId = (cur, inc) => {
      const m = new Map((cur || []).map((x) => [x.id, x]));
      for (const x of inc || []) if (x && x.id) m.set(x.id, x);
      return [...m.values()];
    };
    const nr = byId(races, b.races);
    const ne = { horses: {}, jockeys: {}, trainers: {}, owners: {} };
    for (const t of ["horses", "jockeys", "trainers", "owners"]) ne[t] = { ...(entities?.[t] || {}), ...(b.entities?.[t] || {}) };
    const np = { ...(pink || {}), ...(b.pink || {}) };
    const nb = byId(bets, b.bets);
    await saveKey(K_RACES, nr); setRaces(nr);
    await saveKey(K_ENT, ne); setEntities(ne); entRef.current = ne;
    await saveKey(K_PINK, np); setPink(np);
    await saveKey(K_BETS, nb); setBets(nb);
    return { ok: true, races: nr.length, bets: nb.length };
  };

  // Pull today's full Saratoga card: batched 3-races-per-call, batches in parallel,
  // individual race pulls only as gap-fill. Manual button re-runs any time.
  const loadTodayCard = async (forDate) => {
    const today = forDate || localDate();
    const label = forDate && forDate !== localDate() ? forDate : "today";
    const baseList = races || [];
    const have = new Set(baseList.filter((r) => (r.track || "").toLowerCase().includes("saratoga") && r.date === today).map((r) => r.raceNumber));
    const normEntry = (e) => ({
      post: e.p ?? e.post, horse: e.h ?? e.horse ?? "", jockey: e.j ?? e.jockey ?? "",
      trainer: e.t ?? e.trainer ?? "", owner: e.owner || "", ml: e.ml ?? e.mlOdds ?? "", scratched: !!(e.scr ?? e.scratched),
    });
    const toRace = (rj) => {
      // The race number is the ONLY thing making an auto id unique. If the model
      // omits or garbles it (truncated/repaired JSON), several races would collapse
      // onto the SAME id (e.g. "Saratoga-<date>-Rundefined-auto"), and races.find()
      // would then resolve every board click to whichever shares that id first (R1).
      // Never mint an id from a missing number: fall back to a unique token.
      const num = Number(rj.n ?? rj.raceNumber);
      const validNum = Number.isFinite(num) && num > 0;
      return {
      id: validNum ? `Saratoga-${today}-R${num}-auto` : `Saratoga-${today}-Rx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      track: "Saratoga", date: today, raceNumber: validNum ? num : null,
      surface: rj.s ?? rj.surface ?? "Dirt", distanceF: rj.d ?? rj.distanceFurlongs ?? null,
      condition: rj.c ?? rj.condition ?? "unknown", raceType: rj.rt ?? rj.raceType ?? "", purse: rj.purse ?? "",
      entries: (rj.e ?? rj.entries ?? []).map(normEntry).filter((e) => e.horse),
      results: null,
      };
    };
    // A pull is "suspect" when the model returned a field that looks truncated or garbled:
    // an entry missing a horse name, or with BOTH jockey and trainer blank/"unknown" (the
    // classic sign of a padded/hallucinated row), or a field far smaller than the card norm.
    // Suspect races still load (better than nothing) but get named so you can paste-fix them.
    const isSuspect = (race) => {
      const es = (race.entries || []);
      if (!es.length) return true;
      const bad = es.some((e) => {
        const j = String(e.jockey || "").trim().toLowerCase();
        const t = String(e.trainer || "").trim().toLowerCase();
        const blankJ = !j || j === "unknown" || j === "tba" || j === "n/a";
        const blankT = !t || t === "unknown" || t === "tba" || t === "n/a";
        return !e.horse || (blankJ && blankT);
      });
      return bad || es.length < 4; // most Saratoga fields are 5+; <4 is a red flag
    };
    let lastErr = null;
    const runBatch = async (a, b) => {
      try { return await askForJSON(pullCardBatchPrompt("Saratoga", today, a, b), true, true); }
      catch (e1) {
        try { return await askForJSON(pullCardBatchPrompt("Saratoga", today, a, b), true, true); }
        catch (e2) { lastErr = e2?.message || e1?.message || "unknown error"; return null; }
      }
    };
    const gathered = new Map();
    const takeBatch = (j) => {
      if (!j || j.error || !Array.isArray(j.races)) return;
      for (const rj of j.races) {
        const n = +(rj?.n ?? rj?.raceNumber);
        if (n && Array.isArray(rj.e ?? rj.entries) && (rj.e ?? rj.entries).length && !have.has(n)) gathered.set(n, toRace(rj));
      }
    };

    setAutoMsg(`Loading the ${label === "today" ? "today's" : label} Saratoga card — races 1–2…`);
    // Batches of TWO races: real fields run 10-12 horses, and 3 races of those overflows the
    // 1000-token response cap — the JSON truncates, the repair call truncates identically,
    // and every attempt dies. Two races fits with headroom on the biggest fields.
    const first = await runBatch(1, 2);
    let totalRaces = null;
    if (first && first.racesOnCard) totalRaces = Math.min(13, +first.racesOnCard || 0) || null;
    takeBatch(first);
    // A failed first batch does NOT mean a dark day — push on with a default cap; missing
    // races fall through to gap-fill. "No card" only if EVERYTHING comes back empty.
    const cap = totalRaces || 12;
    const batches = [];
    for (let s2 = 3; s2 <= cap; s2 += 2) {
      const b = Math.min(s2 + 1, cap);
      let needed = false;
      for (let n = s2; n <= b; n++) if (!have.has(n)) needed = true;
      if (needed) batches.push([s2, b]);
    }
    if (batches.length) {
      setAutoMsg(`Loading ${label === "today" ? "today's" : label + "'s"} Saratoga card — races 3–${cap}, up to 3 calls at a time…`);
      const limit = pLimit(2);
      const rest = await Promise.all(batches.map(([a2, b2]) => limit(() => runBatch(a2, b2))));
      rest.forEach(takeBatch);
    }
    // Gap-fill: individual pulls, also parallel, only for what's still missing
    const missing = [];
    for (let n = 1; n <= cap; n++) if (!have.has(n) && !gathered.has(n)) missing.push(n);
    if (missing.length) {
      setAutoMsg(`Filling gaps — R${missing.join(", R")}…`);
      const limitFill = pLimit(2);
      const fills = await Promise.all(missing.map((n) => limitFill(async () => {
        const attempt = async () => {
          const j = await askForJSON(pullRacePrompt("Saratoga", today, n), true, true);
          return j && !j.error && Array.isArray(j.entries) && j.entries.length ? { n, j } : null;
        };
        try { return (await attempt()) || (await attempt()); }
        catch (e) { try { return await attempt(); } catch (e2) { lastErr = e2?.message || e?.message || lastErr; return null; } }
      })));
      for (const f of fills) if (f) gathered.set(f.n, toRace({ ...f.j, n: f.n, e: f.j.entries }));
    }

    const added = gathered.size;
    const suspect = [...gathered.values()].filter(isSuspect).map((r) => r.raceNumber).sort((a, b) => a - b);
    if (added) {
      const newOnes = [...gathered.values()].sort((a2, b2) => a2.raceNumber - b2.raceNumber);
      const list = [...baseList.filter((r) => !gathered.has(r.raceNumber) || r.date !== today || !(r.track || "").toLowerCase().includes("saratoga")), ...newOnes];
      let ent = entities;
      for (const sr of newOnes) ent = registerFromRace(ent, sr);
      await saveKey(K_RACES, list); setRaces(list);
      await saveKey(K_ENT, ent); setEntities(ent);
    }
    const stillMissing = [];
    for (let n = 1; n <= cap; n++) if (!have.has(n) && !gathered.has(n)) stillMissing.push(n);
    const suspectNote = suspect.length
      ? ` ⚠ R${suspect.join(", R")} came back with a thin or incomplete field — open ${suspect.length > 1 ? "them" : "it"} and use "Paste chart / entries" to fill the real card.`
      : "";
    setAutoMsg(added
      ? stillMissing.length
        ? `Loaded ${added} race${added > 1 ? "s" : ""} — couldn't fetch R${stillMissing.join(", R")}. Hit the load button again to retry just those.${suspectNote}`
        : `The ${label === "today" ? "today's" : label} card is on the board — ${added} race${added > 1 ? "s" : ""} loaded.${label !== "today" ? " Pick that date in the Showing menu to view it." : ""}${suspectNote}`
      : have.size ? `The ${label === "today" ? "today's" : label} card is already on the board.`
      : lastErr ? `Card load failed — every call errored (last error: ${String(lastErr).slice(0, 120)}). This is a connection/API problem, not a dark day. Try again in a minute.`
      : `No Saratoga card found for ${label} — dark day, or entries not posted yet.`);
    setTimeout(() => setAutoMsg(null), suspect.length ? 16000 : 9000);
    return added;
  };

  // AUTO-LOAD DISABLED (Michael's call, 2026-07-17): cards are loaded manually only.
  // Nothing fires on page load anymore — the "Load Nth card" button in RaceBoard still
  // works if you ever want it, but nothing pulls data on your behalf without a click.
  // Once a card is in, it's treated as good; scratches are pushed/flagged by hand.

  // Bulk import: adds many historical races (with results) in one save
  const addRacesBulk = async (list) => {
    let ent = entities;
    for (const r of list) ent = registerFromRace(ent, r);
    const ids = new Set(list.map((r) => r.id));
    await persistRaces([...list, ...(races || []).filter((r) => !ids.has(r.id))]);
    await persistEntities(ent);
    return list.length;
  };

  // Auto-source results for every open race dated today or earlier
  const fetchAllResults = async (onProgress) => {
    const today = localDate();
    let list = races;
    const targets = list.filter((r) => !(r.results?.length) && r.date <= today);
    if (!targets.length) return { total: 0, ok: 0 };
    // One AI call covers a whole date's finish orders (they're just name lists):
    // group open races by track+date, chunk 5 races per call, fire ALL chunks in parallel.
    const groups = {};
    for (const r of targets) { const k = r.track + "|" + r.date; (groups[k] = groups[k] || []).push(r); }
    const chunks = [];
    for (const k of Object.keys(groups)) {
      const rs = groups[k].sort((a, b) => a.raceNumber - b.raceNumber);
      for (let i = 0; i < rs.length; i += 5) chunks.push(rs.slice(i, i + 5));
    }
    let ok = 0, doneB = 0;
    onProgress?.(`Fetching ${targets.length} results in ${chunks.length} parallel batch${chunks.length > 1 ? "es" : ""}…`);
    const updates = new Map();
    const limitRes = pLimit(2);
    await Promise.all(chunks.map((chunk) => limitRes(async () => {
      const { track, date } = chunk[0];
      const nums = chunk.map((r) => r.raceNumber);
      let j = null;
      try { j = await askForJSON(resultsBatchPrompt(track, date, nums), true, true); }
      catch { try { j = await askForJSON(resultsBatchPrompt(track, date, nums), true, true); } catch { j = null; } }
      if (j && !j.error && Array.isArray(j.races)) {
        for (const rr of j.races) {
          const match = chunk.find((r) => r.raceNumber === +(rr?.n));
          if (match && Array.isArray(rr.finishOrder) && rr.finishOrder.length >= 2) {
            updates.set(match.id, { results: rr.finishOrder, resultsMeta: { partial: !!rr.partial, source: rr.source || null } });
            ok++;
          }
        }
      }
      doneB++;
      onProgress?.(`Batch ${doneB}/${chunks.length} in — ${ok}/${targets.length} results so far…`);
    })));
    if (updates.size) list = list.map((x) => (updates.has(x.id) ? { ...x, ...updates.get(x.id) } : x));
    await persistRaces(list);
    return { total: targets.length, ok };
  };

  // register entities from a race so they show in the databases
  const registerFromRace = (ent, race) => {
    const next = { ...ent, horses: { ...ent.horses }, jockeys: { ...ent.jockeys }, trainers: { ...ent.trainers }, owners: { ...ent.owners } };
    for (const e of race.entries || []) {
      if (e.horse) next.horses[e.horse] = next.horses[e.horse] || {};
      if (e.jockey) next.jockeys[e.jockey] = next.jockeys[e.jockey] || {};
      if (e.trainer) next.trainers[e.trainer] = next.trainers[e.trainer] || {};
      if (e.owner) next.owners[e.owner] = next.owners[e.owner] || {};
    }
    return next;
  };

  const addRace = async (race) => {
    const withId = { ...race, id: race.id || `${race.track}-${race.date}-R${race.raceNumber}-${Date.now()}` };
    await persistRaces([withId, ...(races || []).filter((r) => r.id !== withId.id)]);
    await persistEntities(registerFromRace(entities, withId));
    setOpenRace(withId.id);
    setTab("races");
  };
  const updateRace = async (race) => { await persistRaces((races || []).map((r) => (r.id === race.id ? race : r))); };
  const deleteRace = async (id) => { await persistRaces((races || []).filter((r) => r.id !== id)); if (openRace === id) setOpenRace(null); };

  const enrichEntity = async (type, name) => {
    const singular = { horses: "horse", jockeys: "jockey", trainers: "trainer", owners: "owner" }[type];
    const ai = await askForJSON(enrichPrompt(singular, name), true);
    if (ai.error) throw new Error(ai.error);
    const cur = entRef.current || entities;
    const next = { ...cur, [type]: { ...cur[type], [name]: { ai, updatedAt: new Date().toISOString() } } };
    entRef.current = next;      // synchronous — safe under parallel enrichment
    setEntities(next);
    await saveKey(K_ENT, next); // each write contains all prior merges, so last-write-wins converges
    return ai;
  };

  if (!races || !entities || !pink || !bets) {
    return (<div className="hrm" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <style>{css}</style><div className="mono" style={{ color: "var(--tote)" }}>LOADING THE BOARD…</div></div>);
  }

  const current = races.find((r) => r.id === openRace) || null;

  return (
    <div className="hrm">
      <style>{css}</style>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "26px 18px 60px" }}>
        {/* Masthead */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="mono" style={{ fontSize: 11, letterSpacing: ".28em", color: "var(--brass)" }}>SARATOGA HANDICAPPING DESK</div>
            <h1 className="disp" style={{ margin: "4px 0 0", fontSize: 42, fontWeight: 700, color: "var(--program)", letterSpacing: ".01em" }}>
              Trilly's Track
            </h1>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--toteDim)", textAlign: "right" }}>
            {races.length} RACES · {Object.keys(entities.horses).length} HORSES ON FILE<br />
            {races.filter((r) => r.results?.length).length} WITH OFFICIAL RESULTS
          </div>
        </div>
        <div className="hairline" style={{ margin: "14px 0 0" }} />

        {storageOk === false && (
          <div className="err" style={{ margin: "12px 0", fontWeight: 600 }}>
            ⚠ Storage isn't saving right now — anything you load or enter will vanish on refresh.
            The usual fix: this artifact needs to be <b>Published</b> (button at the bottom of the
            artifact panel) — persistent storage only activates after that. If it's already
            published, try reopening it from the Artifacts tab in your sidebar rather than a fresh copy.
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 22, margin: "10px 0 22px", flexWrap: "wrap" }}>
          {[["races", "Race Board"], ["bets", "My Bets"], ["perf", "Performance"], ["pink", "Pink Sheet"], ["horses", "Horses"], ["connections", "Connections"], ["h2h", "Head-to-Head"]].map(([k, label]) => (
            <button key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        {err && <div className="err" style={{ marginBottom: 16 }}>{err} <button className="btn3" style={{ marginLeft: 10 }} onClick={() => setErr(null)}>Dismiss</button></div>}

        {tab === "races" && (current
          ? <RaceView race={current} entities={entities} local={local}
              onBack={() => setOpenRace(null)} onUpdate={updateRace} onDelete={deleteRace}
              onEnrich={enrichEntity} setErr={setErr} tune={tune} />
          : <RaceBoard races={races} onOpen={(id) => setOpenRace(id)} onAdd={addRace} onBulk={addRacesBulk} onFetchAll={fetchAllResults} onLoadToday={loadTodayCard} autoMsg={autoMsg} onBackup={exportBackup} onRestore={restoreBackup} setErr={setErr} />)}
        {tab === "bets" && <BetsTab bets={bets} persistBets={persistBets} races={races} />}
        {tab === "perf" && <PerfTab races={races} entities={entities} local={local} tune={tune} />}
        {tab === "pink" && <PinkSheet pink={pink} persistPink={persistPink} setErr={setErr} />}
        {tab === "horses" && <EntityTable type="horses" entities={entities} local={local} onEnrich={enrichEntity} setErr={setErr} />}
        {tab === "connections" && <Connections entities={entities} local={local} onEnrich={enrichEntity} setErr={setErr} />}
        {tab === "h2h" && <H2H local={local} />}

        <div className="hairline" style={{ margin: "40px 0 10px" }} />
        <div className="mono" style={{ fontSize: 10.5, color: "var(--toteDim)" }}>
          MODEL PROBABILITIES ARE ESTIMATES, NOT GUARANTEES · PARIMUTUEL TAKEOUT RUNS 15–25% · BET RESPONSIBLY
        </div>
      </div>
    </div>
  );
}

/* ================= RACE BOARD ================= */
function RaceBoard({ races, onOpen, onAdd, onBulk, onFetchAll, onLoadToday, autoMsg, onBackup, onRestore, setErr }) {
  const [track, setTrack] = useState("Saratoga");
  const [date, setDate] = useState(localDate());
  const [num, setNum] = useState(1);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [resProg, setResProg] = useState(null);
  const [boardView, setBoardView] = useState("today");
  const [backupMode, setBackupMode] = useState(null); // null | "export" | "restore"
  const [backupText, setBackupText] = useState("");
  const [backupNote, setBackupNote] = useState(null);
  // Storage isn't reliably persisting right now (confirmed via the published link too),
  // so backup/restore is the actual save mechanism. Track changes since the last backup
  // and surface it — this is in-memory only (resets on refresh), which is fine: its whole
  // job is to catch you BEFORE you refresh and lose what you just loaded.
  const [dirty, setDirty] = useState(false);
  const prevLen = useRef(races.length);
  useEffect(() => {
    if (races.length !== prevLen.current) { setDirty(true); prevLen.current = races.length; }
  }, [races.length]);
  const todayStr = localDate();
  const dates = [...new Set(races.map((r) => r.date))].sort().reverse();
  const shown = races
    .filter((r) => boardView === "all" ? true : boardView === "today" ? r.date === todayStr : boardView === "open" ? !(r.results?.length) : r.date === boardView)
    .sort((a, b) => (a.date === b.date ? a.raceNumber - b.raceNumber : a.date < b.date ? 1 : -1));
  const openCount = races.filter((r) => !(r.results?.length) && r.date <= localDate()).length;

  const fetchAll = async () => {
    setErr(null); setResProg("Starting…");
    try {
      const { total, ok } = await onFetchAll((msg) => setResProg("Searching results: " + msg));
      setResProg(total === 0 ? "No open races to settle." : `Settled ${ok} of ${total} open races. Unsettled ones may not have run yet — try again after the card.`);
    } catch (e) { setErr("Results run failed: " + e.message); setResProg(null); return; }
    setTimeout(() => setResProg(null), 6000);
  };

  const pull = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await askForJSON(pullRacePrompt(track, date, num), true, true);
      if (j.error) throw new Error(j.error);
      await onAdd({
        track: j.track || track, date: j.date || date, raceNumber: j.raceNumber || num,
        surface: j.surface || "Dirt", distanceF: j.distanceFurlongs || null,
        condition: j.condition || "unknown", raceType: j.raceType || "", purse: j.purse || "",
        entries: (j.entries || []).map((e) => ({ post: e.post, horse: e.horse, jockey: e.jockey, trainer: e.trainer, owner: e.owner || "", ml: e.mlOdds || "", scratched: !!e.scratched })),
        results: null,
      });
    } catch (e) { setErr("Race pull failed: " + e.message + " — try again, or add the card manually below."); }
    setBusy(false);
  };

  return (
    <div className="fade">
      {dirty && (
        <div className="err" style={{ marginBottom: 14, fontWeight: 600 }}>
          ⚠ Data changed and isn't confirmed saved — built-in storage isn't reliably persisting
          right now. Tap <b>"Backup data"</b> below and copy the output somewhere safe before you
          close or refresh this tab, or you may lose what you just loaded.
        </div>
      )}
      <div className="card" style={{ padding: 18, marginBottom: 22 }}>
        <div className="disp" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Pull a race</div>
        <div className="note" style={{ marginBottom: 12 }}>Claude searches the web for the official entries — post positions, connections, morning line — and files everything into your database.</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={track} onChange={(e) => setTrack(e.target.value)} style={{ width: 170 }} placeholder="Track" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <span className="note">Race</span>
          <input type="number" min="1" max="14" value={num} onChange={(e) => setNum(+e.target.value)} style={{ width: 64 }} />
          <button className="btn" disabled={busy} onClick={pull}>{busy ? "Searching entries…" : "Pull race"}</button>
          <button className="btn3" onClick={() => setManual(!manual)}>{manual ? "Hide manual entry" : "Enter manually"}</button>
          <button className="btn3" onClick={() => setShowImport(!showImport)}>{showImport ? "Hide import" : "Import history (CSV)"}</button>
          <button className="btn2" onClick={() => onLoadToday?.(date)}>{date === todayStr ? "Load today's card" : `Load ${date} card`}</button>
          <button className="btn3" onClick={() => { setBackupNote(null); if (backupMode === "export") { setBackupMode(null); } else { setBackupText(onBackup?.() || ""); setBackupMode("export"); setDirty(false); } }}>{backupMode === "export" ? "Hide backup" : "Backup data"}</button>
          <button className="btn3" onClick={() => { setBackupNote(null); setBackupText(""); setBackupMode(backupMode === "restore" ? null : "restore"); }}>{backupMode === "restore" ? "Cancel restore" : "Restore backup"}</button>
          {openCount > 0 && (
            <button className="btn2" disabled={!!resProg} onClick={fetchAll}>
              {resProg ? "Settling…" : `Fetch all results (${openCount} open)`}
            </button>
          )}
        </div>
        {resProg && <div className="note" style={{ marginTop: 10, color: "var(--good)", fontWeight: 600 }}>{resProg}</div>}
        {autoMsg && <div className="note" style={{ marginTop: 10, color: "var(--brassD)", fontWeight: 600 }}>{autoMsg}</div>}
        {backupMode && (
          <div style={{ marginTop: 12 }}>
            <div className="note" style={{ marginBottom: 6 }}>
              {backupMode === "export"
                ? "Copy ALL of this and keep it somewhere safe (notes app, file). Paste it into any future version of the dashboard via Restore — races, entities, pink sheets and your bets ledger all come across."
                : "Paste a backup blob below and hit Restore. Everything merges — nothing already here gets deleted."}
            </div>
            <textarea value={backupText} onChange={(e) => setBackupText(e.target.value)} readOnly={backupMode === "export"}
              style={{ width: "100%", minHeight: 110, fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5 }}
              onFocus={(e) => backupMode === "export" && e.target.select()} />
            {backupMode === "restore" && (
              <button className="btn2" style={{ marginTop: 6 }} onClick={async () => {
                const res = await onRestore?.(backupText);
                setBackupNote(res?.error ? res.error : `Restored — ${res.races} races and ${res.bets} bets on file.`);
                if (res?.ok) { setBackupMode(null); setBackupText(""); }
              }}>Restore now</button>
            )}
            {backupNote && <div className="note" style={{ marginTop: 6, color: "var(--brassD)", fontWeight: 600 }}>{backupNote}</div>}
          </div>
        )}
        {manual && <ManualRace onAdd={onAdd} defaults={{ track, date, num }} />}
        {showImport && <CSVImport onBulk={onBulk} setErr={setErr} />}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span className="note">Showing</span>
        <select value={boardView} onChange={(e) => setBoardView(e.target.value)}>
          <option value="today">Today ({races.filter((r) => r.date === todayStr).length})</option>
          <option value="open">Open races ({races.filter((r) => !(r.results?.length)).length})</option>
          <option value="all">Everything ({races.length})</option>
          {dates.filter((d) => d !== todayStr).map((d) => <option key={d} value={d}>{d} ({races.filter((r) => r.date === d).length})</option>)}
        </select>
        {boardView === "today" && dates.some((d) => d !== todayStr) && <span className="note">History stays out of the way — pick a date here to revisit it.</span>}
      </div>
      {shown.length === 0 ? (
        <div className="totebar" style={{ padding: 30, textAlign: "center" }}>
          <div className="mono" style={{ color: "var(--tote)", fontSize: 13 }}>{boardView === "today" ? "NO RACES ON TODAY'S BOARD" : "NOTHING IN THIS VIEW"}</div>
          <div style={{ color: "#B9C7B4", fontSize: 13, marginTop: 6 }}>{boardView === "today" ? "The card loads automatically on racing days — or hit \"Load today's card\" above. Dark day? Browse a past date from the menu." : "Pick another view above, or pull a race."}</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {shown.map((r) => (
            <button key={r.id} onClick={() => onOpen(r.id)} className="card" style={{ padding: "14px 16px", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: "1px solid #D8CFB6" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{r.track} · Race {r.raceNumber} <span className="note" style={{ fontWeight: 500 }}>· {r.date}</span></div>
                <div className="note" style={{ marginTop: 3 }}>
                  {r.surface}{r.distanceF ? ` · ${r.distanceF}f` : ""} · {r.condition}{r.raceType ? ` · ${r.raceType}` : ""} · {(r.entries || []).filter((e) => !e.scratched).length} runners
                </div>
              </div>
              <div className="mono" style={{ fontSize: 11, color: r.results?.length ? "var(--good)" : "var(--brassD)", whiteSpace: "nowrap" }}>
                {r.results?.length ? "OFFICIAL ✓" : "OPEN"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ManualRace({ onAdd, defaults }) {
  const [surface, setSurface] = useState("Dirt");
  const [distanceF, setDist] = useState(6);
  const [condition, setCondition] = useState("Fast");
  const [rows, setRows] = useState([{ post: 1, horse: "", jockey: "", trainer: "", owner: "", ml: "" }]);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid #E4DCC5", paddingTop: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <select value={surface} onChange={(e) => setSurface(e.target.value)}><option>Dirt</option><option>Turf</option></select>
        <input type="number" step="0.5" value={distanceF} onChange={(e) => setDist(+e.target.value)} style={{ width: 90 }} title="Distance in furlongs" />
        <span className="note" style={{ alignSelf: "center" }}>furlongs</span>
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          {["Fast", "Wet-Fast", "Good", "Muddy", "Sloppy", "Firm", "Yielding", "Soft"].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          <input type="number" value={r.post} onChange={(e) => set(i, "post", +e.target.value)} style={{ width: 54 }} title="Post" />
          <input placeholder="Horse" value={r.horse} onChange={(e) => set(i, "horse", e.target.value)} style={{ flex: 1, minWidth: 130 }} />
          <input placeholder="Jockey" value={r.jockey} onChange={(e) => set(i, "jockey", e.target.value)} style={{ width: 130 }} />
          <input placeholder="Trainer" value={r.trainer} onChange={(e) => set(i, "trainer", e.target.value)} style={{ width: 130 }} />
          <input placeholder="Owner" value={r.owner} onChange={(e) => set(i, "owner", e.target.value)} style={{ width: 130 }} />
          <input placeholder="ML e.g. 5/2" value={r.ml} onChange={(e) => set(i, "ml", e.target.value)} style={{ width: 90 }} />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn3" onClick={() => setRows([...rows, { post: rows.length + 1, horse: "", jockey: "", trainer: "", owner: "", ml: "" }])}>+ Add runner</button>
        <button className="btn" onClick={() => onAdd({ track: defaults.track, date: defaults.date, raceNumber: defaults.num, surface, distanceF, condition, raceType: "", purse: "", entries: rows.filter((r) => r.horse.trim()), results: null })}>Save race</button>
      </div>
    </div>
  );
}

/* ================= CHART / ENTRIES PARSER =================
   Turns pasted Equibase/DRF/program text into {entries, finishOrder}.
   Deliberately forgiving: charts vary, so we extract what we can and report
   coverage rather than throwing. NEVER deletes — the caller merges, so a bad
   paste can only add/annotate, never wipe a good field. This exists because
   HRN-regressed dates (e.g. 7/4) seeded with short fields, and the AI pull
   dependency is unreliable; a manual paste is the durable backfill path. */
function parseChartText(raw) {
  const text = String(raw || "").replace(/\r/g, "");
  if (!text.trim()) return { entries: [], finishOrder: [], notes: ["Nothing pasted."] };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const notes = [];

  // ---- Finish order: look for a results/finish block ----
  // Equibase-style rows commonly start: "<fin> <pgm> <horse> ... " within a
  // section headed by "Fin" / "Last Raced" / "Pgm". We capture pgm→name pairs
  // in the order the rows appear (which is finish order).
  const finishOrder = [];
  const finishByPost = [];
  // A finish row: optional finish position, then a program number, then a name.
  // e.g. "1  6  Bow Draw  (L)  Ortiz, J ..."  or  "6  Bow Draw  Ortiz ..."
  const finishRow = /^(\d{1,2})?\s*[-.)]?\s*(\d{1,2}[A-Z]?)\s+([A-Z][A-Za-z'.\-() ]{2,40}?)\s{2,}/;
  let inFinish = false;
  for (const l of lines) {
    if (/\b(fin|finish|last raced|pgm|order of finish)\b/i.test(l) && /\bpgm|horse|jockey|fin\b/i.test(l)) { inFinish = true; continue; }
    if (inFinish) {
      const m = l.match(finishRow);
      if (m) { finishByPost.push(m[2].replace(/[A-Z]$/, "")); continue; }
      // blank-ish separator or a new section ends the finish block
      if (/^(fractional|split|times|run-up|trainers?:|owners?:|scratched|also ran)/i.test(l)) inFinish = false;
    }
  }

  // ---- Entries: post → horse / jockey / trainer / ML ----
  // Two common shapes:
  //  A) "1  Horse Name  Jockey Name  Trainer Name  5/2"
  //  B) program listing "PP Horse  J: Jockey  T: Trainer  ML 5/2"
  const entries = [];
  const seen = new Set();
  const oddsRe = /(\d{1,3}\/\d{1,2}|\d{1,3}-\d{1,2}|even|evs|\d{1,2}\/5)\b/i;
  for (const l of lines) {
    // skip obvious header/footer/times lines
    if (/^(fractional|split|times|run-up|copyright|equibase|drf|total|exacta|trifecta|superfecta|daily double|pick \d|scratched|also ran|weather|track:|off at|winner|payoff|mutuel)/i.test(l)) continue;
    // Leading program number
    const pm = l.match(/^(\d{1,2})[A-Z]?\s+(.+)$/);
    if (!pm) continue;
    const post = +pm[1];
    if (!post || post > 20) continue;
    let rest = pm[2];
    // Pull ML odds if present (last odds-looking token)
    let ml = "";
    const oddsMatches = [...rest.matchAll(/(\d{1,3}\/\d{1,2}|\d{1,3}-\d{1,2}|even|evs)\b/gi)];
    if (oddsMatches.length) { ml = oddsMatches[oddsMatches.length - 1][1].replace("-", "/"); }
    // J:/T: labelled form
    let horse = "", jockey = "", trainer = "";
    const jt = rest.match(/^(.+?)\s+J:\s*(.+?)\s+T:\s*(.+?)(?:\s+(?:ML\s*)?[\d/]+.*)?$/i);
    if (jt) { horse = jt[1]; jockey = jt[2]; trainer = jt[3]; }
    else {
      // Column form: split on runs of 2+ spaces
      const cols = rest.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
      horse = cols[0] || "";
      jockey = cols[1] || "";
      trainer = cols[2] || "";
      // strip trailing odds token from any column
      horse = horse.replace(oddsRe, "").trim();
      jockey = jockey.replace(oddsRe, "").trim();
      trainer = trainer.replace(oddsRe, "").trim();
    }
    horse = horse.replace(/\s+\(L\)|\s+\(L1\)|\s+\(b\)|\s+\(bl\)/gi, "").replace(/\s{2,}/g, " ").trim();
    if (!horse || horse.length < 2) continue;
    const key = post + "|" + horse.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ post, horse, jockey, trainer, owner: "", ml, scratched: false });
  }

  // Resolve finish (posts) into horse names using parsed entries when possible
  const byPost = {};
  for (const e of entries) byPost[String(e.post)] = e.horse;
  for (const p of finishByPost) finishOrder.push(byPost[p] || `#${p}`);

  if (!entries.length) notes.push("No entries recognized — paste the entries/past-performance block or the results chart. Column charts (post, horse, jockey, trainer) parse best.");
  if (finishByPost.length && finishOrder.some((n) => n.startsWith("#"))) notes.push("Some finishers couldn't be matched to a horse name (shown as #post). Add the entries first, then re-parse for names.");
  return { entries, finishOrder, notes };
}

/* ================= RACE VIEW / ANALYZER ================= */
function RaceView({ race, entities, local, onBack, onUpdate, onDelete, onEnrich, setErr, tune }) {
  const [busyKey, setBusyKey] = useState(null);
  const [enrichProg, setEnrichProg] = useState(null);
  const [resultText, setResultText] = useState("");
  const [oddsBusy, setOddsBusy] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [chartText, setChartText] = useState("");
  const [chartPreview, setChartPreview] = useState(null); // {entries, finishOrder, notes}
  const [chartSetResults, setChartSetResults] = useState(true);
  const hasLive = (race.entries || []).some((e) => e.liveOdds);
  const pullLive = async () => {
    setOddsBusy(true);
    try {
      const j = await askForJSON(liveOddsPrompt(race), true, true);
      if (j && !j.error && j.odds && Object.keys(j.odds).length) {
        onUpdate({ ...race, entries: race.entries.map((e) => (j.odds[String(e.post)] ? { ...e, liveOdds: String(j.odds[String(e.post)]) } : e)) });
      } else setErr(j?.error === "not posted" ? "Live odds aren't posted yet — try closer to post time." : (j?.error || "No live odds found."));
    } catch (er) { setErr("Live odds pull failed: " + er.message); }
    setOddsBusy(false);
  };
  const analysis = useMemo(() => analyzeRace(race, entities, local, tune?.marketW), [race, entities, local, tune]);

  const setField = (k, v) => onUpdate({ ...race, [k]: v });
  const toggleScratch = (i) => onUpdate({ ...race, entries: race.entries.map((e, j) => (j === i ? { ...e, scratched: !e.scratched } : e)) });
  const setML = (i, v) => onUpdate({ ...race, entries: race.entries.map((e, j) => (j === i ? { ...e, ml: v } : e)) });

  const enrichAll = async () => {
    setErr(null);
    const jobs = [];
    for (const e of race.entries.filter((x) => !x.scratched)) {
      if (e.horse && !entities.horses[e.horse]?.ai) jobs.push(["horses", e.horse]);
      if (e.jockey && !entities.jockeys[e.jockey]?.ai) jobs.push(["jockeys", e.jockey]);
      if (e.trainer && !entities.trainers[e.trainer]?.ai) jobs.push(["trainers", e.trainer]);
      if (e.owner && !entities.owners[e.owner]?.ai) jobs.push(["owners", e.owner]);
    }
    if (!jobs.length) { setEnrichProg("Everything on this card is already enriched."); setTimeout(() => setEnrichProg(null), 2500); return; }
    const CONC = 2;
    let done = 0, cursor = 0, failCount = 0, lastErr = null;
    setEnrichProg(`Researching ${jobs.length} names, ${Math.min(CONC, jobs.length)} at a time…`);
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try { await onEnrich(job[0], job[1]); }
        catch (e) { failCount++; lastErr = e?.message || String(e); console.warn("enrich failed", job[1], e); }
        done++;
        setEnrichProg(`Researching card — ${done}/${jobs.length} done…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
    setEnrichProg(null);
    if (failCount > 0) {
      setErr(`Enrichment failed on ${failCount} of ${jobs.length} name${jobs.length > 1 ? "s" : ""}: ${lastErr}`);
    }
  };

  const fetchResults = async () => {
    setBusyKey("results"); setErr(null);
    try {
      const j = await askForJSON(resultsPrompt(race), true, true);
      if (j.error) throw new Error(j.error);
      onUpdate({ ...race, results: j.finishOrder, resultsMeta: { partial: !!j.partial, source: j.source || null } });
    } catch (e) { setErr("Results fetch failed: " + e.message); }
    setBusyKey(null);
  };
  const saveManualResults = () => {
    const names = resultText.split(",").map((s) => s.trim()).filter(Boolean).map((tok) => {
      const byPost = race.entries.find((e) => String(e.post) === tok);
      return byPost ? byPost.horse : tok;
    });
    if (names.length >= 2) { onUpdate({ ...race, results: names }); setResultText(""); }
  };

  const previewChart = () => setChartPreview(parseChartText(chartText));
  const applyChart = () => {
    const p = chartPreview || parseChartText(chartText);
    // Merge entries by post: keep existing, add missing, fill blank fields only.
    // Never remove an existing entry — a bad paste can only add or annotate.
    const byPost = {};
    for (const e of race.entries) byPost[String(e.post)] = { ...e };
    for (const ne of p.entries) {
      const k = String(ne.post);
      if (!byPost[k]) { byPost[k] = ne; }
      else {
        const cur = byPost[k];
        // fill only when the current value is empty, so hand-verified data wins
        if (!cur.horse && ne.horse) cur.horse = ne.horse;
        if (!cur.jockey && ne.jockey) cur.jockey = ne.jockey;
        if (!cur.trainer && ne.trainer) cur.trainer = ne.trainer;
        if (!cur.ml && ne.ml) cur.ml = ne.ml;
      }
    }
    const mergedEntries = Object.values(byPost).sort((a, b) => a.post - b.post);
    const next = { ...race, entries: mergedEntries };
    if (chartSetResults && p.finishOrder.length >= 2 && !p.finishOrder.some((n) => n.startsWith("#"))) {
      next.results = p.finishOrder;
      next.resultsMeta = { partial: false, source: "pasted chart" };
    }
    onUpdate(next);
    setChartText(""); setChartPreview(null); setChartOpen(false);
  };

  const factorNote = (v) => (v == null ? "—" : fmtPct(v));

  return (
    <div className="fade">
      <button className="btn2" onClick={onBack} style={{ marginBottom: 14 }}>← Race board</button>

      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>{race.track} · Race {race.raceNumber}</div>
            <div className="note" style={{ marginTop: 3 }}>{race.date}{race.raceType ? ` · ${race.raceType}` : ""}{race.purse ? ` · ${race.purse}` : ""}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={race.surface} onChange={(e) => setField("surface", e.target.value)}><option>Dirt</option><option>Turf</option></select>
            <input type="number" step="0.5" value={race.distanceF || ""} onChange={(e) => setField("distanceF", +e.target.value)} style={{ width: 74 }} title="Furlongs" />
            <select value={race.condition} onChange={(e) => setField("condition", e.target.value)}>
              {["Fast", "Wet-Fast", "Good", "Muddy", "Sloppy", "Firm", "Yielding", "Soft", "unknown"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0 6px" }}>
          <button className="btn2" onClick={enrichAll} disabled={!!enrichProg}>{enrichProg ? enrichProg : "Enrich card (AI research)"}</button>
          <button className="btn2" onClick={pullLive} disabled={oddsBusy} title="Pulls current win-pool odds ~10 min to post; the model uses them instead of the morning line">{oddsBusy ? "Pulling live odds…" : hasLive ? "Live odds ✓ (refresh)" : "Live odds"}</button>
          <button className="btn2" onClick={fetchResults} disabled={busyKey === "results"}>{busyKey === "results" ? "Searching results…" : "Fetch official results"}</button>
          <button className="btn2" onClick={() => { setChartOpen((v) => !v); setChartPreview(null); }} title="Paste an Equibase/DRF chart or entries block to add missing horses and set the finish — no AI call needed">{chartOpen ? "Close chart paste" : "Paste chart / entries"}</button>
          <button className="btn3" onClick={() => onDelete(race.id)}>Delete race</button>
        </div>
        <div className="note">Enrichment researches each horse, jockey, trainer and owner once and saves the stats to your database. Adjust condition and ML odds anytime — the model re-runs instantly. Click a post number to scratch.</div>

        {chartOpen && (
          <div className="card" style={{ padding: 14, marginTop: 12, background: "#F3E9CE", borderColor: "var(--brassD)" }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <b>Paste a chart or entries block.</b> Fills in missing horses (fixes short/regressed fields) and, if the chart has a finish, sets the result. Merges by post — it never deletes an entry, and hand-verified fields win over the paste. Column layouts (post · horse · jockey · trainer · ML) parse best.
            </div>
            <textarea value={chartText} onChange={(e) => setChartText(e.target.value)} placeholder={"Paste Equibase/DRF chart text or the entries list here…\ne.g.\n1  Lightning Strike   Franco, M   Clement, M   9/5\n2  Graceful Rose      Santana, R   Gorham, M    15/1"} style={{ width: "100%", minHeight: 130, fontFamily: "IBM Plex Mono, monospace", fontSize: 11.5 }} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
              <button className="btn2" onClick={previewChart} disabled={!chartText.trim()}>Preview parse</button>
              <button className="btn" onClick={applyChart} disabled={!chartPreview || !chartPreview.entries.length}>Apply to race</button>
              <label className="note" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={chartSetResults} onChange={(e) => setChartSetResults(e.target.checked)} /> also set finish order if present
              </label>
            </div>
            {chartPreview && (
              <div style={{ marginTop: 10 }}>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--brassD)", letterSpacing: ".15em", marginBottom: 6 }}>
                  PARSED {chartPreview.entries.length} ENTR{chartPreview.entries.length === 1 ? "Y" : "IES"}{chartPreview.finishOrder.length ? ` · ${chartPreview.finishOrder.length}-DEEP FINISH` : ""}
                </div>
                {chartPreview.entries.length > 0 && (
                  <div style={{ overflowX: "auto" }}>
                    <table><thead><tr><th>PP</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>ML</th><th></th></tr></thead>
                    <tbody>
                      {chartPreview.entries.map((e, i) => {
                        const exists = race.entries.some((x) => String(x.post) === String(e.post));
                        return (<tr key={i}><td><Chip post={e.post} /></td><td style={{ fontWeight: 600 }}>{e.horse}</td><td className="note">{e.jockey || "—"}</td><td className="note">{e.trainer || "—"}</td><td className="mono">{e.ml || "—"}</td><td className="mono" style={{ fontSize: 10, color: exists ? "var(--toteDim)" : "var(--good)" }}>{exists ? "on card" : "NEW"}</td></tr>);
                      })}
                    </tbody></table>
                  </div>
                )}
                {chartPreview.finishOrder.length > 0 && (
                  <div className="note" style={{ marginTop: 8 }}>Finish: {chartPreview.finishOrder.map((n, i) => `${i + 1}. ${n}`).join("  ·  ")}</div>
                )}
                {chartPreview.notes.map((n, i) => <div key={i} className="note" style={{ marginTop: 6, color: "var(--brassD)" }}>⚠ {n}</div>)}
              </div>
            )}
          </div>
        )}
      </div>

      {analysis && !analysis.dataRich && (
        <div className="note" style={{ margin: "12px 0", padding: "10px 12px", border: "1px solid var(--brassD)", borderRadius: 6, color: "var(--brassD)", fontWeight: 600 }}>
          ⚠ Sparse data this race — no form, figures, pace, or splits for enough of the
          field to trust. The model is leaning almost entirely on market odds rather than
          its own factors, on purpose. Win% here should track close to fair odds; treat any
          horse showing well above its morning line with real skepticism.
        </div>
      )}

      {/* Projected order tote strip */}
      {analysis && (
        <div className="totebar" style={{ padding: "14px 16px", margin: "16px 0" }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".22em", color: "var(--toteDim)", marginBottom: 10 }}>
            PROJECTED ORDER OF FINISH · {analysis.bucket ? analysis.bucket.toUpperCase() : ""} {race.surface?.toUpperCase()}{analysis.off ? " · OFF TRACK" : ""}
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {analysis.proj.map((r, i) => (
              <div key={r.e.post} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ color: "var(--tote)", fontSize: 15, width: 26 }}>{i + 1}{["st", "nd", "rd"][i] || "th"}</span>
                <Chip post={r.e.post} />
                <div>
                  <div style={{ color: "#EDE6D2", fontSize: 13.5, fontWeight: 600 }}>{r.e.horse}</div>
                  <div className="mono" style={{ color: "var(--toteDim)", fontSize: 10.5 }}>WIN {fmtPct(r.win)} · FAIR {probToOdds(r.win)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Model grade vs actual result */}
      {analysis && race.results?.length > 0 && (() => {
        const find = (n) => analysis.rows.find((x) => x.e.horse.toLowerCase() === String(n || "").toLowerCase());
        const wRow = find(race.results[0]);
        if (!wRow) return null;
        const rank = analysis.proj.indexOf(wRow) + 1;
        const sRow = race.results[1] ? find(race.results[1]) : null;
        const exHit = rank === 1 && sRow && analysis.proj[1] === sRow;
        return (
          <div className="totebar" style={{ padding: "10px 16px", marginBottom: 14, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".2em", color: "var(--toteDim)" }}>MODEL GRADE</span>
            <span style={{ color: rank === 1 ? "#7FD49A" : "#EDE6D2", fontSize: 13, fontWeight: 600 }}>
              {rank === 1 ? "✓ Called the winner" : `Winner was the model's #${rank} choice`} — {race.results[0]} at {fmtPct(wRow.win)}
            </span>
            {race.results[1] && <span className="mono" style={{ fontSize: 11, color: exHit ? "#7FD49A" : "var(--toteDim)" }}>{exHit ? "✓ EXACTA ON TOP" : "EXACTA MISSED"}</span>}
            <span className="mono" style={{ fontSize: 10.5, color: "var(--toteDim)", marginLeft: "auto" }}>FEEDS THE PERFORMANCE TAB</span>
          </div>
        );
      })()}

      {/* Entry table */}
      {analysis && race.entries.filter((e) => !e.scratched && !entities.horses[e.horse]?.ai).length > 0 && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 10, background: "#F3E9CE", borderColor: "var(--brassD)" }}>
          <span style={{ fontSize: 13 }}>
            <b>Form, Surf and Dist are blank because this card hasn't been researched yet.</b> A race pull only grabs the entries and morning line — hit <b>"Enrich card (AI research)"</b> above and each horse's recent finishes, speed figures, run style, surface record and distance record get filled in (and the model stops leaning on defaults for Jky% / Trn% too).
          </span>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead><tr>
            <th>PP</th><th>Horse / Connections</th><th>ML</th><th>Win</th><th></th><th>Place</th><th>Show</th>
            <th title="Jockey win rate (AI-researched + your logged results)">Jky%</th>
            <th title="Trainer win rate (AI-researched + your logged results)">Trn%</th>
            <th title="Recent form: weighted average of last 5 finishes (1.00 = winning every start)">Form</th>
            <th title="Horse's win rate on THIS race's surface (dirt or turf)">Surf</th>
            <th title="Horse's win rate at this distance type (sprint <8f / route 8f+)">Dist</th>
            <th title="Head-to-head edge vs today's field, from your logged results (−1 to +1)">H2H</th>
            <th title="Avg of last 3 speed figures vs field average, in figure points (needs enrichment)">Fig</th>
            <th title="Run style (E/EP/P/S) and pace-shape fit for today's projected race shape">Pace</th>
            <th title="Class move vs last 2 logged starts: + dropping, − rising">Cls</th>
          </tr></thead>
          <tbody>
            {race.entries.map((e, i) => {
              const row = analysis?.rows.find((r) => r.e === e);
              return (
                <tr key={i} style={e.scratched ? { opacity: 0.4, textDecoration: "line-through" } : {}}>
                  <td><button onClick={() => toggleScratch(i)} title={e.scratched ? "Un-scratch" : "Scratch"} style={{ background: "none", border: "none", padding: 0 }}><Chip post={e.post} /></button></td>
                  <td>
                    <div style={{ fontWeight: 700 }}>{e.horse}{entities.horses[e.horse]?.ai?.note ? <span className="note" style={{ fontWeight: 400 }}> — {entities.horses[e.horse].ai.note}</span> : null}</div>
                    <div className="note">J: {e.jockey || "—"} · T: {e.trainer || "—"}{e.owner ? ` · O: ${e.owner}` : ""}</div>
                    {(e.jWinPct != null || e.tWinPct != null || e.oWinPct != null) && (
                      <div className="mono note" style={{ fontSize: 10, color: "var(--toteDim)" }}>
                        MEET{e.jWinPct != null ? ` · Jky ${e.jWinPct}% (${e.jWins ?? "?"}/${e.jStarts ?? "?"})` : ""}{e.tWinPct != null ? ` · Trn ${e.tWinPct}% (${e.tWins ?? "?"}/${e.tStarts ?? "?"})` : ""}{e.oWinPct != null ? ` · Own ${e.oWinPct}%` : ""}
                      </div>
                    )}
                    {(e.med || e.weight || e.age || e.sex) && (
                      <div className="mono note" style={{ fontSize: 10, color: "var(--toteDim)" }}>
                        {[e.med, e.weight ? `${e.weight} lbs` : "", [e.age, e.sex].filter(Boolean).join("")].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td><input value={e.ml || ""} onChange={(ev) => setML(i, ev.target.value)} style={{ width: 62, padding: "4px 6px", fontSize: 12.5 }} className="mono" /></td>
                  <td className="mono" style={{ fontWeight: 600, color: "var(--silks)" }}>{row ? fmtPct(row.win) : "—"}</td>
                  <td style={{ minWidth: 70 }}>{row ? <Bar p={row.win} /> : null}</td>
                  <td className="mono">{row ? fmtPct(row.place) : "—"}</td>
                  <td className="mono">{row ? fmtPct(row.show) : "—"}</td>
                  <td className="mono note">{row ? fmtPct(row.jP) : "—"}</td>
                  <td className="mono note">{row ? fmtPct(row.tP) : "—"}</td>
                  <td className="mono note">{row?.form != null ? (row.form).toFixed(2) : "—"}</td>
                  <td className="mono note">{factorNote(row?.surf)}</td>
                  <td className="mono note">{factorNote(row?.dist)}</td>
                  <td className="mono note">{row?.h2h != null ? (row.h2h > 0 ? "+" : "") + row.h2h.toFixed(2) : "—"}</td>
                  <td className="mono note">{row?.fig != null ? (row.fig > 0 ? "+" : "") + (row.fig * 12).toFixed(0) : "—"}</td>
                  <td className="mono note">{row?.style ? row.style + (row.pace != null ? " " + (row.pace > 0 ? "+" : "") + row.pace.toFixed(1) : "") : "—"}</td>
                  <td className="mono note">{row?.clsMove != null ? (row.clsMove > 0 ? "+" : "") + row.clsMove.toFixed(1) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Exotics */}
      {analysis && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 12, marginTop: 16 }}>
          {[["Top exactas", analysis.exactas], ["Top trifectas", analysis.trifectas], ["Top superfectas", analysis.superfectas || []]].map(([label, list]) => (
            list.length > 0 && (
            <div key={label} className="card" style={{ padding: 14 }}>
              <div className="disp" style={{ fontWeight: 600, marginBottom: 8 }}>{label}</div>
              {list.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  {c.combo.map((e, j) => (<span key={j} style={{ display: "flex", alignItems: "center", gap: 6 }}>{j > 0 && <span className="note">→</span>}<Chip post={e.post} /></span>))}
                  <span className="mono" style={{ marginLeft: "auto", fontSize: 12.5 }}>{fmtPct(c.p)}</span>
                </div>
              ))}
            </div>
            )
          ))}
        </div>
      )}

      {/* Results */}
      <div className="card" style={{ padding: 16, marginTop: 16 }}>
        <div className="disp" style={{ fontWeight: 600, marginBottom: 6 }}>Official result</div>
        {race.results?.length ? (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            {race.results.map((name, i) => {
              const ent = race.entries.find((e) => e.horse.toLowerCase() === name.toLowerCase());
              return (<span key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="mono note">{i + 1}.</span>{ent ? <Chip post={ent.post} /> : null}<span style={{ fontWeight: 600 }}>{name}</span>
              </span>);
            })}
            <button className="btn3" onClick={() => setField("results", null)}>Clear</button>
            {race.resultsMeta?.partial && <span className="mono" style={{ fontSize: 10.5, color: "var(--brassD)" }}>PARTIAL — TOP {race.results.length} ONLY</span>}
            {race.resultsMeta?.source && <span className="note" style={{ fontSize: 11 }}>via {race.resultsMeta.source}</span>}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="Finish order — posts or names, e.g. 4, 7, 1, 2" value={resultText} onChange={(e) => setResultText(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
            <button className="btn3" onClick={saveManualResults}>Save result</button>
          </div>
        )}
        <div className="note" style={{ marginTop: 8 }}>Saved results feed every horse, jockey, trainer and owner record — and the head-to-head index — automatically.</div>
      </div>
    </div>
  );
}

/* ================= ENTITY TABLES ================= */
function EntityTable({ type, entities, local, onEnrich, setErr }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);
  const names = Object.keys(entities[type] || {}).sort();
  const filtered = names.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
  const label = { horses: "Horses", jockeys: "Jockeys", trainers: "Trainers", owners: "Owners" }[type];

  const enrich = async (name) => {
    setBusy(name); setErr(null);
    try { await onEnrich(type, name); } catch (e) { setErr(`Research on ${name} failed: ${e.message}`); }
    setBusy(null);
  };

  return (
    <div className="fade">
      <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--toteDim)" }}>{filtered.length} ON FILE</span>
      </div>
      {filtered.length === 0 ? (
        <div className="totebar" style={{ padding: 24, textAlign: "center", color: "#B9C7B4", fontSize: 13 }}>
          {names.length === 0 ? `No ${label.toLowerCase()} yet — every race you pull files its ${label.toLowerCase()} here automatically.` : "No matches."}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table>
            <thead><tr><th>{label.slice(0, -1)}</th><th>Career (AI)</th><th>Win%</th><th>Local record</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {filtered.map((n) => {
                const ai = entities[type][n]?.ai;
                const loc = local[type]?.[n];
                return (
                  <tr key={n}>
                    <td style={{ fontWeight: 700 }}>{n}</td>
                    <td className="mono note">{ai?.starts != null ? `${ai.starts}: ${ai.wins ?? "?"}-${ai.places ?? "?"}-${ai.shows ?? "?"}` : "—"}</td>
                    <td className="mono">{ai?.winPct != null ? ai.winPct + "%" : "—"}</td>
                    <td className="mono note">{loc ? `${loc.starts} starts · ${loc.wins} W · ${loc.top3} top-3` : "—"}</td>
                    <td className="note" style={{ maxWidth: 260 }}>{ai?.note || ""}</td>
                    <td><button className="btn3" disabled={busy === n} onClick={() => enrich(n)}>{busy === n ? "Researching…" : ai ? "Refresh" : "Research"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================= HISTORICAL CSV IMPORT ================= */
const CSV_COLS = ["date", "track", "race", "surface", "distance_f", "condition", "post", "horse", "jockey", "trainer", "owner", "finish", "ml"];
function CSVImport({ onBulk, setErr }) {
  const [status, setStatus] = useState(null);

  const ingest = async (text) => {
    try {
      const rows = parseCSV(text);
      if (rows.length < 2) throw new Error("No data rows found.");
      const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
      // Column resolver with aliases so BOTH the standard schema and the rich NYRA export
      // (race_date, race_number, program_number, morning_line, *_meet_* stats) import cleanly.
      const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
      const cell = (r, i) => (i === -1 ? "" : (r[i] || "").trim());
      const numOrNull = (v) => { const x = parseFloat(v); return isFinite(x) ? x : null; };
      const purseFmt = (v) => { const s = String(v || "").trim(); return /^\d+$/.test(s) ? "$" + Number(s).toLocaleString() : s; };
      const I = {
        date: idx("date", "race_date"), track: idx("track"), race: idx("race", "race_number"),
        horse: idx("horse"), post: idx("post", "program_number"), jockey: idx("jockey"),
        trainer: idx("trainer"), owner: idx("owner"), ml: idx("ml", "morning_line"), finish: idx("finish", "finish_position"),
        surface: idx("surface"), distF: idx("distance_f"), distS: idx("distance"), cond: idx("condition", "track_condition"),
        type: idx("race_type", "race_class"), purse: idx("purse", "purse_usd"), name: idx("race_name"), postT: idx("post_time_et", "post_time"),
        med: idx("medication_equipment"), wt: idx("weight_lbs", "weight"), age: idx("age"), sex: idx("sex"),
        js: idx("jockey_meet_starts"), jw: idx("jockey_meet_wins"), jwp: idx("jockey_meet_win_pct"), jt3: idx("jockey_meet_top3_pct"),
        ts: idx("trainer_meet_starts"), tw: idx("trainer_meet_wins"), twp: idx("trainer_meet_win_pct"), tt3: idx("trainer_meet_top3_pct"),
        os: idx("owner_meet_starts"), ow: idx("owner_meet_wins"), owp: idx("owner_meet_win_pct"), ot3: idx("owner_meet_top3_pct"),
        asOf: idx("stats_as_of"), srcE: idx("entries_source_url"), srcS: idx("stats_source_url"), ret: idx("retrieved_at"),
      };
      for (const [lbl, i] of [["date/race_date", I.date], ["track", I.track], ["race/race_number", I.race], ["horse", I.horse]]) {
        if (i === -1) throw new Error(`Missing required column "${lbl}". Need at least date, track, race, horse (finish optional). Standard header: ${CSV_COLS.join(",")}`);
      }
      let statLines = 0;
      const byRace = {};
      for (const r of rows.slice(1)) {
        const track = cell(r, I.track), date = cell(r, I.date), raceNo = cell(r, I.race);
        if (!track || !date || !raceNo) continue;
        const key = `${track}|${date}|${raceNo}`;
        byRace[key] = byRace[key] || {
          id: `${track}-${date}-R${raceNo}-import`,
          track, date, raceNumber: +raceNo,
          surface: cell(r, I.surface) || "Dirt",
          distanceF: (numOrNull(cell(r, I.distF)) != null ? numOrNull(cell(r, I.distF)) : parseDistanceF(cell(r, I.distS))),
          condition: cell(r, I.cond) || "unknown",
          raceType: cell(r, I.type) || "", purse: purseFmt(cell(r, I.purse)),
          raceName: cell(r, I.name) || null, postTime: cell(r, I.postT) || null,
          statsAsOf: cell(r, I.asOf) || null, sourceEntries: cell(r, I.srcE) || null,
          sourceStats: cell(r, I.srcS) || null, retrievedAt: cell(r, I.ret) || null,
          entries: [], _fins: [],
        };
        const race = byRace[key];
        const entry = {
          post: +cell(r, I.post) || race.entries.length + 1, horse: cell(r, I.horse),
          jockey: cell(r, I.jockey), trainer: cell(r, I.trainer), owner: cell(r, I.owner),
          ml: cell(r, I.ml), scratched: false,
        };
        // Official meet stats (drive the connF factor + RaceView display). Store only when present.
        if (numOrNull(cell(r, I.js)) != null || numOrNull(cell(r, I.jw)) != null || numOrNull(cell(r, I.jwp)) != null) {
          entry.jStarts = numOrNull(cell(r, I.js)); entry.jWins = numOrNull(cell(r, I.jw)); entry.jWinPct = numOrNull(cell(r, I.jwp)); entry.jTop3Pct = numOrNull(cell(r, I.jt3)); statLines++;
        }
        if (numOrNull(cell(r, I.ts)) != null || numOrNull(cell(r, I.tw)) != null || numOrNull(cell(r, I.twp)) != null) {
          entry.tStarts = numOrNull(cell(r, I.ts)); entry.tWins = numOrNull(cell(r, I.tw)); entry.tWinPct = numOrNull(cell(r, I.twp)); entry.tTop3Pct = numOrNull(cell(r, I.tt3));
        }
        if (numOrNull(cell(r, I.os)) != null || numOrNull(cell(r, I.ow)) != null || numOrNull(cell(r, I.owp)) != null) {
          entry.oStarts = numOrNull(cell(r, I.os)); entry.oWins = numOrNull(cell(r, I.ow)); entry.oWinPct = numOrNull(cell(r, I.owp)); entry.oTop3Pct = numOrNull(cell(r, I.ot3));
        }
        const med = cell(r, I.med); if (med) entry.med = med;
        const wt = cell(r, I.wt); if (wt) entry.weight = wt;
        const age = cell(r, I.age); if (age) entry.age = age;
        const sex = cell(r, I.sex); if (sex) entry.sex = sex;
        race.entries.push(entry);
        race._fins.push({ horse: entry.horse, fin: (I.finish !== -1 ? (+cell(r, I.finish) || 999) : 999) });
      }
      const list = Object.values(byRace).map((r) => {
        const results = r._fins.filter((f) => f.fin < 999).sort((a, b) => a.fin - b.fin).map((f) => f.horse);
        const { _fins, ...clean } = r;
        return { ...clean, results: results.length >= 2 ? results : null };
      });
      const n = await onBulk(list);
      setStatus(`Imported ${n} races (${rows.length - 1} runner lines${statLines ? `, ${statLines} with official meet stats` : ""}). Every horse, jockey, trainer, owner and rivalry is now on file.`);
    } catch (e) { setErr("Import failed: " + e.message); }
  };

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid #E4DCC5", paddingTop: 12 }}>
      <div className="note" style={{ marginBottom: 8 }}>
        Bulk-load purchased/exported history or an upcoming card. One row per runner, header row required:
        <span className="mono" style={{ display: "block", marginTop: 4, fontSize: 11, background: "#EFE7D2", padding: "6px 8px", borderRadius: 4 }}>{CSV_COLS.join(",")}</span>
        <span style={{ display: "block", marginTop: 4 }}>Required: date, track, race, horse (finish optional — leave blank for upcoming cards). Also accepts the NYRA export directly (race_date, race_number, program_number, morning_line, distance like "5 1/2F", and jockey/trainer/owner meet stats) — official win% feeds the Connections (meet) factor. Races with finishes auto-populate results, records, and the head-to-head index.</span>
      </div>
      <input type="file" accept=".csv,.txt" onChange={(e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const rd = new FileReader(); rd.onload = () => ingest(String(rd.result)); rd.readAsText(f);
      }} />
      {status && <div className="note" style={{ marginTop: 8, color: "var(--good)", fontWeight: 600 }}>{status}</div>}
    </div>
  );
}

/* ================= PINK SHEET ================= */
function PinkSheet({ pink, persistPink, setErr }) {
  const [date, setDate] = useState(localDate());
  const [busy, setBusy] = useState(false);
  const [srcFilter, setSrcFilter] = useState("All sources");
  const dates = Object.keys(pink).sort().reverse();
  const [open, setOpen] = useState(dates[0] || null);
  const day = open ? pink[open] : null;
  const sources = day ? ["All sources", ...Array.from(new Set((day.handicappers || []).map((h) => h.source).filter(Boolean)))] : [];
  const shownCappers = (day?.handicappers || []).filter((h) => srcFilter === "All sources" || h.source === srcFilter);

  const pull = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await askForJSON(pinkPrompt(date), true, true);
      if (j.error) throw new Error(j.error);
      const next = { ...pink, [date]: { ...j, pulledAt: new Date().toISOString() } };
      await persistPink(next);
      setOpen(date);
    } catch (e) { setErr("Pick pull failed: " + e.message + " — hit Pull again to retry. (Also note Saratoga is dark Mon–Wed early in the 2026 meet, Mon–Tue after July 29.)"); }
    setBusy(false);
  };

  return (
    <div className="fade">
      <div className="card" style={{ padding: 18, marginBottom: 18 }}>
        <div className="disp" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>The Pink Sheet &amp; Free Picks</div>
        <div className="note" style={{ marginBottom: 12 }}>
          Pulls every free, publicly posted set of Saratoga selections it can find for a race day — the Saratogian Pink Sheet, Times Union, NY Post, Daily Gazette, Horse Racing Nation, America's Best Racing, NYRA analysts, and more. Each handicapper is listed with their outlet, published record, and strongest picks, plus a consensus top 10 across all sources. Coverage varies by what's posted online each day.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn" disabled={busy} onClick={pull}>{busy ? "Searching all sources…" : "Pull picks"}</button>
          {sources.length > 2 && (
            <select value={srcFilter} onChange={(e) => setSrcFilter(e.target.value)}>
              {sources.map((s) => <option key={s}>{s}</option>)}
            </select>
          )}
          {dates.length > 0 && (
            <select value={open || ""} onChange={(e) => setOpen(e.target.value)} style={{ marginLeft: "auto" }}>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
      </div>

      {!day ? (
        <div className="totebar" style={{ padding: 26, textAlign: "center", color: "#B9C7B4", fontSize: 13 }}>
          No sheets saved yet. Pull a race day above — during the Saratoga meet the sheet publishes daily.
        </div>
      ) : (
        <div>
          {/* Consensus top 10 */}
          {day.top10?.length > 0 && (
            <div className="totebar" style={{ padding: "14px 16px", marginBottom: 16 }}>
              <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".22em", color: "var(--toteDim)", marginBottom: 10 }}>
                CONSENSUS TOP 10 · {day.date}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 10 }}>
                {day.top10.slice(0, 10).map((p) => (
                  <div key={p.rank} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                    <span className="mono" style={{ color: "var(--tote)", fontSize: 16, minWidth: 22 }}>{p.rank}</span>
                    <div>
                      <div style={{ color: "#EDE6D2", fontWeight: 600, fontSize: 13.5 }}>{p.horse} <span className="mono" style={{ color: "var(--toteDim)", fontSize: 11 }}>R{p.race}</span></div>
                      {p.pickedBy?.length ? <div className="mono" style={{ color: "var(--toteDim)", fontSize: 10.5 }}>{p.pickedBy.length} PICKED · {p.pickedBy.slice(0, 3).join(", ")}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By handicapper */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12 }}>
            {shownCappers.map((h, i) => (
              <div key={i} className="card" style={{ padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <div className="disp" style={{ fontWeight: 700, fontSize: 16 }}>{h.name}</div>
                  {h.winPct != null && <span className="mono" style={{ color: "var(--silks)", fontWeight: 600, fontSize: 13 }}>{h.winPct}%</span>}
                </div>
                {h.source && <div className="mono" style={{ marginTop: 3, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--brassD)" }}>{h.source}</div>}
                {h.record && <div className="note" style={{ marginTop: 2 }}>{h.record}</div>}
                <div style={{ marginTop: 10 }}>
                  {(h.picks || []).map((p, j) => (
                    <div key={j} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", borderTop: j ? "1px solid #EFE7D2" : "none" }}>
                      <span className="mono note" style={{ minWidth: 28 }}>R{p.race}</span>
                      <span style={{ fontWeight: 600 }}>{p.horse}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {day.note && <div className="note" style={{ marginTop: 12, color: "var(--program)" , opacity:.7}}>{day.note}</div>}
        </div>
      )}
    </div>
  );
}

function Connections(props) {
  const [sub, setSub] = useState("jockeys");
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["jockeys", "Jockeys"], ["trainers", "Trainers"], ["owners", "Owners"]].map(([k, l]) => (
          <button key={k} className={sub === k ? "btn" : "btn2"} onClick={() => setSub(k)} style={{ padding: "7px 14px" }}>{l}</button>
        ))}
      </div>
      <EntityTable {...props} type={sub} />
    </div>
  );
}

/* ================= MY BETS ================= */
const BET_TYPES = ["Win", "Place", "Show", "Exacta", "Trifecta", "Superfecta", "Other"];
function BetsTab({ bets, persistBets, races }) {
  const today = localDate();
  const [f, setF] = useState({ date: today, raceId: "", type: "Win", selection: "", stake: "", collect: "", label: "" });
  const raceOpts = races.slice().sort((a, b) => (a.date < b.date ? 1 : -1));

  const addBet = async () => {
    if (!f.stake || (!f.selection && f.type !== "Other") || (!f.raceId && !f.label)) return;
    const bet = { id: "bet-" + Date.now(), ...f, stake: parseFloat(f.stake) || 0, collect: parseFloat(f.collect) || 0, manual: null };
    await persistBets([...bets, bet]);
    setF({ ...f, selection: "", stake: "", collect: "", label: "" });
  };
  const setBet = async (id, patch) => { await persistBets(bets.map((b) => (b.id === id ? { ...b, ...patch } : b))); };
  const delBet = async (id) => { await persistBets(bets.filter((b) => b.id !== id)); };

  // grade + rolling PNL (chronological)
  const rows = bets.map((b) => {
    const auto = gradeBet(b, races);
    const status = b.manual || auto.status;
    const pnl = status === "won" ? (b.collect || 0) - b.stake : status === "lost" ? -b.stake : 0;
    const race = races.find((r) => r.id === b.raceId);
    return { ...b, status, pnl, autoStatus: auto.status, race };
  }).sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
  let run = 0;
  rows.forEach((r) => { run += r.pnl; r.running = run; });

  const settled = rows.filter((r) => r.status !== "open");
  const staked = settled.reduce((s, r) => s + r.stake, 0);
  const returned = rows.filter((r) => r.status === "won").reduce((s, r) => s + (r.collect || 0), 0);
  const net = returned - staked;
  const wl = { w: rows.filter((r) => r.status === "won").length, l: rows.filter((r) => r.status === "lost").length, o: rows.filter((r) => r.status === "open").length };
  const money = (v) => (v < 0 ? "-$" + Math.abs(v).toFixed(2) : "$" + v.toFixed(2));

  return (
    <div className="fade">
      {/* Ledger summary */}
      <div className="totebar" style={{ padding: "14px 16px", marginBottom: 16, display: "flex", gap: 26, flexWrap: "wrap" }}>
        {[["RECORD", `${wl.w}–${wl.l}–${wl.o}`], ["STAKED", money(staked)], ["RETURNED", money(returned)],
          ["NET P/L", money(net)], ["ROI", staked > 0 ? ((net / staked) * 100).toFixed(1) + "%" : "—"]].map(([k, v]) => (
          <div key={k}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: ".2em", color: "var(--toteDim)" }}>{k}</div>
            <div className="mono" style={{ fontSize: 19, color: k === "NET P/L" ? (net >= 0 ? "#7FD49A" : "#E88") : "var(--tote)", fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* New bet */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="disp" style={{ fontWeight: 600, marginBottom: 10 }}>Log a bet</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <select value={f.raceId} onChange={(e) => setF({ ...f, raceId: e.target.value })} style={{ maxWidth: 240 }}>
            <option value="">No linked race (manual grade)</option>
            {raceOpts.map((r) => <option key={r.id} value={r.id}>{r.track} R{r.raceNumber} · {r.date}</option>)}
          </select>
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {BET_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input placeholder={f.type === "Exacta" ? "e.g. 6-3" : f.type === "Trifecta" ? "e.g. 6-3-4" : f.type === "Superfecta" ? "e.g. 6-3-4-1" : "post #"} value={f.selection} onChange={(e) => setF({ ...f, selection: e.target.value })} style={{ width: 100 }} className="mono" />
          {!f.raceId && <input placeholder="Description" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} style={{ width: 170 }} />}
          <input type="number" step="0.01" placeholder="Wager $" value={f.stake} onChange={(e) => setF({ ...f, stake: e.target.value })} style={{ width: 96 }} className="mono" />
          <input type="number" step="0.01" placeholder="Payout $" value={f.collect} onChange={(e) => setF({ ...f, collect: e.target.value })} style={{ width: 96 }} className="mono" title="Total you collect if it hits (from the ticket / will-pays). Editable later." />
          <button className="btn" onClick={addBet}>Log bet</button>
        </div>
        <div className="note" style={{ marginTop: 8 }}>Selections are program numbers. Link a race and the bet grades itself the moment results land (including via "Fetch all results"). Payout is the total collected — enter it from the ticket or fill it in after the race pays.</div>
      </div>

      {/* Ledger */}
      {rows.length === 0 ? (
        <div className="totebar" style={{ padding: 24, textAlign: "center", color: "#B9C7B4", fontSize: 13 }}>No bets logged yet.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table>
            <thead><tr><th>Date</th><th>Bet</th><th>Sel</th><th>Wager</th><th>Payout</th><th>Status</th><th>P/L</th><th>Rolling</th><th></th></tr></thead>
            <tbody>
              {rows.slice().reverse().map((b) => (
                <tr key={b.id}>
                  <td className="mono note" style={{ whiteSpace: "nowrap" }}>{b.date}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{b.race ? `${b.race.track} R${b.race.raceNumber}` : (b.label || "—")} <span className="note" style={{ fontWeight: 400 }}>· {b.type}</span></div>
                  </td>
                  <td className="mono">{b.selection || "—"}</td>
                  <td className="mono">${b.stake.toFixed(2)}</td>
                  <td><input type="number" step="0.01" value={b.collect || ""} placeholder="—" onChange={(e) => setBet(b.id, { collect: parseFloat(e.target.value) || 0 })} style={{ width: 80, padding: "4px 6px", fontSize: 12.5 }} className="mono" /></td>
                  <td>
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: b.status === "won" ? "var(--good)" : b.status === "lost" ? "var(--silks)" : "var(--brassD)" }}>
                      {b.status.toUpperCase()}{b.manual ? " (M)" : b.status !== "open" ? " (AUTO)" : ""}
                    </span>
                    {b.status === "won" && !b.collect ? <div className="note" style={{ fontSize: 10.5 }}>enter payout →</div> : null}
                  </td>
                  <td className="mono" style={{ fontWeight: 600, color: b.pnl > 0 ? "var(--good)" : b.pnl < 0 ? "var(--silks)" : "inherit" }}>{b.pnl === 0 && b.status === "open" ? "—" : (b.pnl < 0 ? "-$" + Math.abs(b.pnl).toFixed(2) : "$" + b.pnl.toFixed(2))}</td>
                  <td className="mono note">{(b.running < 0 ? "-$" + Math.abs(b.running).toFixed(2) : "$" + b.running.toFixed(2))}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {b.status === "open" && <><button className="btn3" onClick={() => setBet(b.id, { manual: "won" })}>Won</button> <button className="btn3" onClick={() => setBet(b.id, { manual: "lost" })}>Lost</button></>}
                    {b.manual && <button className="btn3" onClick={() => setBet(b.id, { manual: null })}>Auto</button>}
                    {" "}<button className="btn3" onClick={() => delBet(b.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================= MODEL PERFORMANCE ================= */
function FactorAudit({ audit }) {
  if (!audit.length) return null;
  return (
    <div className="totebar" style={{ padding: "14px 16px", marginBottom: 16 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".22em", color: "var(--toteDim)", marginBottom: 4 }}>FACTOR AUDIT · DOES EACH FACTOR POINT AT WINNERS?</div>
      <div className="note" style={{ marginBottom: 10 }}>% of graded races where the winner sat above the field average on each factor. Above 50% = pulling its weight; hugging 50% on a real sample = noise; below = actively misleading and due a weight cut. Small samples wobble — judge nothing under ~15 races.</div>
      <table className="datatable">
        <thead><tr><th>Factor</th><th>Races w/ data</th><th>Winner above avg</th><th>Winner's avg edge</th><th>Read</th></tr></thead>
        <tbody>
          {audit.map((a) => (
            <tr key={a.key}>
              <td>{a.label}</td>
              <td className="mono">{a.n}</td>
              <td className="mono" style={{ color: a.n >= 15 ? (a.pct >= 0.55 ? "var(--good)" : a.pct <= 0.45 ? "var(--red)" : "var(--tote)") : "var(--toteDim)" }}>{fmtPct(a.pct)}</td>
              <td className="mono">{(a.avgDiff >= 0 ? "+" : "") + a.avgDiff.toFixed(3)}</td>
              <td className="note">{a.n < 15 ? "sample too small" : a.pct >= 0.6 ? "earning its weight" : a.pct >= 0.55 ? "useful" : a.pct >= 0.45 ? "noise so far" : "misleading — cut it"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerfTab({ races, entities, local, tune }) {
  const grades = useMemo(() => gradeAll(races, entities, local, tune.marketW), [races, entities, local, tune]);
  if (!grades.length) {
    return (
      <div className="totebar fade" style={{ padding: 26, textAlign: "center", color: "#B9C7B4", fontSize: 13 }}>
        Nothing to grade yet. As soon as a race with an analyzable card gets results — fetched or entered — the model grades itself here and starts tuning.
      </div>
    );
  }
  const n = grades.length;
  const winRate = grades.filter((g) => g.hit).length / n;
  const top3 = grades.filter((g) => g.top3).length / n;
  const exN = grades.filter((g) => g.race.results?.length >= 2).length;
  const exacta = exN ? grades.filter((g) => g.exacta).length / exN : 0;
  const avgP = grades.reduce((s, g) => s + g.p, 0) / n;
  const logLoss = -grades.reduce((s, g) => s + Math.log(Math.max(g.p, 1e-4)), 0) / n;
  const randomBaseline = grades.reduce((s, g) => s + 1 / g.fieldSize, 0) / n;

  // Factor audit: over races where a factor had data, how often did the winner sit above the
  // field average on it? >50% = points the right way; ~50% on a real sample = noise; <50% = misleading.
  const FACTOR_META = [["fig", "Speed figs"], ["form", "Form"], ["jP", "Jockey"], ["tP", "Trainer"], ["oP", "Owner"],
    ["surf", "Surface"], ["dist", "Distance"], ["cond", "Off-track"], ["h2h", "Head-to-head"], ["figTrend", "Fig trend"],
    ["pace", "Pace fit"], ["clsMove", "Class move"], ["connF", "Connections (meet)"], ["post", "Post bias"]];
  const audit = FACTOR_META.map(([key, label]) => {
    const covered = grades.filter((g) => g.factors && g.factors[key]);
    if (!covered.length) return { key, label, n: 0 };
    const above = covered.filter((g) => g.factors[key].above).length;
    const avgDiff = covered.reduce((s, g) => s + g.factors[key].diff, 0) / covered.length;
    return { key, label, n: covered.length, pct: above / covered.length, avgDiff };
  }).filter((a) => a.n > 0).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));

  return (
    <div className="fade">
      <div className="totebar" style={{ padding: "14px 16px", marginBottom: 16 }}>
        <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".22em", color: "var(--toteDim)", marginBottom: 10 }}>MODEL REPORT CARD · {n} GRADED RACES</div>
        <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
          {[["TOP PICK WINS", fmtPct(winRate)], ["WINNER IN TOP 3", fmtPct(top3)], ["EXACTA HIT", exN ? fmtPct(exacta) : "—"],
            ["AVG PROB ON WINNER", fmtPct(avgP)], ["RANDOM WOULD GET", fmtPct(randomBaseline)], ["LOG LOSS", logLoss.toFixed(3)]].map(([k, v]) => (
            <div key={k}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".18em", color: "var(--toteDim)" }}>{k}</div>
              <div className="mono" style={{ fontSize: 19, color: "var(--tote)", fontWeight: 600 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      <FactorAudit audit={audit} />

      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="disp" style={{ fontWeight: 600 }}>Self-tuning</div>
        <div style={{ fontSize: 13.5, marginTop: 6 }}>
          {tune.tuned
            ? <>The blend is <b>auto-calibrated from your {tune.n} settled races</b>: the model currently weighs the market (ML odds) at <b>{Math.round(tune.marketW * 100)}%</b> and its own factors at <b>{Math.round((1 - tune.marketW) * 100)}%</b> — the mix that best predicted your actual winners. It re-tunes automatically every time a new result lands.</>
            : <>Running the default blend (market 62% / factors 38%). Auto-tuning kicks in at <b>5 settled races</b> — you have {tune.n}. Every result you fetch or enter feeds it.</>}
        </div>
        <div className="note" style={{ marginTop: 6 }}>Grades use your current database, so enriching horses and connections retroactively sharpens the whole report card.</div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead><tr><th>Race</th><th>Winner</th><th>Model rank</th><th>Model prob</th><th>Field</th><th>Win</th><th>Top 3</th><th>Exacta</th></tr></thead>
          <tbody>
            {grades.slice(0, 100).map((g, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{g.race.track} R{g.race.raceNumber} <span className="note" style={{ fontWeight: 400 }}>· {g.race.date}</span></td>
                <td>{g.winner}</td>
                <td className="mono">#{g.rank}</td>
                <td className="mono">{fmtPct(g.p)}</td>
                <td className="mono note">{g.fieldSize}</td>
                <td className="mono" style={{ color: g.hit ? "var(--good)" : "var(--ink2)" }}>{g.hit ? "✓" : "—"}</td>
                <td className="mono" style={{ color: g.top3 ? "var(--good)" : "var(--ink2)" }}>{g.top3 ? "✓" : "—"}</td>
                <td className="mono" style={{ color: g.exacta ? "var(--good)" : "var(--ink2)" }}>{g.exacta ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================= HEAD TO HEAD ================= */
function H2H({ local }) {
  const [q, setQ] = useState("");
  const pairs = Object.values(local.h2h || {}).sort((a, b) => b.meetings - a.meetings);
  const filtered = pairs.filter((p) => (p.a + " " + p.b).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fade">
      <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder="Search a horse…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--toteDim)" }}>{filtered.length} RIVALRIES INDEXED</span>
      </div>
      {filtered.length === 0 ? (
        <div className="totebar" style={{ padding: 24, textAlign: "center", color: "#B9C7B4", fontSize: 13 }}>
          The rivalry index builds itself from official results. Save a result on any race and every pairing in it lands here.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Matchup</th><th>Meetings</th><th>Record</th><th>Where</th></tr></thead>
            <tbody>
              {filtered.slice(0, 200).map((p, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{p.a} <span className="note">vs</span> {p.b}</td>
                  <td className="mono">{p.meetings}</td>
                  <td className="mono">{p.aAhead}–{p.bAhead} <span className="note">{p.aAhead > p.bAhead ? p.a : p.bAhead > p.aAhead ? p.b : "even"}</span></td>
                  <td className="note" style={{ fontSize: 12 }}>{p.races.slice(0, 3).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
