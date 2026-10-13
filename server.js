// Paper sniper: prati nova pump.fun lansiranja uživo i trguje LAŽNIM novcem.
// Nema privatnog ključa, nema pravih transakcija. Pokretanje: node server.js
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = process.env.PORT || 4173;
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const START_EUR = 50;
const FEE = 0.0125;        // pump.fun fee po trejdu (protokol + kreator)
const TX_COST = 0.0006;    // SOL po transakciji: base + priority fee + Jito tip
const LATENCY_MS = 1500;   // koliko kasnimo za profi snajperima; nalog se izvršava na sledećem čitanju krive
const POLL_MS = 2000;
const SIZE = 0.1;          // ulog po trejdu = 10% početnog kapitala
const MAX_OPEN = 4;
const STATE = path.join(__dirname, 'state.json'), CSV = path.join(__dirname, 'trades.csv');

// Strategije. Sve vide iste tokene u isto vreme; "Nasumični" je kontrola: ako ga neko ne pobedi, to je sreća, ne veština.
const STRATS = [
  { id: 'munja', name: 'Munja', desc: 'Kupuje odmah na lansiranju, ako dev nije kupio previše i nije prodao.',
    tp: 0.35, sl: 0.2, trailArm: 0.2, trail: 0.15, maxHold: 90e3,
    entry: (t, age) => age <= 6e3 && t.devSol <= 1.5 && t.vs >= t.vs0 - 0.05, window: 6e3 },
  { id: 'talas', name: 'Talas', desc: 'Čeka 10–30s; ulazi samo ako je ušlo 3+ SOL i kriva i dalje raste.',
    tp: 0.6, sl: 0.25, trailArm: 0.2, trail: 0.2, maxHold: 240e3,
    entry: (t, age) => age >= 10e3 && t.vs - t.vs0 >= 3 && t.vs > t.prevVs, window: 30e3 },
  { id: 'lovac', name: 'Lovac', desc: 'Ignoriše lansiranje; kupuje tokene koji u 5 min dođu do 50 SOL na krivi.',
    tp: 0.8, sl: 0.25, trailArm: 0.3, trail: 0.25, maxHold: 600e3,
    entry: (t) => t.vs >= 50 && t.vs < 70, window: 300e3 },
  // Taktike koje kruže po X/TikTok objavama, sve odjednom. Ako ne pobedi Munju i kontrolu, objave lažu.
  { id: 'serif', name: 'Šerif', desc: 'Filteri iz objava: ima X/TG/sajt, dev nije serijski, nije kopija imena, dev buy 0.2–2 SOL, pa potvrda +1.5 SOL.',
    tp: 0.5, sl: 0.2, trailArm: 0.25, trail: 0.15, maxHold: 150e3,
    entry: (t, age) => t.soc === true && !t.serial && !t.copy && t.devSol >= 0.2 && t.devSol <= 2
      && age >= 6e3 && t.vs - t.vs0 >= 1.5 && t.vs >= t.prevVs, window: 20e3 },
  // Skalper u stilu KOL-ova: samo vrući narativ, brz ulaz, mali profit, oštar stop.
  { id: 'narativ', name: 'Narativ', desc: 'Kupuje samo tokene iz narativa koji upravo pumpa (2+ tokena sa tom reči prešla 45 SOL u 30 min). Skalp: +30% / −12%.',
    tp: 0.3, sl: 0.12, trailArm: 0.15, trail: 0.1, maxHold: 90e3,
    entry: (t, age) => age >= 4e3 && heat(t) >= 2 && !t.serial && t.devSol <= 2 && t.vs - t.vs0 >= 1 && t.vs >= t.prevVs, window: 25e3 },
  { id: 'random', name: 'Nasumični', desc: 'Kontrola: kupuje 1 od 10 tokena nasumično, prodaje posle 60s.', control: true,
    tp: 9, sl: 9, trailArm: 9, trail: 1, maxHold: 60e3,
    entry: () => Math.random() < 0.1, window: 10e3 },
];

let solEur = 150, startSol = 0, startedAt = Date.now(), runMs = 0, lastTick = Date.now();
const S = {};      // stanje po strategiji
const tokens = new Map();
const orders = [];
let log = [], feed = [], seen = 0, wsUp = false, rpcMs = 0, rpcErr = '', backoff = 0;
const devSeen = new Map(), symSeen = new Map(); // dev -> poslednje lansiranje, simbol -> poslednje viđen

