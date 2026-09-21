'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const USER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000; // 12 horas
const TWITCH_AVATAR_PREFIX = 'https://static-cdn.jtvnw.net/';

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD && !IS_PROD) {
  ADMIN_PASSWORD = 'admin123';
  console.warn('[aviso] ADMIN_PASSWORD não definida. Usando "admin123" (só para desenvolvimento).');
}
if (!ADMIN_PASSWORD) console.error('[erro] ADMIN_PASSWORD não definida: o painel admin está desativado.');
if (!DATABASE_URL) {
  console.error('[erro] DATABASE_URL não definida. Use a connection string do Supabase (veja o README).');
  process.exit(1);
}
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.warn('[aviso] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET não definidos: o login com a Twitch não vai funcionar.');
}

/* ------------------------------------------------------------------ */
/* Banco de dados (Postgres / Supabase)                                */
/* ------------------------------------------------------------------ */
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
// "sslmode=" na URL sobrescreveria a opção ssl abaixo (e o certificado do pooler não passa na verificação total)
const connectionString = DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = new Pool({
  connectionString,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30000,
});
pool.on('error', (e) => console.error('Erro no pool do Postgres:', e.message));

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* ignora */ }
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (_) { /* cookie malformado */ }
  });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (IS_PROD) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/* Sessões ficam no banco: sobrevivem a reinícios do servidor */
async function createSession(kind, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('insert into sessions (token_hash, kind, user_id, expires_at) values ($1, $2, $3, $4)', [
    sha(token),
    kind,
    userId,
    new Date(Date.now() + ttlMs),
  ]);
  return token;
}
async function hasSession(req, cookieName, kind) {
  const token = parseCookies(req)[cookieName];
  if (!token) return false;
  const { rowCount } = await q(
    'select 1 from sessions where token_hash = $1 and kind = $2 and expires_at > now()',
    [sha(token), kind]
  );
  return rowCount > 0;
}
async function destroySession(req, res, cookieName) {
  const token = parseCookies(req)[cookieName];
  if (token) await q('delete from sessions where token_hash = $1', [sha(token)]);
  setCookie(res, cookieName, '', 0);
}
async function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const { rows } = await q(
    `select u.* from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.kind = 'user' and s.expires_at > now()`,
    [sha(token)]
  );
  return rows[0] || null;
}
setInterval(() => {
  q('delete from sessions where expires_at < now()').catch(() => {});
}, 60 * 60 * 1000).unref();

/* Limite simples de tentativas por IP (em memória) */
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60 * 1000).unref();

function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.count += 1;
    if (e.count > max) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Enquetes: leitura e regras                                          */
/* ------------------------------------------------------------------ */
const iso = (d) => (d ? new Date(d).toISOString() : null);

function rowToPoll(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    points: r.points,
    closesAt: iso(r.closes_at),
    closed: r.closed,
    visible: r.visible,
    counted: r.counted,
    correctOptionId: r.correct_option_id,
    createdAt: iso(r.created_at),
    resolvedAt: iso(r.resolved_at),
    options: [],
  };
}

async function fetchPolls(where = '', params = []) {
  const { rows } = await q(`select * from polls ${where} order by created_at desc`, params);
  const polls = rows.map(rowToPoll);
  if (!polls.length) return polls;
  const byId = new Map(polls.map((p) => [p.id, p]));
  const opts = await q(
    'select id, poll_id, label from poll_options where poll_id = any($1::text[]) order by poll_id, position',
    [polls.map((p) => p.id)]
  );
  for (const o of opts.rows) byId.get(o.poll_id).options.push({ id: o.id, text: o.label });
  return polls;
}

async function fetchVotes(pollIds) {
  if (!pollIds.length) return new Map();
  const { rows } = await q(
    `select v.poll_id, v.option_id, v.user_id, u.display_name
     from votes v join users u on u.id = v.user_id
     where v.poll_id = any($1::text[])`,
    [pollIds]
  );
  const byPoll = new Map();
  for (const v of rows) {
    if (!byPoll.has(v.poll_id)) byPoll.set(v.poll_id, []);
    byPoll.get(v.poll_id).push(v);
  }
  return byPoll;
}

async function getMode() {
  const { rows } = await q("select value from settings where key = 'mode'");
  return rows[0] && rows[0].value === 'accumulate' ? 'accumulate' : 'replace';
}

function pollStatus(p) {
  if (p.correctOptionId) return 'resolved';
  if (p.closed) return 'closed';
  if (p.closesAt && Date.parse(p.closesAt) <= Date.now()) return 'closed';
  return 'open';
}

