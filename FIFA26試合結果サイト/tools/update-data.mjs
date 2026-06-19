// tools/update-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// worldcup26.ir（FIFA World Cup 2026 専用の無料API）から「生データ」を取得し、
// data/wc26.json を書き換えるスクリプト。
//   - GROUPS   … 順位表（試合結果から自動集計）+ 終了した試合（得点者つき）
//   - FIXTURES … これからの試合（日程・会場つき）
//   - SCORERS  … 得点ランキング（得点者イベントから集計／取れない時は据え置き）
// ※ 記事・今日の注目・アンケート・コラムは “サイト側” がこの生データから自動生成します。
//
// 認証（無料登録・支払い不要・トークンは84日有効）:
//   方法A: 一度発行したトークンを WC26_TOKEN に入れる
//   方法B: WC26_EMAIL と WC26_PASSWORD を入れる（実行のたびにログインしてトークン取得）
//
// 実行例: WC26_EMAIL=you@example.com WC26_PASSWORD=*** node tools/update-data.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://worldcup26.ir';

// APIの fifa_code → サイト内コードの対応（基本は同じ。ズレる時だけ追記）
const CODE_MAP = { /* 例: 'IVO':'CIV' */ };
const code = (c) => CODE_MAP[c] || c;
const md = (s) => { const d = new Date(s); return isNaN(d) ? String(s) : `${d.getMonth() + 1}/${d.getDate()}`; };
const norm = (x) => Array.isArray(x) ? x : (x && Array.isArray(x.data) ? x.data : (x && Array.isArray(x.result) ? x.result : []));

async function getToken() {
  if (process.env.WC26_TOKEN) return process.env.WC26_TOKEN;
  const email = process.env.WC26_EMAIL, password = process.env.WC26_PASSWORD;
  if (!email || !password) throw new Error('WC26_TOKEN か、WC26_EMAIL と WC26_PASSWORD を設定してください（worldcup26.ir で無料登録）');
  const res = await fetch(`${BASE}/auth/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) throw new Error(`ログイン失敗 ${res.status}`);
  return (await res.json()).token;
}

async function api(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

// 試合オブジェクトから得点者配列を抽出（フィールド名はライブ仕様に合わせて吸収）
function scorersOf(g, idCode) {
  const ev = g.goals || g.scorers || g.events || g.goal_scorers;
  if (!Array.isArray(ev)) return undefined;
  const out = ev.map((e) => ({
    c: code(e.fifa_code || idCode[e.team_id] || e.team || ''),
    p: e.player || e.name || e.scorer || e.player_name || '',
    m: e.minute != null ? `${e.minute}'` : (e.time ? String(e.time) : '')
  })).filter((x) => x.p);
  return out.length ? out : undefined;
}

async function main() {
  const token = await getToken();
  const teams    = norm(await api('/get/teams', token));
  const games    = norm(await api('/get/games', token));
  let   stadiums = [];
  try { stadiums = norm(await api('/get/stadiums', token)); } catch (e) { /* 任意 */ }

  const idCode = {}, idGroup = {};
  teams.forEach((t) => { idCode[t.id] = code(t.fifa_code); idGroup[t.id] = t.groups; });
  const venue = {};
  stadiums.forEach((s) => { venue[s.id] = s.fifa_name || s.name_en || s.city_en || ''; });

  // 各グループの順位表を試合結果から自動集計
  const blank = () => ({ P:0,W:0,D:0,L:0,GF:0,GA:0,Pts:0,form:'D' });
  const G = {};
  teams.forEach((t) => { const gr = t.groups; if (gr) { (G[gr] = G[gr] || { stats:{}, matches:[] }).stats[code(t.fifa_code)] = blank(); } });

  games.filter((g) => g.finished).forEach((g) => {
    const gr = g.group; if (!gr || !G[gr]) return;
    const h = idCode[g.home_team_id], a = idCode[g.away_team_id];
    const hs = +g.home_score, as = +g.away_score;
    const sh = G[gr].stats[h], sa = G[gr].stats[a];
    if (sh) { sh.P++; sh.GF += hs; sh.GA += as; }
    if (sa) { sa.P++; sa.GF += as; sa.GA += hs; }
    if (hs > as)      { if (sh){sh.W++;sh.Pts+=3;sh.form='W';} if (sa){sa.L++;sa.form='L';} }
    else if (hs < as) { if (sa){sa.W++;sa.Pts+=3;sa.form='W';} if (sh){sh.L++;sh.form='L';} }
    else              { if (sh){sh.D++;sh.Pts+=1;sh.form='D';} if (sa){sa.D++;sa.Pts+=1;sa.form='D';} }
    const sc = scorersOf(g, idCode);
    const row = [md(g.local_date), h, hs, a, as]; if (sc) row.push(sc);
    G[gr].matches.push(row);
  });

  const GROUPS = {};
  Object.keys(G).sort().forEach((gr) => {
    const order = Object.keys(G[gr].stats).sort((a, b) => {
      const A = G[gr].stats[a], B = G[gr].stats[b];
      return B.Pts - A.Pts || (B.GF - B.GA) - (A.GF - A.GA) || B.GF - A.GF;
    });
    GROUPS[gr] = {
      teams: order.map((c) => { const s = G[gr].stats[c]; return [c, s.P, s.W, s.D, s.L, s.GF, s.GA, s.Pts, s.form]; }),
      matches: G[gr].matches
    };
  });

  // これからの試合（会場つき・直近6件）
  const FIXTURES = games.filter((g) => !g.finished)
    .sort((a, b) => new Date(a.local_date) - new Date(b.local_date))
    .slice(0, 6)
    .map((g) => [md(g.local_date), idCode[g.home_team_id], idCode[g.away_team_id], venue[g.stadium_id] || '']);

  // 得点ランキング（得点者イベントを集計。取れない期間は据え置き）
  const tally = {};
  games.filter((g) => g.finished).forEach((g) => {
    const ev = scorersOf(g, idCode); if (!ev) return;
    ev.forEach((e) => { const k = e.p + '|' + e.c; tally[k] = (tally[k] || 0) + 1; });
  });
  const SCORERS = Object.keys(tally)
    .map((k) => { const [p, c] = k.split('|'); return [p, c, tally[k]]; })
    .sort((a, b) => b[2] - a[2]).slice(0, 6);

  const current = JSON.parse(await readFile('data/wc26.json', 'utf8'));
  const out = {
    ...current,
    _meta: { updatedAt: new Date().toISOString(), source: 'worldcup26.ir' },
    GROUPS:   Object.keys(GROUPS).length ? GROUPS : current.GROUPS,
    FIXTURES: FIXTURES.length ? FIXTURES : current.FIXTURES,
    SCORERS:  SCORERS.length ? SCORERS : current.SCORERS
  };

  await writeFile('data/wc26.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  const fin = games.filter((g) => g.finished).length;
  console.log(`✓ data/wc26.json を更新（${Object.keys(out.GROUPS).length}組 / 終了${fin}試合 / 日程${out.FIXTURES.length}件 / 得点者${out.SCORERS.length}人）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