// Telefon: snapshot ide u Supabase preko funkcije sa tajnim ključem iz .env (PUSH_URL, PUSH_KEY)
const ENV = {};
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^(\w+)=(.*)$/); if (m) ENV[m[1]] = m[2].trim(); } } catch {}
Object.assign(ENV, Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PUSH_URL|PUSH_KEY|MAX_RUN_MS)$/.test(k))));
let pushErr = '';

// ---------- narativi: reči iz imena tokena koji stvarno pumpaju ----------
const STOP = new Set('the coin token sol solana pump fun inu meme official real new first just this that with for and you our are not www com'.split(' '));
const words = t => [...new Set(`${t.name} ${t.sym}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
const NAR = new Map(); // reč -> { runs: [vremena], launches: [vremena] }
const narOf = w => NAR.get(w) || (NAR.set(w, { runs: [], launches: [] }), NAR.get(w));
const recent = (a, ms = 18e5) => a.filter(x => Date.now() - x < ms);
const heat = t => Math.max(0, ...(t.words || []).map(w => recent(NAR.get(w)?.runs || []).length));
function narratives() {
  const out = [];
  for (const [w, n] of NAR) { n.runs = recent(n.runs); n.launches = recent(n.launches); if (!n.runs.length && !n.launches.length) NAR.delete(w); else if (n.runs.length) out.push({ w, runs: n.runs.length, launches: n.launches.length }); }
  return out.sort((a, b) => b.runs - a.runs || b.launches - a.launches).slice(0, 10);
}

for (const st of STRATS) S[st.id] = { bal: 0, pos: [], trades: 0, wins: 0, pnl: 0, best: 0, peak: 0, maxDD: 0, hist: [], streak: 0, pauseUntil: 0, halted: false };
const HALT_AT = 0.7, LOSS_STREAK = 4, PAUSE_MS = 15 * 60e3; // zaštita kapitala, važi za sve strategije

// ---------- matematika bonding krive (x*y=k) ----------
const buyTokens = (t, sol) => t.vt - (t.vs * t.vt) / (t.vs + sol * (1 - FEE));
const sellSol = (t, tok) => (t.vs - (t.vs * t.vt) / (t.vt + tok)) * (1 - FEE) - TX_COST;
const posValue = p => { const t = tokens.get(p.mint); return !t || t.dead ? 0 : Math.max(0, sellSol(t, p.tokens)); };
const eurOf = sol => startSol ? sol / startSol * START_EUR : 0; // € po početnom kursu SOL-a: pad SOL-a ne liči na gubitak strategije
const equity = id => S[id].bal + S[id].pos.reduce((a, p) => a + posValue(p), 0)
  + orders.reduce((a, o) => a + (o.sid === id && o.side === 'buy' ? o.sol + TX_COST : 0), 0); // nalog u letu nije gubitak

// ---------- stanje na disku: restart ne briše istoriju ----------
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    ({ startSol, startedAt, runMs, solEur } = d);
    for (const id in d.S) if (S[id]) { Object.assign(S[id], d.S[id]); S[id].pos.forEach(p => { p.exiting = false; }); }
    for (const t of d.tokens || []) tokens.set(t.mint, t);
    log = d.log || [];
    for (const id in S) if (!d.S[id]) { S[id].bal = startSol; S[id].peak = startSol; } // nova strategija dobija svojih 50€
    orders.push(...(d.orders || []));
  } catch { /* prvo pokretanje */ }
}
function save() {
  const keep = new Set(Object.values(S).flatMap(s => s.pos.map(p => p.mint)));
  for (const o of orders) keep.add(o.mint);
  // kupovni nalozi se čuvaju; prodajni se ponovo okinu jer se exiting resetuje
  fs.writeFileSync(STATE + '.tmp', JSON.stringify({ startSol, startedAt, runMs, solEur, S, log: log.slice(0, 200),
    orders: orders.filter(o => o.side === 'buy'), tokens: [...tokens.values()].filter(t => keep.has(t.mint)) }));
  fs.renameSync(STATE + '.tmp', STATE); // atomski: pad usred upisa ne briše istoriju
}

async function priceLoop() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=eur', { signal: AbortSignal.timeout(8000) });
    const p = (await r.json())?.solana?.eur; if (p > 0) solEur = p;
  } catch { /* zadrži poslednju cenu */ }
  if (!startSol) { startSol = START_EUR / solEur; for (const id in S) { S[id].bal = startSol; S[id].peak = startSol; } }
}

// ---------- feed novih tokena (besplatan PumpPortal websocket) ----------
function connect() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.onopen = () => { wsUp = true; ws.send(JSON.stringify({ method: 'subscribeNewToken' })); };
  ws.onclose = () => { wsUp = false; setTimeout(connect, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.txType !== 'create' || !m.bondingCurveKey) return;
    seen++;
    const t = { mint: m.mint, sym: String(m.symbol || '?').slice(0, 12), name: String(m.name || '').slice(0, 30), curve: m.bondingCurveKey,
      born: Date.now(), devSol: m.solAmount || 0, vs0: m.vSolInBondingCurve, vs: m.vSolInBondingCurve, vt: m.vTokensInBondingCurve,
      prevVs: m.vSolInBondingCurve, polled: false, dead: false, done: {}, soc: null };
    const dev = m.traderPublicKey, key = t.sym.toLowerCase(), now = Date.now();
    t.serial = now - (devSeen.get(dev) || 0) < 36e5;   // isti dev lansirao nešto u poslednjih sat vremena
    t.copy = now - (symSeen.get(key) || 0) < 18e5;     // isti simbol već viđen u 30 min
    devSeen.set(dev, now); symSeen.set(key, now);
    if (devSeen.size > 20000) { devSeen.clear(); symSeen.clear(); }
    t.words = words(t); t.ran = false;
    for (const w of t.words) narOf(w).launches.push(now);
    tokens.set(t.mint, t);
    meta(t, m.uri);
    feed.unshift({ mint: t.mint, sym: t.sym, name: t.name, dev: t.devSol, at: t.born }); feed.length = Math.min(feed.length, 14);
  };
}

// metadata tokena (IPFS JSON): da li ima X, Telegram ili sajt
async function meta(t, uri) {
  try {
    const u = new URL(uri); // URI dolazi od nepoznatog kreatora: samo javni https
    if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|\[)/.test(u.hostname)) throw 0;
    const j = await (await fetch(uri, { signal: AbortSignal.timeout(5000) })).json();
    t.soc = !!(j.twitter || j.telegram || j.website);
  } catch { t.soc = false; }
}

// ---------- čitanje krivih direktno sa Solane ----------
async function poll() {
  const list = [...tokens.values()].filter(t => !t.dead);
  const t0 = Date.now();
  try {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const r = await fetch(RPC, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [chunk.map(t => t.curve), { encoding: 'base64', commitment: 'processed' }] }) });
      if (r.status === 429) throw new Error('RPC limit (429)');
      const j = await r.json(); if (j.error) throw new Error(j.error.message);
      j.result.value.forEach((a, k) => {
        const t = chunk[k];
        if (!a) { if (t.polled && (t.miss = (t.miss || 0) + 1) >= 3) t.dead = true; return; } // 3 uzastopna promašaja = nalog stvarno nestao
        t.miss = 0;
        const b = Buffer.from(a.data[0], 'base64');
        if (b.length < 49) { if (t.polled) t.dead = true; return; } // nalog još nije kriva ili je prepisan
        t.prevVs = t.vs;
        t.vt = Number(b.readBigUInt64LE(8)) / 1e6;
        t.vs = Number(b.readBigUInt64LE(16)) / 1e9;
        t.complete = b[48] === 1;
        t.polled = true;
        if (t.vs < 1 || t.vt <= 0) t.dead = true; // pokvarena kriva
        if (!t.ran && t.vs >= 45 && t.words) { t.ran = true; for (const w of t.words) narOf(w).runs.push(Date.now()); }
      });
    }
    rpcErr = ''; backoff = 0;
  } catch (e) { rpcErr = e.message; backoff = Math.min((backoff || 1000) * 2, 30000); }
  rpcMs = Date.now() - t0;
  if (!rpcErr) step(); else lastTick = Date.now(); // slep bot ne trguje i ne broji vreme
  setTimeout(poll, POLL_MS + backoff);
}

// ---------- jedan korak simulacije ----------
function step() {
  const now = Date.now();
  runMs += Math.min(now - lastTick, 15e3); lastTick = now; // laptop na spavanju se ne računa u 72h

  // 1) izvrši naloge kojima je prošlo kašnjenje, po cenama koje su TADA na krivi
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i]; if (now < o.at) continue;
    orders.splice(i, 1);
    const t = tokens.get(o.mint), s = S[o.sid];
    if (o.side === 'buy') {
      if (!t || t.dead || t.complete) { s.bal += o.sol + TX_COST; continue; } // nalog propao, vrati pare
      const tok = buyTokens(t, o.sol);
      s.pos.push({ mint: o.mint, sym: t.sym, tokens: tok, cost: o.sol + TX_COST, at: now, peak: 0 });
    } else close(o.sid, o.p, o.why);
  }

  // 2) izlazi
  for (const st of STRATS) for (const p of S[st.id].pos) {
    if (p.exiting) continue;
    const t = tokens.get(p.mint), v = posValue(p), pct = v / p.cost - 1;
    p.peak = Math.max(p.peak, pct);
    const why = !t || t.dead ? 'RUG' : t.complete ? 'MIGR' : pct >= st.tp ? 'TP' : pct <= -st.sl ? 'SL'
      : p.peak >= st.trailArm && pct <= p.peak - st.trail ? 'TRAIL' : now - p.at > st.maxHold ? 'VREME' : '';
    if (!why) continue;
    p.exiting = true;
    if (why === 'RUG') close(st.id, p, why); else orders.push({ sid: st.id, side: 'sell', mint: p.mint, p, why, at: now + LATENCY_MS });
  }

  // 3) ulazi
  for (const t of tokens.values()) {
    if (!t.polled || t.dead || t.complete) continue;
    const age = now - t.born;
    for (const st of STRATS) {
      if (t.done[st.id]) continue;
      const s = S[st.id], size = startSol * SIZE;
      if (age > st.window) { t.done[st.id] = 1; continue; }
      if (s.halted || now < s.pauseUntil) { t.done[st.id] = 1; continue; }
      if (s.pos.length >= MAX_OPEN || s.bal < size + TX_COST || !st.entry(t, age)) { if (st.control) t.done[st.id] = 1; continue; }
      t.done[st.id] = 1;
      s.bal -= size + TX_COST;
      orders.push({ sid: st.id, side: 'buy', mint: t.mint, sol: size, at: now + LATENCY_MS });
    }
  }

  // 4) počisti tokene koje niko ne prati
  // ponytail: token ispod 36 SOL posle 60s se izbacuje radi RPC limita; Lovac tako propusti retke kasne skokove
  const held = new Set([...Object.values(S).flatMap(s => s.pos.map(p => p.mint)), ...orders.map(o => o.mint)]);
  for (const [m, t] of tokens) {
    const age = now - t.born;
    if (held.has(m)) continue;
    if (t.dead || age > 320e3 || (age > 60e3 && t.vs < 36)) tokens.delete(m);
  }

  // 5) drawdown
  for (const id in S) { const e = equity(id), s = S[id]; s.peak = Math.max(s.peak, e); s.maxDD = Math.max(s.maxDD, 1 - e / s.peak); }
}

function close(sid, p, why) {
  const s = S[sid], t = tokens.get(p.mint);
  const out = !t || t.dead ? 0 : Math.max(0, sellSol(t, p.tokens));
  s.bal += out; s.pos = s.pos.filter(x => x !== p);
  const pnl = out - p.cost;
  s.trades++; if (pnl > 0) s.wins++; s.pnl += pnl; s.best = Math.max(s.best, pnl);
  s.streak = pnl > 0 ? 0 : (s.streak || 0) + 1;
  if (s.streak >= LOSS_STREAK && !STRATS.find(x => x.id === sid).control) { s.pauseUntil = Date.now() + PAUSE_MS; s.streak = 0; }
  if (equity(sid) < startSol * HALT_AT && !STRATS.find(x => x.id === sid).control) s.halted = true;
  const row = { at: Date.now(), sid, sym: p.sym, mint: p.mint, why, pnl, pct: out / p.cost - 1, hold: Date.now() - p.at };
  log.unshift(row); log.length = Math.min(log.length, 200);
  fs.appendFile(CSV, `${new Date(row.at).toISOString()},${sid},${p.sym.replace(/,/g, ' ')},${p.mint},${why},${eurOf(pnl).toFixed(4)},${(row.pct * 100).toFixed(1)}\n`, () => {});
}

// ---------- presuda: kad (ako ikad) prave pare ----------
function verdict() {
  const real = STRATS.filter(s => !s.control).map(s => ({ ...S[s.id], id: s.id, name: s.name, eq: equity(s.id) }));
  const b = real.sort((x, y) => y.eq - x.eq)[0], rnd = equity('random');
  const h = runMs / 36e5;
  const checks = [
    { label: 'Radi bar 72h (ne jedan dan)', ok: h >= 72, prog: Math.min(1, h / 72), val: `${h.toFixed(1)}h / 72h` },
    { label: 'Bar 150 zatvorenih trejdova', ok: b.trades >= 150, prog: Math.min(1, b.trades / 150), val: `${b.trades} / 150` },
    { label: 'U plusu posle svih fee-jeva', ok: b.eq > startSol, prog: b.eq > startSol ? 1 : 0, val: `${eurOf(b.eq - startSol).toFixed(2)} €` },
    { label: 'Bolji od nasumičnog kupovanja', ok: b.eq > rnd, prog: b.eq > rnd ? 1 : 0, val: b.eq > rnd ? 'da' : 'ne' },
    { label: 'U plusu i bez najboljeg trejda', ok: b.eq - b.best > startSol, prog: b.eq - b.best > startSol ? 1 : 0, val: `${eurOf(b.eq - b.best - startSol).toFixed(2)} €` },
    { label: 'Najveći pad ispod 35%', ok: b.maxDD < 0.35, prog: b.maxDD < 0.35 ? 1 : 0, val: `${(b.maxDD * 100).toFixed(0)}%` },
  ];
  return { leader: b.name, ready: checks.every(c => c.ok), checks };
}

function snapshot() {
  return {
    wsUp, rpcErr, rpcMs, pushErr, solEur, startEur: START_EUR, runMs, seen, tracked: tokens.size,
    strategies: STRATS.map(st => {
      const s = S[st.id], eq = equity(st.id);
      return { id: st.id, name: st.name, desc: st.desc, control: !!st.control, eur: eurOf(eq), pnlEur: eurOf(eq - startSol),
        pct: startSol ? eq / startSol - 1 : 0, halted: !!s.halted, pause: Math.max(0, (s.pauseUntil || 0) - Date.now()), trades: s.trades, wins: s.wins, maxDD: s.maxDD, hist: s.hist,
        open: s.pos.map(p => ({ sym: p.sym, pct: posValue(p) / p.cost - 1, age: Date.now() - p.at })) };
    }),
    log: log.slice(0, 40).map(r => ({ ...r, eur: eurOf(r.pnl) })), feed: feed.map(f => ({ ...f, soc: tokens.get(f.mint)?.soc })), verdict: verdict(), narratives: narratives(), cloud: !!process.env.CI,
  };
}

function record() {
  for (const id in S) {
    const h = S[id].hist; h.push([Date.now(), +eurOf(equity(id)).toFixed(3)]);
    if (h.length > 600) S[id].hist = h.filter((_, i) => i % 2 === 0 || i === h.length - 1); // pola rezolucije, istorija ostaje cela
  }
}

// ---------- server ----------
const clients = new Set();
http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res); req.on('close', () => clients.delete(res));
    return res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  }
  if (req.url === '/trades.csv') { res.writeHead(200, { 'content-type': 'text/csv' }); return fs.createReadStream(CSV).on('error', () => res.end()).pipe(res); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Paper sniper: http://localhost:${PORT}  (lažni novac, ${START_EUR}€ po strategiji)`));

load();
priceLoop().finally(() => { connect(); poll(); record(); });
setInterval(priceLoop, 5 * 60e3);
setInterval(record, 15e3);
setInterval(save, 20e3);
setInterval(() => { if (!clients.size) return; const d = `data: ${JSON.stringify(snapshot())}\n\n`; for (const c of clients) c.write(d); }, 1000);
if (ENV.PUSH_URL && ENV.PUSH_KEY) setInterval(async () => {
  try {
    const r = await fetch(ENV.PUSH_URL, { method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', 'x-push-key': ENV.PUSH_KEY }, body: JSON.stringify(snapshot()) });
    pushErr = r.ok ? '' : `push ${r.status}`;
  } catch (e) { pushErr = 'push: ' + e.message; }
}, 5000);
process.on('SIGINT', () => { save(); process.exit(); });
process.on('SIGTERM', () => { save(); process.exit(); });
if (+ENV.MAX_RUN_MS) setTimeout(() => { save(); console.log('kraj smene, stanje sačuvano'); process.exit(0); }, +ENV.MAX_RUN_MS);