/* Visão pública: só mostra resultados parciais depois que a votação fecha */
function publicPoll(p, votes, userId) {
  const status = pollStatus(p);
  const mine = userId ? votes.find((v) => v.user_id === userId) : null;
  const showResults = status !== 'open';
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    points: p.points,
    closesAt: p.closesAt,
    status,
    createdAt: p.createdAt,
    totalVotes: votes.length,
    options: p.options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: showResults ? votes.filter((v) => v.option_id === o.id).length : null,
    })),
    myVote: mine ? mine.option_id : null,
    correctOptionId: status === 'resolved' ? p.correctOptionId : null,
    myHit: status === 'resolved' && mine ? mine.option_id === p.correctOptionId : null,
    myPoints:
      status === 'resolved' && mine && p.counted
        ? (mine.option_id === p.correctOptionId ? p.points : 0)
        : null,
  };
}

/* Visão do admin: contagens e nomes de quem votou em cada opção */
function adminPoll(p, votes) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    points: p.points,
    closesAt: p.closesAt,
    status: pollStatus(p),
    createdAt: p.createdAt,
    resolvedAt: p.resolvedAt,
    visible: p.visible,
    counted: p.counted,
    correctOptionId: p.correctOptionId,
    totalVotes: votes.length,
    hits: p.correctOptionId ? votes.filter((v) => v.option_id === p.correctOptionId).length : null,
    options: p.options.map((o) => ({
      id: o.id,
      text: o.text,
      voters: votes.filter((v) => v.option_id === o.id).map((v) => v.display_name),
    })),
  };
}

async function getStreakRule() {
  const { rows } = await q("select key, value from settings where key in ('streak_every', 'streak_bonus')");
  const get = (k) => {
    const r = rows.find((x) => x.key === k);
    const n = r ? parseInt(r.value, 10) : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const every = get('streak_every');
  const bonus = get('streak_bonus');
  return every > 0 && bonus > 0 ? { every, bonus } : { every: 0, bonus: 0 };
}

/* Classificação e histórico de cada participante. Soma duas fontes:
   1) enquetes resolvidas que ainda existem (trocar a resposta certa recalcula);
   2) rodadas "guardadas" (tabela awards): enquetes apagadas ou reabertas mantendo os pontos.
   "Zerar ranking" limpa as duas. Os resultados são lidos em ordem cronológica
   para calcular a sequência de acertos e o bônus (se ativado). */
async function computeStandings() {
  const [users, results, rounds, rule] = await Promise.all([
    q('select id, display_name, login, avatar_url from users'),
    q(`
      select r.user_id, r.poll_title, r.chosen, r.correct, r.points, r.hit, r.at
      from (
        select v.user_id, p.title as poll_title, oc.label as chosen, cc.label as correct,
               p.points, (v.option_id = p.correct_option_id) as hit, p.resolved_at as at
        from votes v
        join polls p on p.id = v.poll_id
        left join poll_options oc on oc.id = v.option_id
        left join poll_options cc on cc.id = p.correct_option_id
        where p.correct_option_id is not null and p.counted
        union all
        select user_id, poll_title, null, null, points, hit, resolved_at from awards
      ) r
      order by r.at nulls first, r.poll_title`),
    q(`select ((select count(*) from polls where correct_option_id is not null and counted)
             + (select count(distinct poll_id) from awards))::int as n`),
    getStreakRule(),
  ]);

  const stats = new Map(users.rows.map((u) => [u.id, {
    userId: u.id,
    name: u.display_name,
    login: u.login,
    avatar: u.avatar_url,
    points: 0,
    hits: 0,
    played: 0,
    streak: 0,
    bestStreak: 0,
    bonus: 0,
    history: [],
  }]));

  for (const r of results.rows) {
    const s = stats.get(r.user_id);
    if (!s) continue;
    s.played += 1;
    let bonus = 0;
    if (r.hit) {
      s.hits += 1;
      s.points += r.points;
      s.streak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (rule.every > 0 && s.streak % rule.every === 0) {
        bonus = rule.bonus;
        s.bonus += bonus;
        s.points += bonus;
      }
    } else {
      s.streak = 0;
    }
    s.history.push({
      title: r.poll_title,
      chosen: r.chosen,
      correct: r.correct,
      hit: r.hit,
      points: r.hit ? r.points : 0,
      bonus,
      at: iso(r.at),
    });
  }

  const list = [...stats.values()];
  list.sort((a, b) => b.points - a.points || b.hits - a.hits || a.name.localeCompare(b.name, 'pt-BR'));
  let pos = 0;
  let prev = null;
  list.forEach((s, i) => {
    if (!prev || s.points !== prev.points || s.hits !== prev.hits) pos = i + 1;
    s.position = pos;
    prev = s;
  });
  return { ranking: list, resolved: rounds.rows[0].n, rule };
}

function parsePollInput(body, requireOptions) {
  const title = String(body?.title ?? '').trim();
  const description = String(body?.description ?? '').trim();
  if (title.length < 3 || title.length > 200) return { error: 'O título precisa ter entre 3 e 200 caracteres.' };
  if (description.length > 1000) return { error: 'A descrição pode ter no máximo 1000 caracteres.' };

  const rawPoints = body?.points;
  const points = rawPoints === undefined || rawPoints === null || rawPoints === '' ? 10 : Number(rawPoints);
  if (!Number.isInteger(points) || points < 1 || points > 1000) {
    return { error: 'Os pontos precisam ser um número inteiro entre 1 e 1000.' };
  }

  let closesAt = null;
  if (body?.closesAt) {
    const t = Date.parse(String(body.closesAt));
    if (Number.isNaN(t)) return { error: 'Data de encerramento inválida.' };
    closesAt = new Date(t).toISOString();
  }

  const out = { title, description, points, closesAt };
  if (requireOptions) {
    const raw = Array.isArray(body?.options) ? body.options : [];
    const options = [...new Set(raw.map((o) => String(o).trim()).filter(Boolean))];
    if (options.length < 2 || options.length > 10) return { error: 'Informe de 2 a 10 opções diferentes.' };
    if (options.some((o) => o.length > 100)) return { error: 'Cada opção pode ter no máximo 100 caracteres.' };
    out.options = options.map((text) => ({ id: uid(), text }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      "img-src 'self' data: https://static-cdn.jtvnw.net; script-src 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: '20kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ---------- Atualização em tempo real (Server-Sent Events) ---------- */
const sseClients = new Set();

function broadcast() {
  for (const res of sseClients) res.write(`event: update\ndata: ${Date.now()}\n\n`);
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Batida a cada 25s para o proxy do Render não derrubar conexões ociosas
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000).unref();

// Qualquer alteração feita pelo admin avisa as páginas abertas
const QUIET_ADMIN_PATHS = new Set(['/login', '/logout', '/settings']);
app.use('/api/admin', (req, res, next) => {
  if (req.method !== 'GET' && !QUIET_ADMIN_PATHS.has(req.path)) {
    res.on('finish', () => {
      if (res.statusCode < 400) broadcast();
    });
  }
  next();
});

const requireUser = wrap(async (req, res, next) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'Entre com a Twitch para continuar.' });
  req.user = u;
  next();
});
const requireAdmin = wrap(async (req, res, next) => {
  if (!(await hasSession(req, 'asid', 'admin'))) return res.status(401).json({ error: 'Acesso restrito ao admin.' });
  next();
});
const userView = (u) => ({ id: u.id, name: u.display_name, login: u.login, avatar: u.avatar_url });

/* ---------- Saúde (Render) ---------- */
app.get('/healthz', (req, res) => res.type('text').send('ok'));

/* ---------- Login com a Twitch (OAuth 2.0, authorization code) ---------- */
function baseUrl(req) {
  const url = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
  return url.replace(/\/+$/, '');
}

app.get('/auth/twitch', limit('oauth', 60, 15 * 60 * 1000), (req, res) => {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    return res.status(503).type('text').send('Login com a Twitch não configurado no servidor.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, 600);
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: `${baseUrl(req)}/auth/twitch/callback`,
    response_type: 'code',
    scope: '', // só precisamos identificar a conta; nenhuma permissão extra
    state,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

app.get('/auth/twitch/callback', limit('oauth', 60, 15 * 60 * 1000), wrap(async (req, res) => {
  const saved = parseCookies(req).oauth_state;
  setCookie(res, 'oauth_state', '', 0);
  const { code, state, error } = req.query;

  if (error) return res.redirect('/?login=cancelado');
  if (typeof code !== 'string' || typeof state !== 'string' || !saved || state !== saved) {
    return res.redirect('/?login=erro');
  }

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${baseUrl(req)}/auth/twitch/callback`,
      }),
    });
    if (!tokenRes.ok) {
      console.error('Twitch (token) respondeu', tokenRes.status, await tokenRes.text());
      return res.redirect('/?login=erro');
    }
    const { access_token: accessToken } = await tokenRes.json();

    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': TWITCH_CLIENT_ID },
    });
    if (!userRes.ok) {
      console.error('Twitch (users) respondeu', userRes.status);
      return res.redirect('/?login=erro');
    }
    const tw = ((await userRes.json()).data || [])[0];
    if (!tw || !tw.id) return res.redirect('/?login=erro');

    const avatar =
      typeof tw.profile_image_url === 'string' && tw.profile_image_url.startsWith(TWITCH_AVATAR_PREFIX)
        ? tw.profile_image_url
        : null;
    const { rows } = await q(
      `insert into users (id, twitch_id, login, display_name, avatar_url)
       values ($1, $2, $3, $4, $5)
       on conflict (twitch_id) do update
         set login = excluded.login, display_name = excluded.display_name, avatar_url = excluded.avatar_url
       returning id, (xmax = 0) as inserted`,
      [uid(), String(tw.id), String(tw.login), String(tw.display_name || tw.login), avatar]
    );
    const token = await createSession('user', rows[0].id, USER_SESSION_MS);
    setCookie(res, 'sid', token, USER_SESSION_MS / 1000);
    if (rows[0].inserted) broadcast(); // novo participante aparece no ranking
    res.redirect('/');
  } catch (e) {
    console.error('Erro no login com a Twitch:', e.message);
    res.redirect('/?login=erro');
  }
}));

app.post('/api/logout', wrap(async (req, res) => {
  await destroySession(req, res, 'sid');
  res.json({ ok: true });
}));

app.get('/api/me', wrap(async (req, res) => {
  const u = await currentUser(req);
  res.json({ user: u ? userView(u) : null });
}));

/* ---------- Enquetes e votos ---------- */
app.get('/api/polls', wrap(async (req, res) => {
  const u = await currentUser(req);
  const list = await fetchPolls('where visible');
  const votes = await fetchVotes(list.map((p) => p.id));
  const rank = { open: 0, closed: 1, resolved: 2 };
  const deadline = (p) => (p.closesAt ? Date.parse(p.closesAt) : Number.MAX_SAFE_INTEGER);
  const polls = list.map((p) => publicPoll(p, votes.get(p.id) || [], u && u.id));
  polls.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if (a.status === 'open' && deadline(a) !== deadline(b)) return deadline(a) - deadline(b);
    return b.createdAt.localeCompare(a.createdAt);
  });
  res.json({ polls });
}));

app.post('/api/polls/:id/vote', requireUser, wrap(async (req, res) => {
  const [poll] = await fetchPolls('where id = $1', [req.params.id]);
  if (!poll || !poll.visible) return res.status(404).json({ error: 'Enquete não encontrada.' });
  if (pollStatus(poll) !== 'open') {
    return res.status(409).json({ error: 'A votação desta enquete já foi encerrada.' });
  }
  const optionId = String(req.body?.optionId ?? '');
  if (!poll.options.some((o) => o.id === optionId)) {
    return res.status(400).json({ error: 'Opção inválida.' });
  }
  await q(
    `insert into votes (poll_id, user_id, option_id) values ($1, $2, $3)
     on conflict (poll_id, user_id) do update set option_id = excluded.option_id, voted_at = now()`,
    [poll.id, req.user.id, optionId]
  );
  const votes = await fetchVotes([poll.id]);
  res.json({ poll: publicPoll(poll, votes.get(poll.id) || [], req.user.id) });
}));

app.get('/api/ranking', wrap(async (req, res) => {
  const st = await computeStandings();
  res.json({
    ranking: st.ranking.map(({ history, ...row }) => row),
    resolved: st.resolved,
    rule: st.rule,
  });
}));

/* Perfil público: só mostra enquetes já resolvidas, então não revela palpites em aberto */
app.get('/api/users/:id/profile', wrap(async (req, res) => {
  const st = await computeStandings();
  const found = st.ranking.find((r) => r.userId === req.params.id);
  if (!found) return res.status(404).json({ error: 'Participante não encontrado.' });
  const { history, ...stats } = found;
  res.json({
    ...stats,
    accuracy: stats.played ? Math.round((stats.hits / stats.played) * 100) : 0,
    rule: st.rule,
    history: history.slice().reverse(), // mais recentes primeiro
  });
}));

/* ---------- Admin ---------- */
app.post('/api/admin/login', limit('admin', 10, 15 * 60 * 1000), wrap(async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'ADMIN_PASSWORD não está configurada no servidor.' });
  const given = sha(String(req.body?.password ?? ''));
  const expected = sha(ADMIN_PASSWORD);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  setCookie(res, 'asid', await createSession('admin', null, ADMIN_SESSION_MS), ADMIN_SESSION_MS / 1000);
  res.json({ ok: true });
}));

app.post('/api/admin/logout', wrap(async (req, res) => {
  await destroySession(req, res, 'asid');
  res.json({ ok: true });
}));

app.get('/api/admin/me', wrap(async (req, res) => {
  res.json({ admin: await hasSession(req, 'asid', 'admin') });
}));

app.get('/api/admin/polls', requireAdmin, wrap(async (req, res) => {
  const list = await fetchPolls();
  const votes = await fetchVotes(list.map((p) => p.id));
  const users = await q('select count(*)::int as n from users');
  res.json({
    polls: list.map((p) => adminPoll(p, votes.get(p.id) || [])),
    users: users.rows[0].n,
    mode: await getMode(),
    streak: await getStreakRule(),
  });
}));

app.post('/api/admin/polls', requireAdmin, wrap(async (req, res) => {
  const input = parsePollInput(req.body, true);
  if (input.error) return res.status(400).json({ error: input.error });
  const id = uid();
  await tx(async (c) => {
    const mode = await c.query("select value from settings where key = 'mode'");
    // Modo "substituir": as enquetes anteriores saem da página principal.
    // Continuam no painel admin (e seguem valendo pontos quando forem resolvidas).
    if (!mode.rows[0] || mode.rows[0].value !== 'accumulate') {
      await c.query('update polls set visible = false, closed = (closed or correct_option_id is null) where visible');
    }
    await c.query('insert into polls (id, title, description, points, closes_at) values ($1, $2, $3, $4, $5)', [
      id,
      input.title,
      input.description,
      input.points,
      input.closesAt,
    ]);
    for (const [i, o] of input.options.entries()) {
      await c.query('insert into poll_options (id, poll_id, label, position) values ($1, $2, $3, $4)', [o.id, id, o.text, i]);
    }
  });
  res.status(201).json({ id });
}));

const notFound = (res) => res.status(404).json({ error: 'Enquete não encontrada.' });

app.put('/api/admin/polls/:id', requireAdmin, wrap(async (req, res) => {
  const input = parsePollInput(req.body, false);
  if (input.error) return res.status(400).json({ error: input.error });
  const r = await q('update polls set title = $2, description = $3, points = $4, closes_at = $5 where id = $1', [
    req.params.id,
    input.title,
    input.description,
    input.points,
    input.closesAt,
  ]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

app.post('/api/admin/polls/:id/close', requireAdmin, wrap(async (req, res) => {
  const r = await q('update polls set closed = true where id = $1', [req.params.id]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

/* Reabrir votação. Se a enquete já tem resposta e soma pontos, o admin escolhe:
   - "keep": os pontos atuais ficam guardados no ranking e os votos são limpos (nova rodada);
   - "zero": os pontos desta enquete saem do ranking (inclusive rodadas guardadas antes). */
app.post('/api/admin/polls/:id/reopen', requireAdmin, wrap(async (req, res) => {
  const choice = req.body?.points;
  const result = await tx(async (c) => {
    const { rows } = await c.query('select correct_option_id, counted from polls where id = $1 for update', [req.params.id]);
    if (!rows.length) return 'notfound';
    const scoring = Boolean(rows[0].correct_option_id) && rows[0].counted;
    if (scoring && choice !== 'keep' && choice !== 'zero') return 'choose';
    if (scoring && choice === 'keep') {
      await c.query(
        `insert into awards (poll_id, poll_title, user_id, hit, points, resolved_at)
         select p.id, p.title, v.user_id, (v.option_id = p.correct_option_id), p.points, p.resolved_at
         from polls p join votes v on v.poll_id = p.id
         where p.id = $1`,
        [req.params.id]
      );
      await c.query('delete from votes where poll_id = $1', [req.params.id]);
    }
    if (scoring && choice === 'zero') {
      await c.query('delete from awards where poll_id = $1', [req.params.id]);
    }
    await c.query(
      `update polls
       set closed = false, correct_option_id = null, resolved_at = null,
           closes_at = case when closes_at is not null and closes_at <= now() then null else closes_at end
       where id = $1`,
      [req.params.id]
    );
    return 'ok';
  });
  if (result === 'notfound') return notFound(res);
  if (result === 'choose') return res.status(400).json({ error: 'Escolha o que fazer com os pontos desta enquete.' });
  res.json({ ok: true });
}));

app.post('/api/admin/polls/:id/resolve', requireAdmin, wrap(async (req, res) => {
  const optionId = String(req.body?.optionId ?? '');
  const { rowCount: valid } = await q('select 1 from poll_options where id = $1 and poll_id = $2', [optionId, req.params.id]);
  if (!valid) return res.status(400).json({ error: 'Opção inválida.' });
  await q(
    'update polls set correct_option_id = $2, counted = true, closed = true, resolved_at = now() where id = $1',
    [req.params.id, optionId]
  );
  res.json({ ok: true });
}));

app.post('/api/admin/polls/:id/visibility', requireAdmin, wrap(async (req, res) => {
  const r = await q('update polls set visible = $2 where id = $1', [req.params.id, Boolean(req.body?.visible)]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

app.delete('/api/admin/polls/:id', requireAdmin, wrap(async (req, res) => {
  const found = await tx(async (c) => {
    const exists = await c.query('select 1 from polls where id = $1 for update', [req.params.id]);
    if (!exists.rowCount) return false;
    // Se a enquete já tinha resposta, os pontos ficam guardados no ranking.
    await c.query(
      `insert into awards (poll_id, poll_title, user_id, hit, points, resolved_at)
       select p.id, p.title, v.user_id, (v.option_id = p.correct_option_id), p.points, p.resolved_at
       from polls p join votes v on v.poll_id = p.id
       where p.id = $1 and p.correct_option_id is not null and p.counted`,
      [req.params.id]
    );
    await c.query('delete from polls where id = $1', [req.params.id]);
    return true;
  });
  if (!found) return notFound(res);
  res.json({ ok: true });
}));

/* Zerar ranking: apaga os pontos guardados e desconta as enquetes já resolvidas */
app.post('/api/admin/ranking/reset', requireAdmin, wrap(async (req, res) => {
  await tx(async (c) => {
    await c.query('delete from awards');
    await c.query('update polls set counted = false');
  });
  res.json({ ok: true });
}));

app.post('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const { mode, streakEvery, streakBonus } = req.body || {};
  const entries = [];
  let rankingChanged = false;

  if (mode !== undefined) {
    if (mode !== 'replace' && mode !== 'accumulate') return res.status(400).json({ error: 'Modo inválido.' });
    entries.push(['mode', mode]);
  }
  if (streakEvery !== undefined || streakBonus !== undefined) {
    const every = Number(streakEvery);
    const bonus = Number(streakBonus);
    if (!Number.isInteger(every) || every < 0 || every > 50 || !Number.isInteger(bonus) || bonus < 0 || bonus > 1000) {
      return res.status(400).json({ error: 'Bônus inválido: use números inteiros (0 desativa).' });
    }
    entries.push(['streak_every', String(every)], ['streak_bonus', String(bonus)]);
    rankingChanged = true;
  }
  if (!entries.length) return res.status(400).json({ error: 'Nada para salvar.' });

  for (const [key, value] of entries) {
    await q(
      'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
      [key, value]
    );
  }
  if (rankingChanged) broadcast(); // o ranking mudou para todo mundo
  res.json({ ok: true });
}));

/* Cópia dos dados em JSON (os dados já ficam no Supabase; isto é uma segurança extra) */
app.get('/api/admin/backup', requireAdmin, wrap(async (req, res) => {
  const [users, polls, options, votes, awards, settings] = await Promise.all([
    q('select * from users order by created_at'),
    q('select * from polls order by created_at'),
    q('select * from poll_options order by poll_id, position'),
    q('select * from votes'),
    q('select * from awards order by id'),
    q('select * from settings'),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="bolao-backup-${day}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    users: users.rows,
    polls: polls.rows,
    options: options.rows,
    votes: votes.rows,
    awards: awards.rows,
    settings: settings.rows,
  });
}));

/* ---------- Páginas e arquivos estáticos ---------- */
app.get('/admin', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais.' });
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

/* ------------------------------------------------------------------ */
/* Início                                                              */
/* ------------------------------------------------------------------ */
(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  } catch (e) {
    console.error('Falha ao preparar o banco de dados:', e.message);
    process.exit(1);
  }
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Bolão rodando na porta ${PORT}`));

  const shutdown = () => {
    server.close();
    pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})();
