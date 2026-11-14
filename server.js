'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const webpush = require('web-push');

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const USER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
// Endereço do painel admin. Padrão: /admin. Troque pela variável ADMIN_PATH (ex.: um nome
// que só você sabe). Só letras, números, hífen e sublinhado.
let ADMIN_PATH = String(process.env.ADMIN_PATH || 'admin').trim().replace(/^\/+|\/+$/g, '');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(ADMIN_PATH) || ['api', 'healthz'].includes(ADMIN_PATH.toLowerCase())) {
  console.warn('[aviso] ADMIN_PATH inválido (use só letras, números, - e _). Usando "admin".');
  ADMIN_PATH = 'admin';
}
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000; // 12 horas
const TESTS_SESSION_MS = 60 * 60 * 1000; // a aba Testes fecha sozinha depois de 1 hora
const TWITCH_AVATAR_PREFIX = 'https://static-cdn.jtvnw.net/';

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD && !IS_PROD) {
  ADMIN_PASSWORD = 'admin123';
  console.warn('[aviso] ADMIN_PASSWORD não definida. Usando "admin123" (só para desenvolvimento).');
}
if (!ADMIN_PASSWORD) console.error('[erro] ADMIN_PASSWORD não definida: o painel admin está desativado.');
// Senha extra da aba Testes (além do login do admin). Sem ela em produção, a aba fica trancada.
let TESTS_PASSWORD = process.env.TESTS_PASSWORD || '';
if (!TESTS_PASSWORD && !IS_PROD) {
  TESTS_PASSWORD = 'teste123';
  console.warn('[aviso] TESTS_PASSWORD não definida. Usando "teste123" (só para desenvolvimento).');
}
if (!TESTS_PASSWORD) console.warn('[aviso] TESTS_PASSWORD não definida: a aba Testes do admin fica trancada.');
if (!DATABASE_URL) {
  console.error('[erro] DATABASE_URL não definida. Use a connection string do Supabase (veja o README).');
  process.exit(1);
}
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.warn('[aviso] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET não definidos: o login com a Twitch não vai funcionar.');
}

// Notificações push: opcionais. Sem as chaves VAPID, o site funciona normal,
// só não oferece o botão de notificação. Gere as chaves com:
//   npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[aviso] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY não definidos: notificações push desativadas.');
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
let challenges = null; // módulo dos X1 Bolados, criado mais abaixo (challenges.js)

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
async function createSession(kind, userId, ttlMs, adminId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('insert into sessions (token_hash, kind, user_id, expires_at, admin_id) values ($1, $2, $3, $4, $5)', [
    sha(token),
    kind,
    userId,
    new Date(Date.now() + ttlMs),
    adminId,
  ]);
  return token;
}

/* ---------- Admins e níveis de acesso ---------- */
const PERMISSIONS = [
  { key: 'polls_create', group: 'Enquetes', label: 'Criar enquetes' },
  { key: 'polls_edit', group: 'Enquetes', label: 'Editar título, descrição, pontos, prazo, casa e tópico' },
  { key: 'polls_odds', group: 'Enquetes', label: 'Definir odd, tetos de aposta/ganho e pontos por opção' },
  { key: 'polls_resolve', group: 'Enquetes', label: 'Encerrar, reabrir e definir a resposta certa' },
  { key: 'polls_visibility', group: 'Enquetes', label: 'Ocultar ou mostrar enquetes na página' },
  { key: 'polls_delete', group: 'Enquetes', label: 'Excluir enquetes' },
  { key: 'topics', group: 'Outros', label: 'Gerenciar tópicos' },
  { key: 'house', group: 'Outros', label: 'Gerenciar contas da casa' },
  { key: 'users', group: 'Outros', label: 'Banir usuários e ajustar pontos' },
  { key: 'ranking', group: 'Outros', label: 'Zerar rankings e mexer no pódio semanal' },
  { key: 'prizes', group: 'Outros', label: 'Gerenciar prêmios' },
  { key: 'achievements', group: 'Outros', label: 'Gerenciar conquistas' },
  { key: 'settings', group: 'Outros', label: 'Configurações gerais (modo, bônus, notificações, trava de voto)' },
  { key: 'tests', group: 'Outros', label: 'Aba de testes (ainda pede a senha dela)' },
  { key: 'bot', group: 'Outros', label: 'Bot da Twitch (conectar, configurar e testar)' },
  { key: 'backup', group: 'Outros', label: 'Baixar backup' },
  { key: 'chat', group: 'Outros', label: 'Moderar o chat (apagar mensagens e silenciar)' },
  { key: 'challenges', group: 'Outros', label: 'X1 Bolado (ligar/desligar, decidir, anular e excluir)' },
];
const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Quem está logado no painel: o dono (sem admin_id) ou um admin com nível. As permissões são lidas do banco
// a cada requisição, então mudar o nível de alguém vale na hora.
async function getAdmin(req) {
  const token = parseCookies(req).asid;
  if (!token) return null;
  const { rows } = await q(
    `select s.admin_id, a.name, a.permissions
     from sessions s left join admins a on a.id = s.admin_id
     where s.token_hash = $1 and s.kind = 'admin' and s.expires_at > now()`,
    [sha(token)]
  );
  const r = rows[0];
  if (!r) return null;
  if (!r.admin_id) return { id: null, name: 'Dono', owner: true, perms: new Set(PERMISSION_KEYS) };
  if (!r.name) return null;
  return { id: r.admin_id, name: r.name, owner: false, perms: new Set(r.permissions) };
}
const adminView = (a) => ({ admin: true, name: a.name, owner: a.owner, permissions: [...a.perms] });
const can = (req, key) => Boolean(req.admin && (req.admin.owner || req.admin.perms.has(key)));
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
     where s.token_hash = $1 and s.kind = 'user' and s.expires_at > now() and not u.banned`,
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
    topicId: r.topic_id,
    house: Boolean(r.house),
    odds: Boolean(r.odds),
    poolOdds: Boolean(r.pool_odds),
    optionPoints: Boolean(r.option_points),
    showOptionPoints: r.show_option_points !== false,
    sumPoints: Boolean(r.sum_points),
    cancelled: Boolean(r.cancelled),
    maxStake: r.max_stake,
    maxWin: r.max_win,
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
    'select id, poll_id, label, is_house, points from poll_options where poll_id = any($1::text[]) order by poll_id, position',
    [polls.map((p) => p.id)]
  );
  for (const o of opts.rows) byId.get(o.poll_id).options.push({ id: o.id, text: o.label, isHouse: o.is_house, points: o.points });
  return polls;
}

// A opção "🏠 Casa" existe só pra registrar o voto das contas da casa; nunca aparece pra ninguém escolher.
const visibleOptions = (p) => p.options.filter((o) => !o.isHouse);
const houseWon = (p) => p.options.some((o) => o.isHouse && o.id === p.correctOptionId);

async function fetchVotes(pollIds) {
  if (!pollIds.length) return new Map();
  const { rows } = await q(
    `select v.poll_id, v.option_id, v.user_id, v.stake, u.display_name
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

// Chaves liga/desliga guardadas em settings: ligadas por padrão, só '0' desliga.
async function getFlag(key) {
  const { rows } = await q('select value from settings where key = $1', [key]);
  return !(rows[0] && rows[0].value === '0');
}
const getNotifyEnabled = () => getFlag('notify_enabled'); // aviso de enquete nova

/* Odd de uma opção = apostadores no total / apostadores nessa opção (mín. 1,00x).
   Só contam votos com aposta (stake): as contas da casa não entram na conta. */
const oddOf = (total, onOption) => (onOption > 0 ? total / onOption : null);
const payoutOf = (stake, total, onOption) => Math.round((stake * total) / onOption);
// Ganho líquido já com o teto de ganho da enquete (maxWin nulo = sem teto)
const netWin = (stake, total, onOption, maxWin) => {
  const net = payoutOf(stake, total, onOption) - stake;
  return maxWin ? Math.min(net, maxWin) : net;
};

// Ganho líquido de um voto numa enquete resolvida (aliases: v = votes, p = polls).
// Sem aposta: regra antiga (p.points se acertou). Com aposta: acertou = stake*odd - stake; errou = -stake.
const GAIN_SQL = `case
    when v.stake is null and p.option_points then
      (case when v.option_id = p.correct_option_id then
        (case when p.sum_points
          then p.points + coalesce((select po.points from poll_options po where po.id = v.option_id), 0)
          else coalesce((select po.points from poll_options po where po.id = v.option_id), p.points) end)
       else 0 end)
    when v.stake is null and p.pool_odds then
      (case when v.option_id = p.correct_option_id then
        least(floor(p.points::numeric
          / (select count(*) from votes t3 where t3.poll_id = v.poll_id and t3.option_id = p.correct_option_id))::int,
          coalesce(p.max_win, 2147483647))
       else 0 end)
    when v.stake is null then (case when v.option_id = p.correct_option_id then p.points else 0 end)
    when v.option_id = p.correct_option_id then
      least(
        round(v.stake::numeric
          * (select count(*) from votes t where t.poll_id = v.poll_id and t.stake is not null)
          / (select count(*) from votes t2 where t2.poll_id = v.poll_id and t2.stake is not null and t2.option_id = v.option_id)
        )::int - v.stake,
        coalesce(p.max_win, 2147483647))
    else -v.stake
  end`;

// Chat global: ligado por padrão; só desliga quando o admin salva '0' em settings.chat_enabled.
async function getChatEnabled() {
  return getFlag('chat_enabled');
}
// Mídia no chat: imagens, vídeos e auto-embed de links de imagem (png/jpeg…). Ligados por padrão.
async function getChatMediaFlags() {
  const [images, videos, embedLinks] = await Promise.all([
    getFlag('chat_images'),
    getFlag('chat_videos'),
    getFlag('chat_embed_links'),
  ]);
  return { images, videos, embedLinks };
}
function parseChatMediaUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return { error: 'URL de mídia inválida.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'A mídia precisa ser um link http ou https.' };
  if (s.length > 2000) return { error: 'URL de mídia muito longa.' };
  return { url: s };
}
function guessMediaType(url) {
  const path = String(url).split('?')[0].split('#')[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(path)) return 'image';
  if (/\.(mp4|webm|ogg|mov)$/i.test(path)) return 'video';
  return null;
}

// Trava de voto: ligada, quem já votou numa enquete não pode trocar nem refazer a aposta. Desligada por padrão.
async function getLockVotes() {
  const { rows } = await q("select value from settings where key = 'lock_votes'");
  return Boolean(rows[0] && rows[0].value === '1');
}

async function getMode() {
  const { rows } = await q("select value from settings where key = 'mode'");
  return rows[0] && rows[0].value === 'accumulate' ? 'accumulate' : 'replace';
}

function pollStatus(p) {
  if (p.cancelled) return 'cancelled';
  if (p.correctOptionId) return 'resolved';
  if (p.closed) return 'closed';
  if (p.closesAt && Date.parse(p.closesAt) <= Date.now()) return 'closed';
  return 'open';
}

/* Visão pública: só mostra resultados parciais depois que a votação fecha */
function publicPoll(p, votes, userId) {
  const status = pollStatus(p);
  const mine = userId ? votes.find((v) => v.user_id === userId) : null;
  // Enquete com odd mostra as contagens desde o início (a odd depende delas)
  const showResults = status !== 'open' || p.odds || p.poolOdds;
  const bets = p.odds ? votes.filter((v) => v.stake != null) : [];
  const countOn = (id) => bets.filter((v) => v.option_id === id).length;
  const myBet = p.odds && mine && mine.stake != null ? mine : null;
  // Ganho líquido de quem apostou (só depois do resultado)
  let myNet = null;
  if (p.odds && status === 'resolved' && myBet) {
    myNet = myBet.option_id === p.correctOptionId
      ? netWin(myBet.stake, bets.length, countOn(myBet.option_id), p.maxWin)
      : -myBet.stake;
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  // Pontos de quem acerta numa opção: só os da opção, ou (com "somar") os da enquete + os da opção
  const optGain = (o) => (o ? (p.sumPoints ? p.points + (o.points ?? 0) : (o.points ?? p.points)) : p.points);
  // Odd de prêmio fixo: a parte de cada acertador = pontos da enquete ÷ nº de acertadores (com o teto de ganho)
  const capWin = (n) => (p.maxWin ? Math.min(n, p.maxWin) : n);
  const poolShare = (winners) => (winners > 0 ? capWin(Math.floor(p.points / winners)) : 0);
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    points: p.points,
    closesAt: p.closesAt,
    topicId: p.topicId,
    status,
    createdAt: p.createdAt,
    totalVotes: p.odds ? bets.length : votes.length,
    odds: Boolean(p.odds),
    maxStake: p.odds ? p.maxStake : null,
    poolOdds: Boolean(p.poolOdds),
    optionPoints: Boolean(p.optionPoints),
    optionPointsHidden: Boolean(p.optionPoints && !p.showOptionPoints && status !== 'resolved'),
    maxWin: p.odds || p.poolOdds ? p.maxWin : null,
    options: visibleOptions(p).map((o) => {
      const base = {
        id: o.id,
        text: o.text,
        votes: showResults ? (p.odds ? countOn(o.id) : votes.filter((v) => v.option_id === o.id).length) : null,
      };
      // Pontos escondidos pelo admin só aparecem depois do resultado
      if (p.optionPoints && (p.showOptionPoints || status === 'resolved')) base.points = optGain(o);
      if (p.poolOdds) {
        // Parte do prêmio que a pessoa levaria se votasse aqui e esta opção fosse a certa
        const on = votes.filter((v) => v.option_id === o.id).length - (mine && mine.option_id === o.id ? 1 : 0);
        base.share = poolShare(on + 1);
      }
      if (p.odds) {
        // Odd que a pessoa receberia se apostasse agora nesta opção (sem contar a aposta atual dela)
        const total = bets.length - (myBet ? 1 : 0);
        const on = countOn(o.id) - (myBet && myBet.option_id === o.id ? 1 : 0);
        base.odd = round2(Math.max(1, (total + 1) / (on + 1)));
      }
      return base;
    }),
    myVote: mine ? mine.option_id : null,
    myStake: myBet ? myBet.stake : null,
    myNet,
    houseWon: status === 'resolved' && houseWon(p),
    correctOptionId: status === 'resolved' && !houseWon(p) ? p.correctOptionId : null,
    myHit: status === 'resolved' && mine ? mine.option_id === p.correctOptionId : null,
    myPoints:
      status === 'resolved' && mine && p.counted
        ? (p.odds && myBet ? myNet
          : p.optionPoints ? (mine.option_id === p.correctOptionId ? optGain(p.options.find((o) => o.id === p.correctOptionId)) : 0)
          : p.poolOdds ? (mine.option_id === p.correctOptionId ? poolShare(votes.filter((v) => v.option_id === p.correctOptionId).length) : 0)
          : (mine.option_id === p.correctOptionId ? p.points : 0))
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
    topicId: p.topicId,
    status: pollStatus(p),
    createdAt: p.createdAt,
    resolvedAt: p.resolvedAt,
    visible: p.visible,
    counted: p.counted,
    house: p.house,
    odds: p.odds,
    poolOdds: p.poolOdds,
    optionPoints: p.optionPoints,
    showOptionPoints: p.showOptionPoints,
    sumPoints: p.sumPoints,
    maxStake: p.maxStake,
    maxWin: p.maxWin,
    pool: p.odds ? votes.reduce((n, v) => n + (v.stake || 0), 0) : null,
    correctOptionId: p.correctOptionId,
    totalVotes: votes.length,
    houseWon: houseWon(p),
    hits: p.correctOptionId ? votes.filter((v) => v.option_id === p.correctOptionId).length : null,
    options: visibleOptions(p).map((o) => ({
      id: o.id,
      text: o.text,
      points: p.optionPoints ? (o.points ?? p.points) : null,
      voters: votes.filter((v) => v.option_id === o.id).map((v) => (v.stake != null ? `${v.display_name} (${v.stake} pts)` : v.display_name)),
    })),
  };
}

const EPOCH = '1970-01-01T00:00:00.000Z'; // "desde sempre": nenhum reset ainda aconteceu

/* Ranking geral e semanal são o MESMO histórico (votos + prêmios guardados),
   só filtrado por uma data de corte diferente — zerar um dos dois só move
   essa data pra "agora", sem apagar nada. */
async function getResetAts() {
  const { rows } = await q("select key, value from settings where key in ('weekly_reset_at', 'general_reset_at')");
  const get = (k) => rows.find((x) => x.key === k)?.value || EPOCH;
  return { weekly: get('weekly_reset_at'), general: get('general_reset_at') };
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

/* Emblemas: os níveis (nome, imagem, emoji, tipo e meta) são configuráveis pelo
   admin em /admin e ficam em achievement_defs. Uma vez que alguém desbloqueia um
   nível, o registro em "achievements" fica pra sempre — mesmo que o ranking seja
   zerado depois. Editar um nível existente atualiza como ele aparece pra quem já
   tem o emblema; apagar um nível remove o emblema de quem tinha (cascade). */
async function fetchAchievementDefs() {
  const { rows } = await q("select id, type, threshold, label, emoji, image_url, active from achievement_defs order by array_position(array['points','streak','titles','misses','missstreak'], type), threshold");
  return rows.map((r) => ({ id: r.id, type: r.type, threshold: r.threshold, label: r.label, emoji: r.emoji, imageUrl: r.image_url, active: r.active }));
}
const nextTier = (defsOfType, current) => {
  const next = defsOfType.find((t) => t.threshold > current);
  return next
    ? { id: next.id, label: next.label, emoji: next.emoji, imageUrl: next.imageUrl, threshold: next.threshold, remaining: next.threshold - current }
    : null;
};

/* Desbloqueia (grava no banco, sem duplicar) qualquer nível já alcançado e devolve,
   por usuário, a lista completa de emblemas conquistados até hoje. */
async function syncAchievements(list, defs) {
  const pointDefs = defs.filter((d) => d.type === 'points');
  const streakDefs = defs.filter((d) => d.type === 'streak');
  const titleDefs = defs.filter((d) => d.type === 'titles');
  const missDefs = defs.filter((d) => d.type === 'misses');
  const missStreakDefs = defs.filter((d) => d.type === 'missstreak');
  const userIds = [];
  const defIds = [];
  for (const s of list) {
    for (const t of pointDefs) if (s.points >= t.threshold) { userIds.push(s.userId); defIds.push(t.id); }
    for (const t of streakDefs) if (s.bestStreak >= t.threshold) { userIds.push(s.userId); defIds.push(t.id); }
    for (const t of titleDefs) if (s.titles >= t.threshold) { userIds.push(s.userId); defIds.push(t.id); }
    for (const t of missDefs) if (s.misses >= t.threshold) { userIds.push(s.userId); defIds.push(t.id); }
    for (const t of missStreakDefs) if (s.bestMissStreak >= t.threshold) { userIds.push(s.userId); defIds.push(t.id); }
  }
  if (userIds.length) {
    await q(
      `insert into achievements (user_id, code)
       select * from unnest($1::text[], $2::text[])
       on conflict (user_id, code) do nothing`,
      [userIds, defIds]
    );
  }
  const ids = list.map((s) => s.userId);
  if (!ids.length) return new Map();
  const defById = new Map(defs.map((d) => [d.id, d]));
  const { rows } = await q('select user_id, code, unlocked_at from achievements where user_id = any($1::text[])', [ids]);
  const byUser = new Map();
  for (const r of rows) {
    const meta = defById.get(r.code);
    if (!meta) continue; // o nível foi apagado depois de desbloqueado
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push({ ...meta, unlockedAt: iso(r.unlocked_at) });
  }
  const typeOrder = ['points', 'streak', 'titles', 'misses', 'missstreak'];
  for (const arr of byUser.values()) {
    arr.sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) || a.threshold - b.threshold);
  }
  return byUser;
}

/* Classificação e histórico de cada participante. Soma duas fontes:
   1) enquetes resolvidas que ainda existem (trocar a resposta certa recalcula);
   2) rodadas "guardadas" (tabela awards): enquetes apagadas ou reabertas mantendo os pontos.
   "Zerar ranking" limpa as duas. Os resultados são lidos em ordem cronológica
   para calcular a sequência de acertos e o bônus (se ativado). */
/* Prêmio único. Pra cada prêmio livre, o dono é quem cruzou a pontuação primeiro
   (empate: mais pontos naquele momento). Contas da casa, banidos e quem já perdeu o
   prêmio ficam de fora. A gravação só vale se o prêmio ainda estiver livre, então duas
   contas simultâneas nunca geram dois donos. Devolve os prêmios de cada dono. */
async function syncPrizes(list, openPrizes, removed, reachByUser) {
  const blocked = new Set(removed.map((r) => `${r.prize_id}:${r.user_id}`));
  for (const pz of openPrizes) {
    const cands = list
      .filter((s) => !s.isHouse && !s.isTest && !blocked.has(`${pz.id}:${s.userId}`) && (reachByUser.get(s.userId) || {})[pz.id])
      .map((s) => ({ userId: s.userId, ...reachByUser.get(s.userId)[pz.id] }));
    if (!cands.length) continue;
    const when = (x) => (x ? new Date(x).getTime() : 0);
    cands.sort((a, b) => when(a.at) - when(b.at) || b.points - a.points || a.userId.localeCompare(b.userId));
    const w = cands[0];
    const claim = await q(
      'update prizes set holder_id = $1, open = false, won_at = $2 where id = $3 and open and holder_id is null',
      [w.userId, w.at || new Date().toISOString(), pz.id]
    );
    // Só quem de fato levou o prêmio dispara o aviso (rowCount 0 = outro cálculo chegou antes)
    if (claim.rowCount) {
      const winner = list.find((s) => s.userId === w.userId);
      notifyPrizeWon(winner ? winner.name : 'Alguém', pz.name)
        .catch((e) => console.error('Notificação de prêmio falhou:', e.message));
      botNotify('prize', { usuario: (winner && (winner.login || winner.name)) || 'alguém', nome: winner ? winner.name : 'Alguém', premio: pz.name, link: siteUrl() })
        .catch((e) => console.error('[bot]', e.message));
    }
  }
  const { rows } = await q('select id, name, emoji, image_url, description, holder_id, won_at from prizes where holder_id is not null order by won_at');
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.holder_id)) byUser.set(r.holder_id, []);
    byUser.get(r.holder_id).push({ id: r.id, name: r.name, emoji: r.emoji, imageUrl: r.image_url, description: r.description, wonAt: iso(r.won_at) });
  }
  return byUser;
}

/* Resultado dos X1 Bolados já decididos (com vencedor), uma linha por participante: +aposta para quem ganhou,
   −aposta para quem perdeu. Empate (sem vencedor), pendente, recusado e anulado não mexem em pontos. */
const CHALLENGE_RESULTS_SQL = `select r.user_id, r.delta, r.at, r.title, r.versus, r.my_side
  from (
    select c.winner_id as user_id, c.stake as delta, c.resolved_at as at, c.title,
           lu.display_name as versus,
           case when c.winner_id = c.creator_id then c.creator_side else c.opponent_side end as my_side
    from challenges c join users lu on lu.id = (case when c.winner_id = c.creator_id then c.opponent_id else c.creator_id end)
    where c.status = 'settled' and c.winner_id is not null
    union all
    select (case when c.winner_id = c.creator_id then c.opponent_id else c.creator_id end), -c.stake, c.resolved_at, c.title,
           wu.display_name,
           case when c.winner_id = c.creator_id then c.opponent_side else c.creator_side end
    from challenges c join users wu on wu.id = c.winner_id
    where c.status = 'settled' and c.winner_id is not null
  ) r
  where r.at > $1`;

async function computeStandings() {
  const { general: generalResetAt } = await getResetAts();
  const [users, results, rounds, rule, achDefs, titleRows, adjRows, prizeRows, removedRows, challengeRows] = await Promise.all([
    q('select id, display_name, login, avatar_url, is_house, is_test, name_color from users where not banned'),
    q(
      `select r.user_id, r.poll_title, r.chosen, r.correct, r.points, r.hit, r.at, r.gain, r.stake
       from (
         select v.user_id, p.title as poll_title, oc.label as chosen, cc.label as correct,
                p.points, (v.option_id = p.correct_option_id) as hit, p.resolved_at as at,
                ${GAIN_SQL} as gain, v.stake
         from votes v
         join polls p on p.id = v.poll_id
         left join poll_options oc on oc.id = v.option_id
         left join poll_options cc on cc.id = p.correct_option_id
         where p.correct_option_id is not null and p.counted and p.resolved_at > $1
         union all
         select user_id, poll_title, null, null, points, hit, resolved_at,
                coalesce(gain, case when hit then points else 0 end), null::int from awards
         where resolved_at is null or resolved_at > $1
       ) r
       order by r.at nulls first, r.poll_title`,
      [generalResetAt]
    ),
    q(
      `select ((select count(*) from polls where correct_option_id is not null and counted and resolved_at > $1)
              + (select count(distinct poll_id) from awards where resolved_at is null or resolved_at > $1))::int as n`,
      [generalResetAt]
    ),
    getStreakRule(),
    fetchAchievementDefs(),
    q('select user_id, count(*)::int as n from hall_places where place = 1 group by user_id'),
    q('select user_id, delta, created_at as at from point_adjustments where created_at > $1', [generalResetAt]),
    q('select id, name, points from prizes where open and holder_id is null'),
    q('select prize_id, user_id from prize_removed'),
    q(CHALLENGE_RESULTS_SQL, [generalResetAt]),
  ]);

  const stats = new Map(users.rows.map((u) => [u.id, {
    userId: u.id,
    name: u.display_name,
    login: u.login,
    avatar: u.avatar_url,
    isHouse: u.is_house,
    isTest: u.is_test,
    nameColor: normalizeNameColor(u.name_color),
    points: 0,
    hits: 0,
    played: 0,
    streak: 0,
    bestStreak: 0,
    misses: 0,
    missStreak: 0,
    bestMissStreak: 0,
    titles: 0,
    bonus: 0,
    adjust: 0,
    challengesWon: 0,
    challengesLost: 0,
    challengeNet: 0,
    history: [],
  }]));

  // Prêmio único: pra cada prêmio livre, guarda quando cada pessoa cruzou a pontuação
  const openPrizes = prizeRows.rows;
  const reachByUser = new Map();
  const trackPrizes = (s, at) => {
    for (const pz of openPrizes) {
      const mine = reachByUser.get(s.userId) || {};
      if (!mine[pz.id] && s.points >= pz.points) {
        mine[pz.id] = { at, points: s.points };
        reachByUser.set(s.userId, mine);
      }
    }
  };

  // Títulos semanais vêm do hall da fama e não dependem das datas de "zerar"
  for (const t of titleRows.rows) {
    const s = stats.get(t.user_id);
    if (s) s.titles = t.n;
  }

  // Resultados e ajustes manuais, em ordem cronológica (sem data = mais antigo)
  const when = (x) => (x ? new Date(x).getTime() : 0);
  const events = [
    ...results.rows.map((r) => ({ ...r, kind: 'result' })),
    ...adjRows.rows.map((a) => ({ user_id: a.user_id, delta: a.delta, at: a.at, kind: 'adjust' })),
    ...challengeRows.rows.map((c) => ({ ...c, kind: 'challenge' })),
  ].sort((a, b) => when(a.at) - when(b.at));

  for (const r of events) {
    const s = stats.get(r.user_id);
    if (!s) continue;
    if (r.kind === 'adjust') {
      s.points += r.delta;
      s.adjust += r.delta;
      trackPrizes(s, r.at);
      continue;
    }
    if (r.kind === 'challenge') {
      // X1 Bolado: mexe só nos pontos (não conta como palpite, acerto nem sequência)
      s.points += r.delta;
      s.challengeNet += r.delta;
      if (r.delta > 0) s.challengesWon += 1; else s.challengesLost += 1;
      s.history.push({
        title: `⚔️ ${r.title}`,
        challenge: true,
        versus: r.versus,
        chosen: r.my_side,
        correct: null,
        hit: r.delta > 0,
        points: r.delta,
        stake: Math.abs(r.delta),
        bonus: 0,
        at: iso(r.at),
      });
      trackPrizes(s, r.at);
      continue;
    }
    s.played += 1;
    let bonus = 0;
    if (r.hit) {
      s.hits += 1;
      s.points += r.gain;
      s.streak += 1;
      s.missStreak = 0;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (rule.every > 0 && s.streak % rule.every === 0) {
        bonus = rule.bonus;
        s.bonus += bonus;
        s.points += bonus;
      }
    } else {
      s.streak = 0;
      s.misses += 1;
      s.missStreak += 1;
      s.bestMissStreak = Math.max(s.bestMissStreak, s.missStreak);
      s.points += r.gain; // aposta perdida (negativo); enquete normal soma 0
    }
    s.history.push({
      title: r.poll_title,
      chosen: r.chosen,
      correct: r.correct,
      hit: r.hit,
      points: r.gain,
      stake: r.stake,
      bonus,
      at: iso(r.at),
    });
    trackPrizes(s, r.at);
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

  const achByUser = await syncAchievements(list, achDefs);
  const heldPrizes = await syncPrizes(list, openPrizes, removedRows.rows, reachByUser);
  for (const s of list) {
    s.prizes = heldPrizes.get(s.userId) || [];
    const achs = (achByUser.get(s.userId) || []).filter((a) => a.active); // níveis ocultos não aparecem
    s.achievements = achs;
    const topOf = (type) => {
      const of = achs.filter((a) => a.type === type);
      return of.length ? of[of.length - 1] : null; // já vem ordenado do menor pro maior nível
    };
    s.badges = { points: topOf('points'), streak: topOf('streak'), titles: topOf('titles'), misses: topOf('misses'), missstreak: topOf('missstreak') };
  }

  return {
    ranking: list,
    resolved: rounds.rows[0].n,
    rule,
    pointTiers: achDefs.filter((d) => d.active && d.type === 'points'),
    streakTiers: achDefs.filter((d) => d.active && d.type === 'streak'),
    resetAt: generalResetAt,
  };
}

/* Ranking semanal: mesmos dados do geral, só que cortados por uma data mais
   recente. Não tem emblema, sequência nem histórico — é só o placar da semana. */
async function computeWeeklyStandings() {
  const { weekly: weeklyResetAt } = await getResetAts();
  const [users, totals, adj, chal] = await Promise.all([
    q('select id, display_name, login, avatar_url, is_house, is_test, name_color from users where not banned'),
    q(
      `select r.user_id,
              coalesce(sum(r.gain), 0)::int as points,
              (count(*) filter (where r.hit))::int as hits,
              count(*)::int as played
       from (
         select v.user_id, (v.option_id = p.correct_option_id) as hit, ${GAIN_SQL} as gain
         from votes v
         join polls p on p.id = v.poll_id
         where p.correct_option_id is not null and p.counted and p.resolved_at > $1
         union all
         select user_id, hit, coalesce(gain, case when hit then points else 0 end) from awards
         where resolved_at is null or resolved_at > $1
       ) r
       group by r.user_id`,
      [weeklyResetAt]
    ),
    q('select user_id, sum(delta)::int as delta from point_adjustments where created_at > $1 group by user_id', [weeklyResetAt]),
    q('select user_id, sum(delta)::int as delta from (' + CHALLENGE_RESULTS_SQL + ') x group by user_id', [weeklyResetAt]),
  ]);

  const byUser = new Map(totals.rows.map((r) => [r.user_id, r]));
  const adjByUser = new Map(adj.rows.map((r) => [r.user_id, r.delta]));
  for (const r of chal.rows) adjByUser.set(r.user_id, (adjByUser.get(r.user_id) || 0) + r.delta); // X1 Bolados entram como ajuste de pontos
  const list = users.rows.map((u) => {
    const t = byUser.get(u.id);
    return {
      userId: u.id,
      name: u.display_name,
      login: u.login,
      avatar: u.avatar_url,
      isHouse: u.is_house,
      isTest: u.is_test,
      nameColor: normalizeNameColor(u.name_color),
      points: (t ? t.points : 0) + (adjByUser.get(u.id) || 0),
      hits: t ? t.hits : 0,
      played: t ? t.played : 0,
    };
  });
  list.sort((a, b) => b.points - a.points || b.hits - a.hits || a.name.localeCompare(b.name, 'pt-BR'));
  let pos = 0;
  let prev = null;
  list.forEach((s, i) => {
    if (!prev || s.points !== prev.points || s.hits !== prev.hits) pos = i + 1;
    s.position = pos;
    prev = s;
  });
  return { ranking: list, resetAt: weeklyResetAt };
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

  // Tetos da enquete com odd (opcionais): vazio = sem limite
  const limit = (raw) => (raw === undefined || raw === null || raw === '' ? null : Number(raw));
  const maxStake = limit(body?.maxStake);
  const maxWin = limit(body?.maxWin);
  for (const v of [maxStake, maxWin]) {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 1000000)) {
      return { error: 'Os tetos precisam ser números inteiros entre 1 e 1000000 (ou ficar em branco, sem limite).' };
    }
  }
  const odds = body?.odds === true;
  const poolOdds = body?.poolOdds === true;
  if (odds && poolOdds) return { error: 'Escolha só um tipo de odd: aposta de pontos do ranking ou prêmio fixo dividido.' };
  const optionPoints = body?.optionPoints === true;
  if (optionPoints && (odds || poolOdds)) return { error: 'Pontos por opção não combina com odd: escolha só um dos dois.' };
  const out = {
    title, description, points, closesAt, house: body?.house === true, odds, poolOdds, optionPoints,
    showOptionPoints: body?.showOptionPoints !== false,
    sumPoints: optionPoints && body?.sumPoints === true,
    maxStake: odds ? maxStake : null, maxWin: odds || poolOdds ? maxWin : null,
  };
  if (requireOptions) {
    const raw = Array.isArray(body?.options) ? body.options : [];
    let parsed = raw.map((o) => String(o).trim()).filter(Boolean).map((line) => {
      if (!optionPoints) return { text: line };
      // Pontos por opção: cada linha é "Texto | pontos"
      const cut = line.lastIndexOf('|');
      const rawPts = cut < 0 ? '' : line.slice(cut + 1).trim();
      const pts = rawPts === '' ? NaN : Number(rawPts); // vazio não vale 0: o admin precisa escrever o número
      return { text: cut < 0 ? line : line.slice(0, cut).trim(), points: pts, line };
    });
    const bad = parsed.find((o) => optionPoints && (!Number.isInteger(o.points) || o.points < 0 || o.points > 1000 || !o.text));
    if (bad) return { error: `A opção "${bad.line || bad.text}" precisa de pontos: escreva "Texto | pontos" (de 0 a 1000).` };
    parsed = parsed.filter((o, i) => parsed.findIndex((x) => x.text === o.text) === i);
    if (parsed.length < 1 || parsed.length > 10) return { error: 'Informe de 1 a 10 opções diferentes.' };
    if (parsed.some((o) => o.text.length > 100)) return { error: 'Cada opção pode ter no máximo 100 caracteres.' };
    out.options = parsed.map((o) => ({ id: uid(), text: o.text, points: optionPoints ? o.points : null }));
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
      // img-src aceita qualquer https: porque o admin escolhe o link da imagem de cada conquista
      "img-src 'self' data: https:; media-src 'self' https:; script-src 'self'; frame-ancestors 'none'"
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
function broadcastChat(payload) {
  const data = JSON.stringify(payload);
  // O canal de eventos é aberto a visitantes: o chat só é entregue a conexões de quem está logado
  for (const res of sseClients) if (res.chatUser) res.write(`event: chat\ndata: ${data}\n\n`);
}

app.get('/api/events', wrap(async (req, res) => {
  let chatUser = null;
  try { chatUser = await currentUser(req); } catch (_) { /* visitante */ }
  res.chatUser = chatUser ? chatUser.id : null;
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
}));

// Batida a cada 25s para o proxy do Render não derrubar conexões ociosas
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000).unref();

// Qualquer alteração feita pelo admin avisa as páginas abertas
const QUIET_ADMIN_PATHS = new Set(['/login', '/logout', '/settings']);

/* ---------- Histórico de ações do admin ---------- */
// [método, caminho, texto da ação, (body, ctx) => detalhe]. Só ações que mudam algo entram aqui.
const nameOf = (b) => b?.name || b?.title || b?.label || null;
const ADMIN_ACTIONS = [
  ['POST', /^\/login$/, 'Entrou no painel'],
  ['GET', /^\/backup$/, 'Baixou o backup'],
  ['POST', /^\/polls$/, 'Criou a enquete', (b) => b?.title],
  ['PUT', /^\/polls\/[^/]+$/, 'Editou a enquete', (b, c) => c.title],
  ['POST', /^\/polls\/[^/]+\/topic$/, 'Moveu a enquete de tópico', (b, c) => c.title],
  ['POST', /^\/polls\/[^/]+\/close$/, 'Encerrou a votação', (b, c) => c.title],
  ['POST', /^\/polls\/[^/]+\/cancel$/, 'Cancelou a enquete (pontos devolvidos)', (b, c) => c.title],
  ['POST', /^\/polls\/[^/]+\/reopen$/, 'Reabriu a votação', (b, c) => c.title],
  ['POST', /^\/polls\/[^/]+\/resolve$/, 'Definiu o resultado da enquete', (b, c) => c.title],
  ['POST', /^\/polls\/[^/]+\/visibility$/, 'Mudou a visibilidade da enquete', (b, c) => `${c.title || ''} → ${b?.visible ? 'visível' : 'oculta'}`],
  ['DELETE', /^\/polls\/[^/]+$/, 'Excluiu a enquete', (b, c) => c.title],
  ['POST', /^\/topics$/, 'Criou um tópico', (b) => nameOf(b)],
  ['PUT', /^\/topics\/[^/]+$/, 'Renomeou um tópico', (b, c) => `${c.name || ''} → ${nameOf(b) || ''}`],
  ['DELETE', /^\/topics\/[^/]+$/, 'Excluiu um tópico', (b, c) => c.name],
  ['POST', /^\/house-accounts$/, 'Criou uma conta da casa', (b) => nameOf(b)],
  ['PUT', /^\/house-accounts\/[^/]+$/, 'Editou uma conta da casa', (b, c) => c.user],
  ['DELETE', /^\/house-accounts\/[^/]+$/, 'Removeu uma conta da casa', (b, c) => c.user],
  ['POST', /^\/ranking\/reset-weekly$/, 'Zerou o ranking semanal'],
  ['POST', /^\/ranking\/reset-general$/, 'Zerou o ranking geral'],
  ['DELETE', /^\/hall\/[^/]+$/, 'Removeu um registro do pódio semanal'],
  ['POST', /^\/prizes$/, 'Criou um prêmio', (b) => nameOf(b)],
  ['PUT', /^\/prizes\/[^/]+$/, 'Editou um prêmio', (b) => nameOf(b)],
  ['DELETE', /^\/prizes\/[^/]+$/, 'Excluiu um prêmio'],
  ['POST', /^\/prizes\/[^/]+\/remove$/, 'Tirou um prêmio do dono'],
  ['POST', /^\/prizes\/[^/]+\/release$/, 'Liberou um prêmio'],
  ['POST', /^\/users\/[^/]+\/ban$/, 'Baniu/desbaniu um usuário', (b, c) => `${c.user || ''}${b?.banned === false ? ' (desbaniu)' : ''}`],
  ['POST', /^\/users\/[^/]+\/points$/, 'Ajustou pontos de um usuário', (b, c) => `${c.user || ''}: ${Number(b?.delta) > 0 ? '+' : ''}${b?.delta}${b?.note ? ` (${b.note})` : ''}`],
  ['DELETE', /^\/adjustments\/[^/]+$/, 'Removeu um ajuste de pontos'],
  ['POST', /^\/settings$/, 'Mudou configurações', (b) => Object.keys(b || {}).map((k) => `${k}=${typeof b[k] === 'object' ? 'ok' : b[k]}`).join(', ')],
  ['POST', /^\/achievements$/, 'Criou uma conquista', (b) => nameOf(b)],
  ['PUT', /^\/achievements\/[^/]+$/, 'Editou uma conquista', (b) => nameOf(b)],
  ['POST', /^\/achievements\/[^/]+\/active$/, 'Ativou/desativou uma conquista'],
  ['DELETE', /^\/achievements\/[^/]+$/, 'Excluiu uma conquista'],
  ['DELETE', /^\/chat\/\d+$/, 'Apagou uma mensagem do chat'],
  ['DELETE', /^\/chat\/\d+\/purge$/, 'Removeu uma mensagem do chat do banco'],
  ['POST', /^\/chat\/purge-deleted$/, 'Removeu do banco as mensagens apagadas do chat'],
  ['POST', /^\/chat\/mute$/, 'Silenciou um usuário no chat', (b, c) => `${c.user || ''} (${b?.duration || 'permanent'})${b?.reason ? ` — ${b.reason}` : ''}`],
  ['DELETE', /^\/chat\/mute\/[^/]+$/, 'Tirou o silêncio de um usuário no chat', (b, c) => c.user],
  ['POST', /^\/challenges\/config$/, 'Mudou a configuração dos X1 Bolados', (b) => Object.keys(b || {}).map((k) => `${k}=${b[k]}`).join(', ')],
  ['POST', /^\/challenges\/[^/]+\/resolve$/, 'Decidiu o vencedor de um X1 Bolado', (b, c) => `${c.title || ''} → ${b?.winner}`],
  ['POST', /^\/challenges\/[^/]+\/void$/, 'Anulou um X1 Bolado (pontos devolvidos)', (b, c) => c.title],
  ['DELETE', /^\/challenges\/[^/]+$/, 'Excluiu um X1 Bolado', (b, c) => c.title],
  ['POST', /^\/bot\/config$/, 'Mudou a configuração do bot da Twitch'],
  ['POST', /^\/bot\/test$/, 'Enviou mensagem de teste do bot'],
  ['POST', /^\/bot\/disconnect$/, 'Desconectou a conta do bot'],
  ['POST', /^\/admins$/, 'Criou um admin', (b) => b?.name],
  ['PUT', /^\/admins\/[^/]+$/, 'Editou um admin', (b, c) => `${c.admin || ''}${b?.password ? ' (senha trocada)' : ''}${b?.permissions ? ' (permissões)' : ''}`],
  ['DELETE', /^\/admins\/[^/]+$/, 'Excluiu um admin', (b, c) => c.admin],
];

// Busca o nome do que vai ser alterado ANTES da ação (depois de excluir, já não dá para ler)
async function actionContext(path, body) {
  const ctx = {};
  let m;
  try {
    if ((m = path.match(/^\/polls\/([^/]+)/))) ctx.title = (await q('select title from polls where id = $1', [m[1]])).rows[0]?.title;
    else if (path === '/chat/mute' && body && body.userId) ctx.user = (await q('select display_name from users where id = $1', [String(body.userId)])).rows[0]?.display_name;
    else if ((m = path.match(/^\/(?:users|house-accounts|chat\/mute)\/([^/]+)/))) ctx.user = (await q('select display_name from users where id = $1', [m[1]])).rows[0]?.display_name;
    else if ((m = path.match(/^\/challenges\/([^/]+)/)) && m[1] !== 'config') ctx.title = (await q('select title from challenges where id = $1', [m[1]])).rows[0]?.title;
    else if ((m = path.match(/^\/topics\/([^/]+)/))) ctx.name = (await q('select name from poll_topics where id = $1', [m[1]])).rows[0]?.name;
    else if ((m = path.match(/^\/admins\/([^/]+)/))) ctx.admin = (await q('select name from admins where id = $1', [m[1]])).rows[0]?.name;
  } catch (_) { /* o histórico nunca pode derrubar a ação */ }
  return ctx;
}

// `path` é o caminho relativo a /api/admin, capturado na entrada: depois que a resposta termina o Express já
// restaurou req.url (caminho completo), e os padrões abaixo não casariam.
async function logAdminAction(req, ctx, path) {
  const hit = ADMIN_ACTIONS.find(([method, re]) => method === req.method && re.test(path));
  const a = req.admin;
  if (!hit || !a) return;
  let detail = null;
  try { detail = hit[3] ? hit[3](req.body, ctx) : null; } catch (_) { /* segue sem detalhe */ }
  await q('insert into admin_log (admin_id, admin_name, action, detail) values ($1, $2, $3, $4)', [
    a.id, a.owner ? 'Dono' : a.name, hit[2], detail ? String(detail).slice(0, 200) : null,
  ]);
  if (Math.random() < 0.02) await q("delete from admin_log where at < now() - interval '180 days'"); // guarda ~6 meses
}

app.use('/api/admin', (req, res, next) => {
  const path = req.path; // relativo ao /api/admin (só é assim agora, durante este middleware)
  // Consultas não entram no histórico, exceto baixar o backup
  if (req.method === 'GET' && path !== '/backup') return next();
  if (req.method !== 'GET' && !QUIET_ADMIN_PATHS.has(path)) {
    res.on('finish', () => {
      if (res.statusCode < 400) broadcast();
    });
  }
  actionContext(path, req.body).then((ctx) => {
    res.on('finish', () => {
      if (res.statusCode < 400) logAdminAction(req, ctx, path).catch((e) => console.error('[historico]', e.message));
    });
    next();
  });
});

/* Avisa quem se inscreveu quando uma enquete nova é publicada. Inscrições
   mortas (o navegador não existe mais) são removidas na hora. */
const short = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/* Envia um payload para uma lista de inscrições. Inscrições mortas (o navegador
   não existe mais) são removidas na hora. */
async function sendPush(subs, payload) {
  if (!PUSH_ENABLED || !subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (r) => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await q('delete from push_subscriptions where endpoint = $1', [r.endpoint]).catch(() => {});
      } else {
        console.error('Notificação push falhou:', e.message);
      }
    }
  }));
}

async function notifyNewPoll(title) {
  if (!PUSH_ENABLED) return;
  const { rows } = await q('select endpoint, p256dh, auth from push_subscriptions');
  await sendPush(rows, { title: 'Nova enquete no Bolão', body: short(title, 120), url: '/' });
}

/* Prêmio conquistado: avisa todos os inscritos com o nome de quem levou e do prêmio */
async function notifyPrizeWon(userName, prizeName) {
  if (!PUSH_ENABLED || !(await getFlag('notify_prize'))) return;
  const { rows } = await q(
    `select s.endpoint, s.p256dh, s.auth from push_subscriptions s
     left join users u on u.id = s.user_id
     where not coalesce(u.banned, false)`
  );
  await sendPush(rows, {
    title: '🏅 Prêmio conquistado!',
    body: `${short(userName, 40)} conquistou "${short(prizeName, 60)}"`,
    url: '/#ranking',
  });
}

/* Resultado: cada participante inscrito (e logado quando se inscreveu) que votou
   na enquete recebe "acertou +N" ou "dessa vez não deu". */
async function notifyPollResult(pollId) {
  if (!PUSH_ENABLED || !(await getFlag('notify_result'))) return;
  const { rows: pr } = await q('select title, points, correct_option_id, odds, pool_odds, option_points, sum_points, max_win from polls where id = $1', [pollId]);
  const poll = pr[0];
  if (!poll || !poll.correct_option_id) return;
  const { rows } = await q(
    `select s.endpoint, s.p256dh, s.auth, (v.option_id = $2) as hit, v.stake
     from votes v
     join push_subscriptions s on s.user_id = v.user_id
     join users u on u.id = v.user_id and not u.is_house and not u.banned
     where v.poll_id = $1`,
    [pollId, poll.correct_option_id]
  );
  const title = short(poll.title);
  if (poll.odds) {
    // Enquete com odd: cada pessoa recebe o próprio resultado (ganho/perda líquidos da aposta)
    const c = await q(
      `select count(*)::int as total, (count(*) filter (where option_id = $2))::int as won
       from votes where poll_id = $1 and stake is not null`,
      [pollId, poll.correct_option_id]
    );
    const { total, won } = c.rows[0];
    for (const r of rows.filter((x) => x.stake != null)) {
      if (r.hit) {
        const net = netWin(r.stake, total, won, poll.max_win);
        await sendPush([r], { title: '🎯 Você acertou!', body: `${net >= 0 ? '+' : ''}${net} pontos em \"${title}\" (odd ${oddOf(total, won).toFixed(2)}x)`, url: '/#ranking' });
      } else {
        await sendPush([r], { title: 'Resultado da enquete', body: `\"${title}\": você perdeu ${r.stake} pontos da aposta.`, url: '/' });
      }
    }
    return;
  }
  let gain = poll.points;
  if (poll.option_points) {
    const op = (await q('select points from poll_options where id = $1', [poll.correct_option_id])).rows[0]?.points;
    gain = poll.sum_points ? poll.points + (op ?? 0) : (op ?? poll.points);
  } else if (poll.pool_odds) {
    // Prêmio fixo dividido: a parte de cada acertador
    const w = (await q('select count(*)::int as n from votes where poll_id = $1 and option_id = $2', [pollId, poll.correct_option_id])).rows[0].n;
    gain = Math.floor(poll.points / Math.max(1, w));
    if (poll.max_win) gain = Math.min(gain, poll.max_win);
  }
  await sendPush(rows.filter((r) => r.hit), {
    title: '🎯 Você acertou!',
    body: gain > 0 ? `+${gain} pontos em "${title}"` : `Você acertou "${title}", mas essa opção vale 0 pontos.`,
    url: '/#ranking',
  });
  await sendPush(rows.filter((r) => !r.hit), {
    title: 'Resultado da enquete', body: `"${title}" já tem resposta. Dessa vez não deu.`, url: '/',
  });
}

/* Lembrete: ~1h antes de fechar, avisa quem ainda não votou (e inscrições sem
   participante ligado, que não dá pra saber). Cada enquete avisa uma vez só. */
async function notifyClosingSoon() {
  if (!PUSH_ENABLED || !(await getFlag('notify_closing'))) return;
  const { rows: polls } = await q(
    `update polls set closing_notified = true
     where not closing_notified and visible and not closed and correct_option_id is null
       and closes_at is not null and closes_at > now() and closes_at <= now() + interval '1 hour'
     returning id, title, closes_at`
  );
  for (const p of polls) {
    const { rows: subs } = await q(
      `select s.endpoint, s.p256dh, s.auth from push_subscriptions s
       left join users bu on bu.id = s.user_id
       where s.user_id is null
          or (not coalesce(bu.banned, false)
              and not exists (select 1 from votes v where v.poll_id = $1 and v.user_id = s.user_id))`,
      [p.id]
    );
    const mins = Math.max(1, Math.round((Date.parse(p.closes_at) - Date.now()) / 60000));
    const when = mins >= 60 ? '1 hora' : `${mins} min`;
    await sendPush(subs, { title: '⏰ Enquete fechando', body: `"${short(p.title)}" fecha em ${when}. Ainda dá tempo de votar!`, url: '/' });
  }
}

const requireUser = wrap(async (req, res, next) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'Entre com a Twitch para continuar.' });
  req.user = u;
  next();
});
const requireAdmin = wrap(async (req, res, next) => {
  req.admin = await getAdmin(req);
  if (!req.admin) return res.status(401).json({ error: 'Acesso restrito ao admin.' });
  next();
});
// Exige que o admin tenha ao menos uma das permissões listadas (o dono sempre passa)
const requirePerm = (...keys) => wrap(async (req, res, next) => {
  req.admin = await getAdmin(req);
  if (!req.admin) return res.status(401).json({ error: 'Acesso restrito ao admin.' });
  if (!keys.some((k) => can(req, k))) return res.status(403).json({ error: 'Seu nível de admin não permite esta ação.' });
  next();
});
const requireOwner = wrap(async (req, res, next) => {
  req.admin = await getAdmin(req);
  if (!req.admin) return res.status(401).json({ error: 'Acesso restrito ao admin.' });
  if (!req.admin.owner) return res.status(403).json({ error: 'Só o dono pode gerenciar admins.' });
  next();
});
// Cores de nome permitidas (identidade). null = cor padrão do tema.
const NAME_COLORS = [
  { id: 'default', label: 'Padrão', value: null },
  { id: 'red', label: 'Vermelho', value: '#E74C3C' },
  { id: 'orange', label: 'Laranja', value: '#E67E22' },
  { id: 'gold', label: 'Dourado', value: '#D4A017' },
  { id: 'green', label: 'Verde', value: '#27AE60' },
  { id: 'teal', label: 'Água', value: '#1ABC9C' },
  { id: 'blue', label: 'Azul', value: '#3498DB' },
  { id: 'purple', label: 'Roxo', value: '#9B59B6' },
  { id: 'pink', label: 'Rosa', value: '#E91E63' },
  { id: 'gray', label: 'Cinza', value: '#95A5A6' },
];
const NAME_COLOR_VALUES = new Set(NAME_COLORS.map((c) => c.value).filter(Boolean));
function normalizeNameColor(v) {
  if (v == null || v === '' || v === 'default') return null;
  const s = String(v).trim().toUpperCase();
  // cores da paleta (case-insensitive)
  for (const allowed of NAME_COLOR_VALUES) {
    if (allowed.toUpperCase() === s) return allowed;
  }
  // qualquer cor personalizada no formato #RRGGBB (vem do seletor de cores)
  if (/^#[0-9A-F]{6}$/.test(s)) return s;
  return null;
}
const userView = (u) => ({
  id: u.id,
  name: u.display_name,
  login: u.login,
  avatar: u.avatar_url,
  nameColor: normalizeNameColor(u.name_color),
});


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
    if ((await botAuth())?.bot_user_id === String(tw.id)) return res.redirect('/?login=bot'); // a conta do bot não vira participante

    const avatar =
      typeof tw.profile_image_url === 'string' && tw.profile_image_url.startsWith(TWITCH_AVATAR_PREFIX)
        ? tw.profile_image_url
        : null;
    const { rows } = await q(
      `insert into users (id, twitch_id, login, display_name, avatar_url)
       values ($1, $2, $3, $4, $5)
       on conflict (twitch_id) do update
         set login = excluded.login, display_name = excluded.display_name, avatar_url = excluded.avatar_url
       returning id, banned, (xmax = 0) as inserted`,
      [uid(), String(tw.id), String(tw.login), String(tw.display_name || tw.login), avatar]
    );
    if (rows[0].banned) return res.redirect('/?login=banido');
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
  const [chatEnabled, chatMedia] = await Promise.all([getChatEnabled(), getChatMediaFlags()]);
  res.json({
    user: u ? userView(u) : null,
    chatEnabled,
    chatMedia,
    nameColors: NAME_COLORS,
  });
}));

app.post('/api/me/name-color', requireUser, limit('name-color', 20, 60 * 1000), wrap(async (req, res) => {
  const color = normalizeNameColor(req.body?.color);
  // body.color pode ser null/'default' para resetar
  const raw = req.body?.color;
  const wantsDefault = raw === null || raw === '' || raw === 'default';
  const value = wantsDefault ? null : color;
  if (!wantsDefault && value == null) {
    return res.status(400).json({ error: 'Cor inválida. Escolha uma da paleta ou use o seletor de cores.' });
  }
  await q('update users set name_color = $2 where id = $1', [req.user.id, value]);
  const { rows } = await q('select * from users where id = $1', [req.user.id]);
  broadcast(); // ranking e outros clientes atualizam a cor
  res.json({ user: userView(rows[0]) });
}));


/* ---------- Notificações (Web Push) ---------- */
app.get('/api/push/public-key', (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Notificações push não estão configuradas neste servidor.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

function validSubscription(b) {
  return (
    b && typeof b.endpoint === 'string' && b.endpoint.startsWith('https://') && b.endpoint.length < 500 &&
    b.keys && typeof b.keys.p256dh === 'string' && typeof b.keys.auth === 'string' &&
    b.keys.p256dh.length < 200 && b.keys.auth.length < 200
  );
}

app.post('/api/push/subscribe', limit('push', 30, 60 * 60 * 1000), wrap(async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Notificações push não estão configuradas neste servidor.' });
  if (!validSubscription(req.body)) return res.status(400).json({ error: 'Inscrição inválida.' });
  const { endpoint, keys } = req.body;
  const u = await currentUser(req); // null se não estiver logado: a inscrição fica "anônima"
  await q(
    `insert into push_subscriptions (endpoint, p256dh, auth, user_id) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id`,
    [endpoint, keys.p256dh, keys.auth, u ? u.id : null]
  );
  res.status(201).json({ ok: true });
}));

app.post('/api/push/unsubscribe', wrap(async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '');
  if (endpoint) await q('delete from push_subscriptions where endpoint = $1', [endpoint]);
  res.json({ ok: true });
}));

/* ---------- Tópicos das enquetes ---------- */
async function fetchTopics() {
  const { rows } = await q('select id, name from poll_topics order by position, created_at');
  return rows;
}

async function fetchTopicsWithCounts() {
  const { rows } = await q(
    `select t.id, t.name, count(p.id)::int as polls
     from poll_topics t left join polls p on p.topic_id = t.id
     group by t.id, t.name, t.position, t.created_at
     order by t.position, t.created_at`
  );
  return rows;
}

/* ---------- Enquetes e votos ---------- */
app.get('/api/polls', wrap(async (req, res) => {
  // Tudo que não depende de outra coisa roda junto: cada consulta ao banco é uma ida e volta pela rede
  const [u, list, topics, lockVotes, showCreated, chatEnabled, chatMedia, challengesEnabled] = await Promise.all([
    currentUser(req),
    fetchPolls('where visible'),
    fetchTopics(),
    getLockVotes(),
    getFlag('show_poll_created'),
    getChatEnabled(),
    getChatMediaFlags(),
    challenges.enabled(),
  ]);
  const votes = await fetchVotes(list.map((p) => p.id));
  const rank = { open: 0, closed: 1, resolved: 2, cancelled: 3 };
  const deadline = (p) => (p.closesAt ? Date.parse(p.closesAt) : Number.MAX_SAFE_INTEGER);
  const polls = list.map((p) => publicPoll(p, votes.get(p.id) || [], u && u.id));
  polls.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if (a.status === 'open' && deadline(a) !== deadline(b)) return deadline(a) - deadline(b);
    return b.createdAt.localeCompare(a.createdAt);
  });
  // Saldo só é calculado quando há enquete com odd na página e a pessoa está logada
  const balance = u && polls.some((p) => p.odds) ? await availableBalance(u.id) : null;
  res.json({ polls, topics, lockVotes, showCreated, balance, chatEnabled, chatMedia, challengesEnabled });
}));

/* Saldo para apostar = pontos do ranking geral − o que está apostado em enquetes ainda sem resultado */
async function lockedStakes(client, userId, exceptPollId = '') {
  const { rows } = await client.query(
    `select coalesce(sum(v.stake), 0)::int as n
     from votes v join polls p on p.id = v.poll_id
     where v.user_id = $1 and v.stake is not null and p.correct_option_id is null and not p.cancelled and p.id <> $2`,
    [userId, exceptPollId]
  );
  // X1 Bolados: quem desafiou trava os pontos já na proposta; o desafiado, só depois de aceitar
  const ch = await client.query(
    `select coalesce(sum(stake), 0)::int as n from challenges
     where (status = 'active' and (creator_id = $1 or opponent_id = $1))
        or (status = 'pending' and creator_id = $1 and expires_at > now()
            and (poll_id is null or exists (select 1 from polls p where p.id = challenges.poll_id
                 and not p.closed and not p.cancelled and p.correct_option_id is null
                 and (p.closes_at is null or p.closes_at > now()))))`,
    [userId]
  );
  return rows[0].n + ch.rows[0].n;
}
async function availableBalance(userId, exceptPollId = '', client = pool) {
  const st = await computeStandings();
  const me = st.ranking.find((r) => r.userId === userId);
  return Math.max(0, (me ? me.points : 0) - (await lockedStakes(client, userId, exceptPollId)));
}

/* Registra o voto/aposta de um usuário. Usado pelo site e pelo painel de testes do admin.
   Devolve { status, error } em caso de recusa ou { poll } em caso de sucesso. */
async function castVote(pollId, userId, body) {
  const [poll] = await fetchPolls('where id = $1', [pollId]);
  if (!poll || !poll.visible) return { status: 404, error: 'Enquete não encontrada.' };
  if (pollStatus(poll) !== 'open') return { status: 409, error: 'A votação desta enquete já foi encerrada.' };
  const optionId = String(body?.optionId ?? '');
  if (!poll.options.some((o) => o.id === optionId && !o.isHouse)) return { status: 400, error: 'Opção inválida.' };
  if (await getLockVotes()) {
    const had = await q('select 1 from votes where poll_id = $1 and user_id = $2', [poll.id, userId]);
    if (had.rowCount) return { status: 409, locked: true, error: 'Você já votou nesta enquete e não pode trocar o voto.' };
  }
  if (poll.odds) {
    // Enquete com odd: o palpite vem junto com uma aposta em pontos do ranking
    const stake = Number(body?.stake);
    if (!Number.isInteger(stake) || stake < 1 || stake > 1000000) {
      return { status: 400, error: 'Informe quantos pontos quer apostar (número inteiro, mínimo 1).' };
    }
    if (poll.maxStake && stake > poll.maxStake) return { status: 400, error: `A aposta máxima desta enquete é ${poll.maxStake} ${poll.maxStake === 1 ? 'ponto' : 'pontos'}.` };
    const points = (await computeStandings()).ranking.find((r) => r.userId === userId)?.points || 0;
    const result = await tx(async (c) => {
      // Trava por pessoa: duas apostas ao mesmo tempo não conseguem gastar o mesmo saldo duas vezes
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [userId]);
      const free = points - (await lockedStakes(c, userId, poll.id));
      if (stake > free) return { free };
      await c.query(
        `insert into votes (poll_id, user_id, option_id, stake) values ($1, $2, $3, $4)
         on conflict (poll_id, user_id) do update set option_id = excluded.option_id, stake = excluded.stake, voted_at = now()`,
        [poll.id, userId, optionId, stake]
      );
      return { ok: true };
    });
    if (!result.ok) {
      const f = Math.max(0, result.free);
      return { status: 400, error: `Saldo insuficiente: ${f} ${f === 1 ? 'ponto disponível' : 'pontos disponíveis'} para apostar.` };
    }
  } else {
    await q(
      `insert into votes (poll_id, user_id, option_id) values ($1, $2, $3)
       on conflict (poll_id, user_id) do update set option_id = excluded.option_id, voted_at = now()`,
      [poll.id, userId, optionId]
    );
  }
  const votes = await fetchVotes([poll.id]);
  broadcast(); // as odds mudam para todo mundo
  return { poll, votes: votes.get(poll.id) || [] };
}

app.post('/api/polls/:id/vote', requireUser, wrap(async (req, res) => {
  const r = await castVote(req.params.id, req.user.id, req.body);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const balance = r.poll.odds ? await availableBalance(req.user.id) : null;
  res.json({ poll: publicPoll(r.poll, r.votes, req.user.id), balance });
}));

app.get('/api/ranking', wrap(async (req, res) => {
  const st = await computeStandings();
  res.json({
    ranking: st.ranking.map(({ history, ...row }) => row),
    resolved: st.resolved,
    rule: st.rule,
    resetAt: st.resetAt,
  });
}));

app.get('/api/ranking/weekly', wrap(async (req, res) => {
  res.json(await computeWeeklyStandings());
}));

/* Perfil público: só mostra enquetes já resolvidas, então não revela palpites em aberto */
app.get('/api/users/:id/profile', wrap(async (req, res) => {
  const [st, wk] = await Promise.all([computeStandings(), computeWeeklyStandings()]);
  const found = st.ranking.find((r) => r.userId === req.params.id);
  if (!found) return res.status(404).json({ error: 'Participante não encontrado.' });
  const weekly = wk.ranking.find((r) => r.userId === req.params.id);
  const { history, ...stats } = found;
  let hall = null;
  if (await getFlag('hall_visible')) {
    const { rows: hp } = await q(
      `select w.started_at, w.ended_at, p.place, p.points
       from hall_places p join hall_weeks w on w.id = p.week_id
       where p.user_id = $1 order by w.ended_at desc`,
      [req.params.id]
    );
    hall = {
      titles: hp.filter((r) => r.place === 1).length,
      podiums: hp.length,
      weeks: hp.map((r) => ({ startedAt: iso(r.started_at), endedAt: iso(r.ended_at), place: r.place, points: r.points })),
    };
  }
  res.json({
    ...stats,
    hall,
    weekly: { position: weekly ? weekly.position : null, points: weekly ? weekly.points : 0 },
    accuracy: stats.played ? Math.round((stats.hits / stats.played) * 100) : 0,
    rule: st.rule,
    nextPoints: nextTier(st.pointTiers, stats.points),
    nextStreak: nextTier(st.streakTiers, stats.bestStreak),
    history: history.slice().reverse(), // mais recentes primeiro
  });
}));

/* ---------- Admin ---------- */
app.post('/api/admin/login', limit('admin', 10, 15 * 60 * 1000), wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (name) {
    // Admin com nível de acesso: nome + senha
    const { rows } = await q('select id, password_hash from admins where lower(name) = lower($1)', [name]);
    if (!rows[0] || !checkPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Nome ou senha incorretos.' });
    }
    setCookie(res, 'asid', await createSession('admin', null, ADMIN_SESSION_MS, rows[0].id), ADMIN_SESSION_MS / 1000);
    req.admin = { id: rows[0].id, name, owner: false };
    return res.json({ ok: true });
  }
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'ADMIN_PASSWORD não está configurada no servidor.' });
  const given = sha(password);
  const expected = sha(ADMIN_PASSWORD);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  setCookie(res, 'asid', await createSession('admin', null, ADMIN_SESSION_MS), ADMIN_SESSION_MS / 1000);
  req.admin = { id: null, name: 'Dono', owner: true };
  res.json({ ok: true });
}));

app.post('/api/admin/logout', wrap(async (req, res) => {
  await destroySession(req, res, 'asid');
  res.json({ ok: true });
}));

app.get('/api/admin/me', wrap(async (req, res) => {
  const a = await getAdmin(req);
  res.json(a ? adminView(a) : { admin: false });
}));

/* Gerenciar admins (só o dono) */
const adminRow = (r) => ({ id: r.id, name: r.name, permissions: r.permissions, createdAt: iso(r.created_at) });

function parseAdminInput(body, creating) {
  const out = {};
  if (creating || body?.name !== undefined) {
    const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 30) return { error: 'O nome do admin precisa ter de 2 a 30 caracteres.' };
    out.name = name;
  }
  if (creating || (body?.password !== undefined && body.password !== '')) {
    const pw = String(body?.password ?? '');
    if (pw.length < 8 || pw.length > 100) return { error: 'A senha precisa ter de 8 a 100 caracteres.' };
    out.password = pw;
  }
  if (creating || body?.permissions !== undefined) {
    const perms = Array.isArray(body?.permissions) ? body.permissions.map(String) : [];
    if (perms.some((p) => !PERMISSION_KEYS.includes(p))) return { error: 'Permissão inválida.' };
    out.permissions = [...new Set(perms)];
  }
  return out;
}

app.get('/api/admin/log', requireOwner, wrap(async (req, res) => {
  const who = String(req.query.admin ?? '') || null;
  const before = Number(req.query.before) || null;
  const { rows } = await q(
    `select id, at, admin_name, action, detail from admin_log
     where ($1::text is null or admin_name = $1) and ($2::bigint is null or id < $2)
     order by id desc limit 101`,
    [who, before]
  );
  const names = (await q('select distinct admin_name from admin_log order by admin_name')).rows.map((r) => r.admin_name);
  res.json({
    entries: rows.slice(0, 100).map((r) => ({ id: r.id, at: iso(r.at), admin: r.admin_name, action: r.action, detail: r.detail })),
    hasMore: rows.length > 100,
    names,
  });
}));

app.get('/api/admin/admins', requireOwner, wrap(async (req, res) => {
  const { rows } = await q('select * from admins order by lower(name)');
  res.json({ admins: rows.map(adminRow), catalog: PERMISSIONS });
}));

app.post('/api/admin/admins', requireOwner, wrap(async (req, res) => {
  const input = parseAdminInput(req.body, true);
  if (input.error) return res.status(400).json({ error: input.error });
  const dup = await q('select 1 from admins where lower(name) = lower($1)', [input.name]);
  if (dup.rowCount) return res.status(409).json({ error: 'Já existe um admin com esse nome.' });
  await q('insert into admins (id, name, password_hash, permissions) values ($1, $2, $3, $4)', [
    uid(), input.name, hashPassword(input.password), input.permissions,
  ]);
  res.status(201).json({ ok: true });
}));

app.put('/api/admin/admins/:id', requireOwner, wrap(async (req, res) => {
  const input = parseAdminInput(req.body, false);
  if (input.error) return res.status(400).json({ error: input.error });
  const cur = await q('select id from admins where id = $1', [req.params.id]);
  if (!cur.rowCount) return notFound(res);
  if (input.name) {
    const dup = await q('select 1 from admins where lower(name) = lower($1) and id <> $2', [input.name, req.params.id]);
    if (dup.rowCount) return res.status(409).json({ error: 'Já existe um admin com esse nome.' });
    await q('update admins set name = $2 where id = $1', [req.params.id, input.name]);
  }
  if (input.permissions) await q('update admins set permissions = $2 where id = $1', [req.params.id, input.permissions]);
  if (input.password) {
    await q('update admins set password_hash = $2 where id = $1', [req.params.id, hashPassword(input.password)]);
    await q("delete from sessions where admin_id = $1 and kind = 'admin'", [req.params.id]); // senha nova = entra de novo
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/admins/:id', requireOwner, wrap(async (req, res) => {
  const r = await q('delete from admins where id = $1', [req.params.id]); // as sessões dele saem junto (cascade)
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

app.get('/api/admin/polls', requireAdmin, wrap(async (req, res) => {
  const list = await fetchPolls();
  const votes = await fetchVotes(list.map((p) => p.id));
  const users = await q('select count(*)::int as n from users');
  res.json({
    polls: list.map((p) => adminPoll(p, votes.get(p.id) || [])),
    topics: await fetchTopicsWithCounts(),
    users: users.rows[0].n,
    mode: await getMode(),
    streak: await getStreakRule(),
    notify: await getNotifyEnabled(),
    notifyResult: await getFlag('notify_result'),
    notifyClosing: await getFlag('notify_closing'),
    hallVisible: await getFlag('hall_visible'),
    lockVotes: await getLockVotes(),
    showPollCreated: await getFlag('show_poll_created'),
    chatEnabled: await getChatEnabled(),
    chatImages: (await getChatMediaFlags()).images,
    chatVideos: (await getChatMediaFlags()).videos,
    chatEmbedLinks: (await getChatMediaFlags()).embedLinks,
    pushEnabled: PUSH_ENABLED,
  });
}));

app.post('/api/admin/polls', requirePerm('polls_create'), wrap(async (req, res) => {
  const input = parsePollInput(req.body, true);
  if (input.error) return res.status(400).json({ error: input.error });
  if ((input.odds || input.poolOdds || input.optionPoints) && !can(req, 'polls_odds')) return res.status(403).json({ error: 'Seu nível de admin não permite criar enquete com odd.' });
  // Proteção: não deixa criar outra enquete com o mesmo nome (ignora maiúsculas e espaços nas pontas)
  const dup = await q('select 1 from polls where lower(btrim(title)) = lower($1) limit 1', [input.title]);
  if (dup.rowCount) return res.status(409).json({ error: 'Já existe uma enquete com esse nome. Use outro nome.' });
  const topicId = String(req.body?.topicId ?? '');
  const topic = await q('select id from poll_topics where id = $1', [topicId]);
  if (!topic.rowCount) return res.status(400).json({ error: 'Escolha o tópico da enquete.' });
  const id = uid();
  await tx(async (c) => {
    const mode = await c.query("select value from settings where key = 'mode'");
    // Modo "substituir": as enquetes anteriores DO MESMO TÓPICO saem da página principal.
    // Continuam no painel admin (e seguem valendo pontos quando forem resolvidas).
    if (!mode.rows[0] || mode.rows[0].value !== 'accumulate') {
      await c.query(
        'update polls set visible = false, closed = (closed or correct_option_id is null) where visible and topic_id = $1',
        [topicId]
      );
    }
    await c.query('insert into polls (id, title, description, points, closes_at, topic_id, house, odds, max_stake, max_win, pool_odds, option_points, show_option_points, sum_points) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)', [
      id,
      input.title,
      input.description,
      input.points,
      input.closesAt,
      topicId,
      input.house,
      input.odds,
      input.maxStake,
      input.maxWin,
      input.poolOdds,
      input.optionPoints,
      input.showOptionPoints,
      input.sumPoints,
    ]);
    for (const [i, o] of input.options.entries()) {
      await c.query('insert into poll_options (id, poll_id, label, position, points) values ($1, $2, $3, $4, $5)', [o.id, id, o.text, i, o.points]);
    }
  });
  // Só notifica se a chave geral estiver ligada E esta enquete não tiver sido publicada "sem avisar"
  const wantsNotify = req.body?.notify !== false;
  if (wantsNotify && (await getNotifyEnabled())) {
    notifyNewPoll(input.title).catch((e) => console.error('Notificação push falhou:', e.message));
  }
  if (wantsNotify) {
    // Bot da Twitch: tem as próprias chaves (ligado/desligado e aviso de enquete criada), independentes do push
    const tipo = input.odds ? 'com aposta de pontos' : input.poolOdds ? 'com prêmio dividido' : input.optionPoints ? 'com pontos por opção' : 'normal';
    const fecha = input.closesAt
      ? new Date(input.closesAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : 'quando o admin encerrar';
    botNotify('created', {
      titulo: input.title, opcoes: input.options.map((o) => o.text).join(' | ').slice(0, 150),
      tipo, pontos: input.points, fecha, link: baseUrl(req),
    }).catch((e) => console.error('[bot]', e.message));
  }
  res.status(201).json({ id });
}));

const notFound = (res) => res.status(404).json({ error: 'Enquete não encontrada.' });

app.put('/api/admin/polls/:id', requirePerm('polls_edit', 'polls_odds'), wrap(async (req, res) => {
  const input = parsePollInput(req.body, false);
  if (input.error) return res.status(400).json({ error: input.error });
  // Trocar entre enquete normal e com odd só é seguro enquanto ninguém votou
  const cur = await q('select odds, pool_odds, option_points, (select count(*)::int from votes where poll_id = polls.id) as n from polls where id = $1', [req.params.id]);
  if (!cur.rowCount) return notFound(res);
  {
    // Nível de acesso: só deixa mudar o que o admin tem permissão de mudar
    const [old] = await fetchPolls('where id = $1', [req.params.id]);
    const minute = (d) => (d ? Math.floor(new Date(d).getTime() / 60000) : null);
    const baseChanged = old.title !== input.title || (old.description || '') !== (input.description || '')
      || old.points !== input.points || old.showOptionPoints !== input.showOptionPoints || Boolean(old.house) !== input.house || minute(old.closesAt) !== minute(input.closesAt);
    const oddsChanged = Boolean(old.sumPoints) !== input.sumPoints || Boolean(old.odds) !== input.odds || Boolean(old.poolOdds) !== input.poolOdds || (old.maxStake || null) !== input.maxStake || (old.maxWin || null) !== input.maxWin;
    if (baseChanged && !can(req, 'polls_edit')) return res.status(403).json({ error: 'Seu nível de admin não permite editar título, descrição, pontos, prazo ou casa.' });
    if (oddsChanged && !can(req, 'polls_odds')) return res.status(403).json({ error: 'Seu nível de admin não permite mudar odd nem tetos de aposta.' });
  }
  if (cur.rows[0].option_points !== input.optionPoints) {
    return res.status(409).json({ error: 'Não dá para ligar ou desligar “pontos por opção” depois de publicar (as opções já foram criadas).' });
  }
  if (cur.rows[0].odds !== input.odds || cur.rows[0].pool_odds !== input.poolOdds) {
    if (cur.rows[0].n > 0) return res.status(409).json({ error: 'Já existem votos nesta enquete: não dá mais pra ligar ou desligar a odd.' });
  }
  const r = await q(`update polls set title = $2, description = $3, points = $4,
      closing_notified = (closing_notified and closes_at is not distinct from $5::timestamptz), closes_at = $5,
      house = $6, odds = $7, max_stake = $8, max_win = $9, pool_odds = $10, show_option_points = $11, sum_points = $12
    where id = $1`, [
    req.params.id,
    input.title,
    input.description,
    input.points,
    input.closesAt,
    input.house,
    input.odds,
    input.maxStake,
    input.maxWin,
    input.poolOdds,
    input.showOptionPoints,
    input.sumPoints,
  ]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

/* Muda a enquete de tópico */
app.post('/api/admin/polls/:id/topic', requirePerm('polls_edit'), wrap(async (req, res) => {
  const topicId = String(req.body?.topicId ?? '');
  const topic = await q('select id from poll_topics where id = $1', [topicId]);
  if (!topic.rowCount) return res.status(400).json({ error: 'Tópico inválido.' });
  const r = await q('update polls set topic_id = $2 where id = $1', [req.params.id, topicId]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

/* CRUD dos tópicos (o painel admin cria, renomeia e apaga) */
const MAX_TOPICS = 12;

function parseTopicName(body) {
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 30) return { error: 'O nome do tópico precisa ter de 1 a 30 caracteres.' };
  return { name };
}

app.post('/api/admin/topics', requirePerm('topics'), wrap(async (req, res) => {
  const input = parseTopicName(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const { rows } = await q('select count(*)::int as n, coalesce(max(position), -1)::int as maxpos from poll_topics');
  if (rows[0].n >= MAX_TOPICS) return res.status(400).json({ error: `O limite é de ${MAX_TOPICS} tópicos.` });
  const dup = await q('select 1 from poll_topics where lower(name) = lower($1)', [input.name]);
  if (dup.rowCount) return res.status(400).json({ error: 'Já existe um tópico com esse nome.' });
  const id = uid();
  await q('insert into poll_topics (id, name, position) values ($1, $2, $3)', [id, input.name, rows[0].maxpos + 1]);
  res.status(201).json({ id });
}));

app.put('/api/admin/topics/:id', requirePerm('topics'), wrap(async (req, res) => {
  const input = parseTopicName(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const dup = await q('select 1 from poll_topics where lower(name) = lower($1) and id <> $2', [input.name, req.params.id]);
  if (dup.rowCount) return res.status(400).json({ error: 'Já existe um tópico com esse nome.' });
  const r = await q('update poll_topics set name = $2 where id = $1', [req.params.id, input.name]);
  if (!r.rowCount) return res.status(404).json({ error: 'Tópico não encontrado.' });
  res.json({ ok: true });
}));

app.delete('/api/admin/topics/:id', requirePerm('topics'), wrap(async (req, res) => {
  const t = await q('select count(*)::int as total, count(*) filter (where id = $1)::int as found from poll_topics', [req.params.id]);
  if (!t.rows[0].found) return res.status(404).json({ error: 'Tópico não encontrado.' });
  if (t.rows[0].total <= 1) return res.status(400).json({ error: 'Precisa existir pelo menos um tópico.' });
  const used = await q('select count(*)::int as n from polls where topic_id = $1', [req.params.id]);
  if (used.rows[0].n > 0) {
    const n = used.rows[0].n;
    return res.status(400).json({ error: `Este tópico tem ${n} ${n === 1 ? 'enquete' : 'enquetes'}. Mova ou exclua antes de apagar o tópico.` });
  }
  await q('delete from poll_topics where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/admin/polls/:id/close', requirePerm('polls_resolve'), wrap(async (req, res) => {
  const r = await q('update polls set closed = true where id = $1', [req.params.id]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

/* Reabrir votação. Se a enquete já tem resposta e soma pontos, o admin escolhe:
   - "keep": os pontos atuais ficam guardados no ranking e os votos são limpos (nova rodada);
   - "zero": os pontos desta enquete saem do ranking (inclusive rodadas guardadas antes). */
/* Cancelar: a enquete fica na lista como "Cancelada", ninguém ganha nem perde pontos por ela (os pontos que ela já
   tivesse dado ou tirado também saem do ranking) e as apostas são devolvidas. Os votos continuam registrados e
   "Reabrir votação" desfaz o cancelamento. */
app.post('/api/admin/polls/:id/cancel', requirePerm('polls_resolve'), wrap(async (req, res) => {
  const result = await tx(async (c) => {
    const { rows } = await c.query('select cancelled from polls where id = $1 for update', [req.params.id]);
    if (!rows.length) return 'notfound';
    if (rows[0].cancelled) return 'already';
    await c.query('update polls set cancelled = true, closed = true, correct_option_id = null, resolved_at = null where id = $1', [req.params.id]);
    await challenges.cancelAllOfPoll(c, req.params.id, true); // X1 Bolados dessa enquete: tudo devolvido
    return 'ok';
  });
  if (result === 'notfound') return notFound(res);
  if (result === 'already') return res.status(409).json({ error: 'Esta enquete já está cancelada.' });
  res.json({ ok: true });
}));

app.post('/api/admin/polls/:id/reopen', requirePerm('polls_resolve'), wrap(async (req, res) => {
  const choice = req.body?.points;
  const result = await tx(async (c) => {
    const { rows } = await c.query('select correct_option_id, counted from polls where id = $1 for update', [req.params.id]);
    if (!rows.length) return 'notfound';
    const scoring = Boolean(rows[0].correct_option_id) && rows[0].counted;
    if (scoring && choice !== 'keep' && choice !== 'zero') return 'choose';
    if (scoring && choice === 'keep') {
      await c.query(
        `insert into awards (poll_id, poll_title, user_id, hit, points, resolved_at, gain)
         select p.id, p.title, v.user_id, (v.option_id = p.correct_option_id), p.points, p.resolved_at, ${GAIN_SQL}
         from polls p join votes v on v.poll_id = p.id
         where p.id = $1`,
        [req.params.id]
      );
      await c.query('delete from votes where poll_id = $1', [req.params.id]);
    }
    if (scoring && choice === 'keep') await challenges.detachSettledOfPoll(c, req.params.id); // resultado dos X1 Bolados fica gravado
    if (scoring && choice === 'zero') {
      await c.query('delete from awards where poll_id = $1', [req.params.id]);
    }
    await c.query(
      `update polls
       set closed = false, cancelled = false, correct_option_id = null, resolved_at = null,
           closes_at = case when closes_at is not null and closes_at <= now() then null else closes_at end
       where id = $1`,
      [req.params.id]
    );
    return 'ok';
  });
  if (result === 'notfound') return notFound(res);
  if (result === 'choose') return res.status(400).json({ error: 'Escolha o que fazer com os pontos desta enquete.' });
  if (choice === 'zero') await challenges.settlePollChallenges(req.params.id); // sem resposta: X1 Bolados voltam a ficar ativos
  res.json({ ok: true });
}));

/* Opção oculta "Casa" da enquete: guarda os votos das contas da casa (criada sob demanda) */
async function ensureHouseOption(pollId) {
  return tx(async (c) => {
    const existing = await c.query('select id from poll_options where poll_id = $1 and is_house limit 1', [pollId]);
    if (existing.rowCount) return existing.rows[0].id;
    const { rowCount } = await c.query('select 1 from polls where id = $1', [pollId]);
    if (!rowCount) return null;
    const pos = await c.query('select coalesce(max(position), -1) + 1 as n from poll_options where poll_id = $1', [pollId]);
    const id = uid();
    await c.query('insert into poll_options (id, poll_id, label, position, is_house) values ($1, $2, $3, $4, true)', [
      id, pollId, 'Casa', pos.rows[0].n,
    ]);
    return id;
  });
}

const upsertHouseVote = (pollId, userId, optionId) => q(
  `insert into votes (poll_id, user_id, option_id) values ($1, $2, $3)
   on conflict (poll_id, user_id) do update set option_id = excluded.option_id, voted_at = now()`,
  [pollId, userId, optionId]
);

app.post('/api/admin/polls/:id/resolve', requirePerm('polls_resolve'), wrap(async (req, res) => {
  let optionId;
  const pollRow = await q('select house, cancelled from polls where id = $1', [req.params.id]);
  if (!pollRow.rowCount) return notFound(res);
  if (pollRow.rows[0].cancelled) return res.status(409).json({ error: 'Esta enquete está cancelada. Reabra a votação antes de definir o resultado.' });
  const houseFlag = pollRow.rows[0].house;
  const pickHouse = async (raw) => {
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    if (!ids.length) return [];
    const { rows } = await q('select id from users where is_house and id = any($1::text[])', [ids]);
    return rows;
  };

  if (req.body?.house === true) {
    // "A casa ganha": ninguém acertou. Cria (se ainda não existir) uma opção
    // oculta pra essa enquete e "vota" nela só pelas contas da casa escolhidas.
    const ids = Array.isArray(req.body?.houseIds) ? req.body.houseIds.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'Escolha pelo menos uma conta da casa.' });
    const house = await pickHouse(ids);
    if (!house.length) {
      return res.status(400).json({ error: 'Nenhuma das contas escolhidas existe mais. Recarregue a página.' });
    }
    optionId = await ensureHouseOption(req.params.id);
    if (!optionId) return notFound(res);
    // Enquete com a opção "Casa": só as contas escolhidas ficam com o voto
    if (houseFlag) {
      await q('delete from votes where poll_id = $1 and user_id in (select id from users where is_house) and not (user_id = any($2::text[]))', [req.params.id, house.map((h) => h.id)]);
    }
    for (const h of house) await upsertHouseVote(req.params.id, h.id, optionId);
  } else {
    optionId = String(req.body?.optionId ?? '');
    const { rowCount: valid } = await q(
      'select 1 from poll_options where id = $1 and poll_id = $2 and not is_house',
      [optionId, req.params.id]
    );
    if (!valid) return res.status(400).json({ error: 'Opção inválida.' });
    // Enquete com a opção "Casa": as contas escolhidas erram (voto na opção oculta, que
    // nunca é a certa aqui) — perdem a sequência e o erro entra no histórico.
    if (houseFlag) {
      const losers = await pickHouse(req.body?.houseLoseIds);
      await q('delete from votes where poll_id = $1 and user_id in (select id from users where is_house)', [req.params.id]);
      if (losers.length) {
        const houseOpt = await ensureHouseOption(req.params.id);
        for (const h of losers) await upsertHouseVote(req.params.id, h.id, houseOpt);
      }
    }
  }

  const prev = await q('select correct_option_id from polls where id = $1', [req.params.id]);
  const r = await q(
    'update polls set correct_option_id = $2, counted = true, closed = true, resolved_at = now() where id = $1',
    [req.params.id, optionId]
  );
  if (!r.rowCount) return notFound(res);
  await challenges.settlePollChallenges(req.params.id); // X1 Bolados dessa enquete: o vencedor leva a aposta do outro
  await computeStandings(); // grava na hora os emblemas desbloqueados com este resultado
  // Só avisa na primeira vez que a enquete recebe resposta (corrigir a resposta não reenvia)
  if (!prev.rows[0]?.correct_option_id) {
    notifyPollResult(req.params.id).catch((e) => console.error('Notificação de resultado falhou:', e.message));
    botPollResult(req.params.id, baseUrl(req)).catch((e) => console.error('[bot]', e.message));
  }
  res.json({ ok: true });
}));

/* ---------- Contas da casa (fictícias) ---------- */
function parseHouseInput(body) {
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return { error: 'O nome precisa ter de 2 a 40 caracteres.' };
  let avatarUrl = String(body?.avatarUrl ?? '').trim();
  if (avatarUrl && (!avatarUrl.startsWith('https://') || avatarUrl.length > 500)) {
    return { error: 'A imagem precisa ser um link https:// válido.' };
  }
  return { name, avatarUrl: avatarUrl || null };
}

app.get('/api/admin/house-accounts', requireAdmin, wrap(async (req, res) => {
  const [{ rows }, st, wk] = await Promise.all([
    q('select id, display_name, avatar_url, created_at from users where is_house order by created_at'),
    computeStandings(),
    computeWeeklyStandings(),
  ]);
  const gen = new Map(st.ranking.map((s) => [s.userId, s]));
  const week = new Map(wk.ranking.map((s) => [s.userId, s]));
  res.json({
    accounts: rows.map((r) => ({
      id: r.id, name: r.display_name, avatarUrl: r.avatar_url, createdAt: iso(r.created_at),
      points: gen.has(r.id) ? gen.get(r.id).points : 0,
      weeklyPoints: week.has(r.id) ? week.get(r.id).points : 0,
      adjust: gen.has(r.id) ? gen.get(r.id).adjust : 0,
    })),
  });
}));

app.post('/api/admin/house-accounts', requirePerm('house'), wrap(async (req, res) => {
  const input = parseHouseInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const id = uid();
  await q(
    `insert into users (id, twitch_id, login, display_name, avatar_url, is_house)
     values ($1, $2, $3, $4, $5, true)`,
    [id, `house:${id}`, `casa-${id.slice(0, 8)}`, input.name, input.avatarUrl]
  );
  res.status(201).json({ id, name: input.name });
}));

app.put('/api/admin/house-accounts/:id', requirePerm('house'), wrap(async (req, res) => {
  const input = parseHouseInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const r = await q('update users set display_name = $2, avatar_url = $3 where id = $1 and is_house', [
    req.params.id, input.name, input.avatarUrl,
  ]);
  if (!r.rowCount) return res.status(404).json({ error: 'Conta da casa não encontrada.' });
  res.json({ ok: true });
}));

app.delete('/api/admin/house-accounts/:id', requirePerm('house'), wrap(async (req, res) => {
  const r = await q('delete from users where id = $1 and is_house', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Conta da casa não encontrada.' });
  res.json({ ok: true });
}));

app.post('/api/admin/polls/:id/visibility', requirePerm('polls_visibility'), wrap(async (req, res) => {
  const r = await q('update polls set visible = $2 where id = $1', [req.params.id, Boolean(req.body?.visible)]);
  if (!r.rowCount) return notFound(res);
  res.json({ ok: true });
}));

/* Excluir enquete. Se ela já tem resposta e soma pontos, o admin escolhe antes:
   - "keep": os pontos ficam guardados no ranking mesmo depois de apagada;
   - "zero": os pontos dela não entram no ranking. */
app.delete('/api/admin/polls/:id', requirePerm('polls_delete'), wrap(async (req, res) => {
  const choice = req.body?.points;
  const result = await tx(async (c) => {
    const { rows } = await c.query('select correct_option_id, counted from polls where id = $1 for update', [req.params.id]);
    if (!rows.length) return 'notfound';
    const scoring = Boolean(rows[0].correct_option_id) && rows[0].counted;
    if (scoring && choice !== 'keep' && choice !== 'zero') return 'choose';
    if (scoring && choice === 'keep') {
      await c.query(
        `insert into awards (poll_id, poll_title, user_id, hit, points, resolved_at, gain)
         select p.id, p.title, v.user_id, (v.option_id = p.correct_option_id), p.points, p.resolved_at, ${GAIN_SQL}
         from polls p join votes v on v.poll_id = p.id
         where p.id = $1`,
        [req.params.id]
      );
    }
    // "zero": não grava nada em awards, então os pontos dela não valem mais nada
    // X1 Bolados: com "manter" os já decididos ficam gravados (soltam-se da enquete); o resto é devolvido
    await challenges.cancelAllOfPoll(c, req.params.id, !(scoring && choice === 'keep'));
    await c.query('delete from polls where id = $1', [req.params.id]);
    return 'ok';
  });
  if (result === 'notfound') return notFound(res);
  if (result === 'choose') return res.status(400).json({ error: 'Escolha o que fazer com os pontos desta enquete.' });
  res.json({ ok: true });
}));

/* Zerar ranking: não apaga nada, só move a "data de corte" pra agora — tudo
   antes dela para de contar. Semanal mexe só na data semanal; geral mexe nas
   duas (já que o semanal é uma janela dentro do geral). Emblemas já
   desbloqueados nunca somem, mesmo depois de qualquer um dos dois. */
async function setResetAt(key, value) {
  await q(
    'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
    [key, value]
  );
}

/* Pódio da semana: top 3 por posição (empates dividem o lugar), contas da casa
   incluídas, sem quem não pontuou. A lista já vem ordenada de computeWeeklyStandings. */
function buildPodium(list) {
  const eligible = list.filter((r) => r.points > 0 && !r.isTest);
  const podium = [];
  let pos = 0;
  let prev = null;
  eligible.forEach((r, i) => {
    if (!prev || r.points !== prev.points || r.hits !== prev.hits) pos = i + 1;
    prev = r;
    if (pos <= 3) podium.push({ ...r, place: pos });
  });
  return podium;
}

/* Fecha a semana: grava o pódio no hall da fama (se alguém pontuou) e move as
   datas de corte. Tudo numa transação, pra nunca zerar sem registrar. */
async function closeWeek(extraResetKeys = []) {
  const wk = await computeWeeklyStandings();
  const podium = buildPodium(wk.ranking);
  const now = new Date().toISOString();
  await tx(async (c) => {
    if (podium.length) {
      const id = uid();
      await c.query('insert into hall_weeks (id, started_at, ended_at) values ($1, $2, $3)', [id, wk.resetAt, now]);
      for (const p of podium) {
        await c.query(
          'insert into hall_places (week_id, user_id, place, points, hits) values ($1, $2, $3, $4, $5)',
          [id, p.userId, p.place, p.points, p.hits]
        );
      }
    }
    for (const key of ['weekly_reset_at', ...extraResetKeys]) {
      await c.query(
        'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
        [key, now]
      );
    }
  });
  await computeStandings().catch(() => {}); // grava na hora as conquistas de título
  broadcast();
  return podium;
}

const podiumView = (podium) => podium.map((p) => ({ name: p.name, place: p.place, points: p.points }));

app.post('/api/admin/ranking/reset-weekly', requirePerm('ranking'), wrap(async (req, res) => {
  res.json({ ok: true, podium: podiumView(await closeWeek()) });
}));

app.post('/api/admin/ranking/reset-general', requirePerm('ranking'), wrap(async (req, res) => {
  res.json({ ok: true, podium: podiumView(await closeWeek(['general_reset_at'])) });
}));

/* ---------- Hall da fama ---------- */
async function fetchHall() {
  const { rows } = await q(
    `select w.id, w.started_at, w.ended_at, p.place, p.points, p.hits,
            u.id as user_id, u.display_name, u.login, u.avatar_url, u.is_house
     from hall_weeks w
     join hall_places p on p.week_id = w.id
     join users u on u.id = p.user_id and not u.banned
     order by w.ended_at desc, p.place, u.display_name`
  );
  const weeks = [];
  const byId = new Map();
  for (const r of rows) {
    let w = byId.get(r.id);
    if (!w) {
      w = { id: r.id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at), places: [] };
      byId.set(r.id, w);
      weeks.push(w);
    }
    w.places.push({
      place: r.place, userId: r.user_id, name: r.display_name, login: r.login,
      avatar: r.avatar_url, points: r.points, hits: r.hits, isHouse: r.is_house,
    });
  }
  return weeks.slice(0, 100);
}

app.get('/api/hall', wrap(async (req, res) => {
  if (!(await getFlag('hall_visible'))) return res.json({ visible: false, weeks: [] });
  res.json({ visible: true, weeks: await fetchHall() });
}));

app.get('/api/admin/hall', requireAdmin, wrap(async (req, res) => {
  res.json({ visible: await getFlag('hall_visible'), weeks: await fetchHall() });
}));

/* ---------- Prêmios únicos ---------- */
const PRIZE_SQL = `
  select p.id, p.name, p.emoji, p.image_url, p.description, p.points, p.open, p.holder_id, p.won_at,
         u.display_name as holder_name, u.login as holder_login, u.avatar_url as holder_avatar,
         coalesce(u.banned, false) as holder_banned,
         (select count(*) from prize_removed r where r.prize_id = p.id)::int as removed_count
  from prizes p left join users u on u.id = p.holder_id
  order by p.points, p.created_at`;

// Situação do prêmio: com dono, disponível (o primeiro a chegar leva) ou sem dono (removido)
const prizeStatus = (r) => (r.holder_id ? 'held' : r.open ? 'open' : 'vacant');

function parsePrizeInput(body) {
  const name = String(body?.name ?? '').trim();
  if (name.length < 2 || name.length > 40) return { error: 'O nome precisa ter de 2 a 40 caracteres.' };
  const points = Number(body?.points);
  if (!Number.isInteger(points) || points < 1 || points > 1000000) {
    return { error: 'Os pontos precisam ser um número inteiro maior que 0.' };
  }
  let emoji = String(body?.emoji ?? '').trim();
  if (emoji.length > 8) return { error: 'Emoji inválido.' };
  if (!emoji) emoji = '🏅';
  const imageUrl = String(body?.imageUrl ?? '').trim();
  if (imageUrl && (!imageUrl.startsWith('https://') || imageUrl.length > 500)) {
    return { error: 'A imagem precisa ser um link https:// válido.' };
  }
  const description = String(body?.description ?? '').trim();
  if (description.length > 300) return { error: 'A descrição pode ter até 300 caracteres.' };
  return { name, points, emoji, imageUrl: imageUrl || null, description };
}

// Vitrine pública. Dono banido aparece como "sem dono" (o banido some de tudo).
app.get('/api/prizes', wrap(async (req, res) => {
  const { rows } = await q(PRIZE_SQL);
  res.json({
    prizes: rows.map((r) => {
      const hidden = r.holder_id && r.holder_banned;
      return {
        id: r.id, name: r.name, emoji: r.emoji, imageUrl: r.image_url, description: r.description, points: r.points,
        status: hidden ? 'vacant' : prizeStatus(r),
        holder: r.holder_id && !hidden
          ? { userId: r.holder_id, name: r.holder_name, avatar: r.holder_avatar, wonAt: iso(r.won_at) }
          : null,
      };
    }),
  });
}));

app.get('/api/admin/prizes', requireAdmin, wrap(async (req, res) => {
  const { rows } = await q(PRIZE_SQL);
  res.json({
    notifyPrize: await getFlag('notify_prize'),
    pushEnabled: PUSH_ENABLED,
    prizes: rows.map((r) => ({
      id: r.id, name: r.name, emoji: r.emoji, imageUrl: r.image_url, description: r.description, points: r.points,
      status: prizeStatus(r), removedCount: r.removed_count,
      holder: r.holder_id
        ? { userId: r.holder_id, name: r.holder_name, login: r.holder_login, banned: r.holder_banned, wonAt: iso(r.won_at) }
        : null,
    })),
  });
}));

app.post('/api/admin/prizes', requirePerm('prizes'), wrap(async (req, res) => {
  const input = parsePrizeInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const id = uid();
  await q('insert into prizes (id, name, emoji, image_url, description, points) values ($1, $2, $3, $4, $5, $6)',
    [id, input.name, input.emoji, input.imageUrl, input.description, input.points]);
  await computeStandings().catch(() => {}); // se alguém já passou dessa pontuação, o prêmio já vai pro primeiro que chegou
  res.status(201).json({ id });
}));

app.put('/api/admin/prizes/:id', requirePerm('prizes'), wrap(async (req, res) => {
  const input = parsePrizeInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const r = await q('update prizes set name = $2, emoji = $3, image_url = $4, description = $6, points = $5 where id = $1',
    [req.params.id, input.name, input.emoji, input.imageUrl, input.points, input.description]);
  if (!r.rowCount) return res.status(404).json({ error: 'Prêmio não encontrado.' });
  await computeStandings().catch(() => {});
  res.json({ ok: true });
}));

app.delete('/api/admin/prizes/:id', requirePerm('prizes'), wrap(async (req, res) => {
  const r = await q('delete from prizes where id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Prêmio não encontrado.' });
  res.json({ ok: true });
}));

// Tira o prêmio de quem tem: fica sem dono, e a pessoa não o ganha de volta
app.post('/api/admin/prizes/:id/remove', requirePerm('prizes'), wrap(async (req, res) => {
  const done = await tx(async (c) => {
    const { rows } = await c.query('select holder_id from prizes where id = $1 for update', [req.params.id]);
    if (!rows[0]) return 'missing';
    if (!rows[0].holder_id) return 'nobody';
    await c.query('insert into prize_removed (prize_id, user_id) values ($1, $2) on conflict do nothing', [req.params.id, rows[0].holder_id]);
    await c.query('update prizes set holder_id = null, won_at = null, open = false where id = $1', [req.params.id]);
    return 'ok';
  });
  if (done === 'missing') return res.status(404).json({ error: 'Prêmio não encontrado.' });
  if (done === 'nobody') return res.status(400).json({ error: 'Este prêmio não tem dono.' });
  res.json({ ok: true });
}));

// Libera de novo: o primeiro que já tiver (ou vier a ter) a pontuação leva, menos quem perdeu
app.post('/api/admin/prizes/:id/release', requirePerm('prizes'), wrap(async (req, res) => {
  const cur = await q('select holder_id from prizes where id = $1', [req.params.id]);
  if (!cur.rowCount) return res.status(404).json({ error: 'Prêmio não encontrado.' });
  if (cur.rows[0].holder_id) return res.status(400).json({ error: 'Este prêmio já tem dono. Remova antes de liberar.' });
  await q('update prizes set open = true where id = $1', [req.params.id]);
  await computeStandings().catch(() => {}); // já entrega se alguém tiver a pontuação
  const after = await q(
    'select p.holder_id, u.display_name from prizes p left join users u on u.id = p.holder_id where p.id = $1', [req.params.id]);
  res.json({ ok: true, holder: after.rows[0].holder_id ? after.rows[0].display_name : null });
}));

/* ---------- Usuários: pontos manuais e banimento ---------- */
app.get('/api/admin/users', requireAdmin, wrap(async (req, res) => {
  const [{ rows }, st, wk] = await Promise.all([
    q('select id, display_name, login, avatar_url, banned, created_at from users where not is_house and not is_test order by lower(display_name)'),
    computeStandings(),
    computeWeeklyStandings(),
  ]);
  const gen = new Map(st.ranking.map((s) => [s.userId, s]));
  const week = new Map(wk.ranking.map((s) => [s.userId, s]));
  res.json({
    users: rows.map((u) => ({
      id: u.id, name: u.display_name, login: u.login, avatar: u.avatar_url, banned: u.banned,
      // banido não entra no ranking, então não tem pontos calculados
      points: gen.has(u.id) ? gen.get(u.id).points : null,
      weeklyPoints: week.has(u.id) ? week.get(u.id).points : null,
      adjust: gen.has(u.id) ? gen.get(u.id).adjust : 0,
      prizes: gen.has(u.id) ? gen.get(u.id).prizes.length : 0,
    })),
  });
}));

/* ---------- Bot da Twitch ----------
   Escreve no chat da Twitch pela API (Send Chat Message), com a conta do bot autorizada por OAuth.
   Avisos: enquete criada, resultado da enquete e prêmio conquistado (marcando o ganhador). */
// O bot pode usar o app da Twitch (Client ID/Secret) de OUTRA conta, separado do app do login do site:
// BOT_TWITCH_CLIENT_ID / BOT_TWITCH_CLIENT_SECRET. Sem elas, usa as mesmas credenciais do login.
const BOT_OWN_APP = Boolean(process.env.BOT_TWITCH_CLIENT_ID && process.env.BOT_TWITCH_CLIENT_SECRET);
const BOT_CLIENT_ID = BOT_OWN_APP ? process.env.BOT_TWITCH_CLIENT_ID : TWITCH_CLIENT_ID;
const BOT_CLIENT_SECRET = BOT_OWN_APP ? process.env.BOT_TWITCH_CLIENT_SECRET : TWITCH_CLIENT_SECRET;
const BOT_SCOPES = 'user:write:chat user:bot';
const BOT_DEFAULTS = {
  created: '📊 Nova enquete no ar: {titulo} — vote em {link}',
  result: '✅ Resultado de "{titulo}": {resposta}. {acertos} de {total} acertaram ({ganho}).',
  prize: '🏆 Parabéns @{usuario}! Você conquistou o prêmio "{premio}"!',
};
const BOT_PLACEHOLDERS = {
  created: ['titulo', 'opcoes', 'tipo', 'pontos', 'fecha', 'link'],
  result: ['titulo', 'resposta', 'acertos', 'total', 'ganho', 'link'],
  prize: ['usuario', 'nome', 'premio', 'link'],
};
const BOT_KINDS = Object.keys(BOT_DEFAULTS);

const siteUrl = () => String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

async function getSetting(key, fallback = '') {
  const { rows } = await q('select value from settings where key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}
const setSetting = (key, value) => q(
  'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
  [key, String(value)]
);

async function botConfig() {
  const keys = ['bot_enabled', 'bot_channel', 'bot_channel_id', 'bot_last_error', 'bot_last_sent',
    ...BOT_KINDS.flatMap((k) => [`bot_on_${k}`, `bot_tpl_${k}`])];
  const { rows } = await q('select key, value from settings where key = any($1)', [keys]);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: v.bot_enabled === '1',
    channel: v.bot_channel || '',
    channelId: v.bot_channel_id || '',
    on: Object.fromEntries(BOT_KINDS.map((k) => [k, v[`bot_on_${k}`] !== '0'])),
    tpl: Object.fromEntries(BOT_KINDS.map((k) => [k, v[`bot_tpl_${k}`] || BOT_DEFAULTS[k]])),
    lastError: v.bot_last_error || '',
    lastSent: v.bot_last_sent || '',
  };
}

/* A conta do bot tem que ser separada: não pode ser a dona do canal onde ele escreve nem uma conta que entra no
   site como participante (senão apareceria no ranking). Devolve 'canal', 'login' ou null. */
async function botConflict(botUserId, channelId) {
  if (channelId && String(botUserId) === String(channelId)) return 'canal';
  const u = await q('select 1 from users where twitch_id = $1 and not is_house and not is_test', [String(botUserId)]);
  return u.rowCount ? 'login' : null;
}

const botAuth = async () => {
  const a = (await q('select * from bot_auth where id = 1')).rows[0] || null;
  // Conta autorizada por outro app (credenciais trocadas depois): não vale, é preciso conectar de novo
  return a && a.client_id && a.client_id !== BOT_CLIENT_ID ? null : a;
};

// Renova o acesso do bot quando está perto de vencer (uma renovação por vez)
let botRefreshing = null;
async function botAccessToken(force = false) {
  const a = await botAuth();
  if (!a) return null;
  if (!force && new Date(a.expires_at).getTime() - Date.now() > 60 * 1000) return a;
  if (!botRefreshing) {
    botRefreshing = (async () => {
      const r = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: BOT_CLIENT_ID, client_secret: BOT_CLIENT_SECRET,
          grant_type: 'refresh_token', refresh_token: a.refresh_token,
        }),
      });
      if (!r.ok) throw new Error('A Twitch recusou renovar o acesso do bot. Conecte a conta do bot de novo.');
      const j = await r.json();
      const fresh = {
        ...a, access_token: j.access_token, refresh_token: j.refresh_token || a.refresh_token,
        expires_at: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000),
      };
      await q('update bot_auth set access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now() where id = 1',
        [fresh.access_token, fresh.refresh_token, fresh.expires_at]);
      return fresh;
    })().finally(() => { botRefreshing = null; });
  }
  return botRefreshing;
}

async function helixSend(text) {
  const cfg = await botConfig();
  let a = await botAccessToken();
  if (!a) throw new Error('A conta do bot não está conectada.');
  if (!cfg.channelId) throw new Error('Nenhum canal configurado para o bot.');
  const post = (token) => fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': BOT_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ broadcaster_id: cfg.channelId, sender_id: a.bot_user_id, message: text }),
  });
  let res = await post(a.access_token);
  if (res.status === 401) { a = await botAccessToken(true); res = await post(a.access_token); }
  if (!res.ok) throw new Error(`A Twitch respondeu ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = ((await res.json()).data || [])[0];
  if (d && d.is_sent === false) throw new Error(`A Twitch barrou a mensagem (${(d.drop_reason && (d.drop_reason.message || d.drop_reason.code)) || 'sem motivo'}).`);
}

// Fila: uma mensagem por vez com intervalo, para não estourar o limite do chat nem fazer spam
const botQueue = [];
let botBusy = false;
function botEnqueue(text) {
  if (botQueue.length >= 30) botQueue.shift();
  botQueue.push(text);
  botPump();
}
async function botPump() {
  if (botBusy) return;
  botBusy = true;
  try {
    while (botQueue.length) {
      const text = botQueue.shift();
      try {
        await helixSend(text);
        await setSetting('bot_last_error', '');
        await setSetting('bot_last_sent', new Date().toISOString());
      } catch (e) {
        console.error('[bot]', e.message);
        await setSetting('bot_last_error', `${new Date().toISOString()} ${e.message}`.slice(0, 300)).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    botBusy = false;
  }
}

function botFill(template, vars) {
  let text = template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]).replace(/[\r\n]+/g, ' ').trim() : m));
  text = text.replace(/\s+/g, ' ').trim();
  if (/^[/.\\]/.test(text)) text = `› ${text}`; // nada que comece como comando do chat
  return text.length > 480 ? `${text.slice(0, 479)}…` : text;
}

async function botNotify(kind, vars) {
  const cfg = await botConfig();
  if (!cfg.enabled || !cfg.on[kind] || !cfg.channelId || !(await botAuth())) return;
  botEnqueue(botFill(cfg.tpl[kind], vars));
}

async function botPollResult(pollId, link) {
  const cfg = await botConfig();
  if (!cfg.enabled || !cfg.on.result) return;
  const { rows: pr } = await q('select title, points, correct_option_id, odds, pool_odds, option_points, sum_points, max_win from polls where id = $1', [pollId]);
  const p = pr[0];
  if (!p || !p.correct_option_id) return;
  const opt = (await q('select label, is_house, points from poll_options where id = $1', [p.correct_option_id])).rows[0];
  if (!opt) return;
  const c = (await q(
    `select (count(*) filter (where not u.is_house))::int as total,
            (count(*) filter (where not u.is_house and v.option_id = $2))::int as won,
            (count(*) filter (where v.option_id = $2))::int as won_all
     from votes v join users u on u.id = v.user_id where v.poll_id = $1`,
    [pollId, p.correct_option_id]
  )).rows[0];
  const money = (n) => `+${n} ${n === 1 ? 'pt' : 'pts'}`;
  let ganho;
  if (opt.is_house) ganho = 'a casa levou os pontos';
  else if (p.odds) ganho = c.won ? `odd ${(c.total / c.won).toFixed(2).replace('.', ',')}x` : 'sem ganhadores';
  else if (p.option_points) ganho = money(p.sum_points ? p.points + (opt.points ?? 0) : (opt.points ?? p.points));
  else if (p.pool_odds) {
    let share = Math.floor(p.points / Math.max(1, c.won_all));
    if (p.max_win) share = Math.min(share, p.max_win);
    ganho = `${money(share)} cada`;
  } else ganho = money(p.points);
  await botNotify('result', {
    titulo: p.title, resposta: opt.is_house ? 'ninguém acertou' : opt.label,
    acertos: opt.is_house ? 0 : c.won, total: c.total, ganho, link,
  });
}

app.get('/api/admin/bot', requireAdmin, wrap(async (req, res) => {
  const [cfg, auth] = await Promise.all([botConfig(), botAuth()]);
  res.json({
    twitchConfigured: Boolean(BOT_CLIENT_ID && BOT_CLIENT_SECRET),
    ownApp: BOT_OWN_APP,
    connected: Boolean(auth), botLogin: auth ? auth.bot_login : null,
    enabled: cfg.enabled, channel: cfg.channel, on: cfg.on, tpl: cfg.tpl,
    defaults: BOT_DEFAULTS, placeholders: BOT_PLACEHOLDERS,
    conflict: auth ? await botConflict(auth.bot_user_id, cfg.channelId) : null,
    connectResult: await getSetting('bot_connect_result'),
    lastError: cfg.lastError, lastSent: cfg.lastSent,
    redirectUri: `${baseUrl(req)}/auth/twitch-bot/callback`,
  });
}));

app.post('/api/admin/bot/config', requirePerm('bot'), wrap(async (req, res) => {
  const b = req.body || {};
  const channel = String(b.channel ?? '').trim().replace(/^#/, '').toLowerCase();
  if (channel && !/^[a-z0-9_]{3,25}$/.test(channel)) return res.status(400).json({ error: 'Canal inválido: use o login da Twitch (letras, números e _).' });
  const tpl = {};
  for (const k of BOT_KINDS) {
    const t = String(b.tpl?.[k] ?? '').trim();
    if (t.length > 300) return res.status(400).json({ error: 'Cada mensagem pode ter no máximo 300 caracteres.' });
    tpl[k] = t || BOT_DEFAULTS[k];
  }
  const auth = await botAuth();
  let channelId = await getSetting('bot_channel_id');
  if (channel && (channel !== (await getSetting('bot_channel')) || !channelId)) {
    if (!auth) return res.status(409).json({ error: 'Conecte a conta do bot antes de definir o canal.' });
    try {
      const a = await botAccessToken();
      const r = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`, {
        headers: { Authorization: `Bearer ${a.access_token}`, 'Client-Id': BOT_CLIENT_ID },
      });
      if (!r.ok) throw new Error(`A Twitch respondeu ${r.status} ao procurar o canal.`);
      const found = ((await r.json()).data || [])[0];
      if (!found) return res.status(400).json({ error: 'Canal não encontrado na Twitch.' });
      channelId = found.id;
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }
  if (!channel) channelId = '';
  if (auth && channelId && String(auth.bot_user_id) === String(channelId)) {
    return res.status(400).json({ error: 'A conta do bot não pode ser a dona do canal. Conecte uma conta separada, só para o bot.' });
  }
  const enabled = b.enabled === true;
  if (enabled && (!auth || !channel)) return res.status(400).json({ error: 'Para ligar o bot, conecte a conta dele e informe o canal.' });
  await setSetting('bot_enabled', enabled ? '1' : '0');
  await setSetting('bot_channel', channel);
  await setSetting('bot_channel_id', channelId);
  for (const k of BOT_KINDS) {
    await setSetting(`bot_on_${k}`, b.on?.[k] === false ? '0' : '1');
    await setSetting(`bot_tpl_${k}`, tpl[k]);
  }
  res.json({ ok: true });
}));

app.post('/api/admin/bot/test', requirePerm('bot'), limit('bot-test', 6, 60 * 1000), wrap(async (req, res) => {
  try {
    await helixSend('🤖 Teste do bot do Bolão: está funcionando!');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

app.post('/api/admin/bot/disconnect', requirePerm('bot'), wrap(async (req, res) => {
  const a = await botAuth();
  if (a) {
    fetch('https://id.twitch.tv/oauth2/revoke', { // avisa a Twitch (se falhar, tudo bem)
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: BOT_CLIENT_ID, token: a.access_token }),
    }).catch(() => {});
  }
  await q('delete from bot_auth where id = 1');
  await setSetting('bot_enabled', '0');
  res.json({ ok: true });
}));

// Conectar a conta do bot: o admin é levado à Twitch para autorizar (com a conta do bot) e volta no callback
app.get('/api/admin/bot/connect', requirePerm('bot'), wrap(async (req, res) => {
  if (!BOT_CLIENT_ID || !BOT_CLIENT_SECRET) return res.status(503).type('text').send('Credenciais do bot não configuradas (BOT_TWITCH_CLIENT_ID e BOT_TWITCH_CLIENT_SECRET).');
  await setSetting('bot_connect_result', '');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'bot_state', state, 600);
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${new URLSearchParams({
    client_id: BOT_CLIENT_ID,
    redirect_uri: `${baseUrl(req)}/auth/twitch-bot/callback`,
    response_type: 'code',
    scope: BOT_SCOPES,
    state,
    force_verify: 'true', // sempre pergunta qual conta, para dar para escolher a do bot
  })}`);
}));

app.get('/auth/twitch-bot/callback', limit('oauth', 60, 15 * 60 * 1000), wrap(async (req, res) => {
  req.admin = await getAdmin(req);
  if (!req.admin || !can(req, 'bot')) return res.status(401).type('text').send('Entre no painel admin (com permissão do bot) e tente conectar de novo.');
  const back = (r) => res.redirect(`/${ADMIN_PATH}?bot=${r}`);
  // Guarda o resultado (e o motivo) para a aba Bot mostrar de forma fixa, sem depender do aviso rápido na tela
  const done = async (code, detail = '') => {
    await setSetting('bot_connect_result', `${code}|${String(detail).replace(/\s+/g, ' ').slice(0, 160)}`).catch(() => {});
    return back(code);
  };
  const saved = parseCookies(req).bot_state;
  setCookie(res, 'bot_state', '', 0);
  const { code, state, error } = req.query;
  if (error) return done('cancelado');
  if (typeof code !== 'string' || typeof state !== 'string' || !saved || state !== saved) return done('erro', 'sessão de conexão expirada ou inválida; tente de novo');
  try {
    const tr = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: BOT_CLIENT_ID, client_secret: BOT_CLIENT_SECRET, code,
        grant_type: 'authorization_code', redirect_uri: `${baseUrl(req)}/auth/twitch-bot/callback`,
      }),
    });
    if (!tr.ok) {
      const txt = await tr.text();
      console.error('[bot] token respondeu', tr.status, txt);
      return done('erro', `a Twitch recusou o código (${tr.status}): ${txt}`);
    }
    const tok = await tr.json();
    const ur = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${tok.access_token}`, 'Client-Id': BOT_CLIENT_ID },
    });
    const tw = ur.ok ? ((await ur.json()).data || [])[0] : null;
    if (!tw || !tok.refresh_token) return done('erro', `não foi possível ler a conta (users ${ur.status}) ou faltou o token de renovação`);
    // Conta separada: recusa a conta do próprio canal e contas que já entram no site como participantes
    const conflict = await botConflict(tw.id, await getSetting('bot_channel_id'));
    if (conflict) {
      fetch('https://id.twitch.tv/oauth2/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: BOT_CLIENT_ID, token: tok.access_token }),
      }).catch(() => {});
      return done(conflict === 'canal' ? 'conta-canal' : 'conta-login', tw.login);
    }
    await q(
      `insert into bot_auth (id, bot_user_id, bot_login, access_token, refresh_token, expires_at, client_id)
       values (1, $1, $2, $3, $4, $5, $6)
       on conflict (id) do update set bot_user_id = excluded.bot_user_id, bot_login = excluded.bot_login,
         access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, client_id = excluded.client_id, updated_at = now()`,
      [String(tw.id), String(tw.login), tok.access_token, tok.refresh_token, new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000), BOT_CLIENT_ID]
    );
    await q('insert into admin_log (admin_id, admin_name, action, detail) values ($1, $2, $3, $4)', [
      req.admin.id, req.admin.owner ? 'Dono' : req.admin.name, 'Conectou a conta do bot da Twitch', String(tw.login),
    ]);
    await done('ok', tw.login);
  } catch (e) {
    console.error('[bot] conexão falhou:', e.message);
    await done('erro', e.message);
  }
}));

/* ---------- Painel de testes: contas fictícias de teste ----------
   Contas "is_test" entram no ranking como participantes comuns (com 🧪 no nome), podem
   votar/apostar pelo painel e são apagadas de uma vez com seus votos, pontos e emblemas. */
const requireTests = wrap(async (req, res, next) => {
  req.admin = await getAdmin(req);
  if (!req.admin) return res.status(401).json({ error: 'Acesso restrito ao admin.' });
  if (!can(req, 'tests')) return res.status(403).json({ error: 'Seu nível de admin não permite esta ação.' });
  // 423 = aba trancada (falta a senha dela); 403 fica só para falta de permissão
  if (!(await hasSession(req, 'tsid', 'tests'))) return res.status(423).json({ error: 'Digite a senha da aba Testes.', locked: true });
  next();
});

app.get('/api/admin/tests/status', requirePerm('tests'), wrap(async (req, res) => {
  res.json({ configured: Boolean(TESTS_PASSWORD), unlocked: await hasSession(req, 'tsid', 'tests') });
}));

app.post('/api/admin/tests/unlock', requirePerm('tests'), limit('tests', 8, 15 * 60 * 1000), wrap(async (req, res) => {
  if (!TESTS_PASSWORD) return res.status(503).json({ error: 'TESTS_PASSWORD não está configurada no servidor.' });
  const given = sha(String(req.body?.password ?? ''));
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(sha(TESTS_PASSWORD)))) {
    return res.status(401).json({ error: 'Senha da aba Testes incorreta.' });
  }
  setCookie(res, 'tsid', await createSession('tests', null, TESTS_SESSION_MS), TESTS_SESSION_MS / 1000);
  res.json({ ok: true });
}));

app.post('/api/admin/tests/lock', requirePerm('tests'), wrap(async (req, res) => {
  await destroySession(req, res, 'tsid');
  res.json({ ok: true });
}));

app.post('/api/admin/test-users/:id/points', requireTests, wrap(async (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return res.status(400).json({ error: 'Valor inválido.' });
  const u = (await q('select id from users where id = $1 and is_test', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Conta de teste não encontrada.' });
  await q('insert into point_adjustments (user_id, delta, note) values ($1, $2, $3)', [u.id, delta, 'Teste']);
  await computeStandings().catch(() => {});
  res.json({ ok: true });
}));

const testUsers = () => q('select id, display_name from users where is_test order by created_at, display_name');

app.get('/api/admin/test-users', requireTests, wrap(async (req, res) => {
  const [{ rows }, st] = await Promise.all([testUsers(), computeStandings()]);
  const pts = new Map(st.ranking.map((r) => [r.userId, r.points]));
  const out = [];
  for (const u of rows) {
    const locked = await lockedStakes(pool, u.id);
    out.push({ id: u.id, name: u.display_name, points: pts.get(u.id) || 0, locked });
  }
  res.json({ users: out });
}));

app.post('/api/admin/test-users', requireTests, wrap(async (req, res) => {
  const count = Number(req.body?.count);
  const start = Number(req.body?.startPoints) || 0;
  if (!Number.isInteger(count) || count < 1 || count > 20) return res.status(400).json({ error: 'Crie de 1 a 20 contas por vez.' });
  if (!Number.isInteger(start) || start < 0 || start > 100000) return res.status(400).json({ error: 'Pontos iniciais inválidos (0 a 100000).' });
  const have = (await q('select count(*)::int as n from users where is_test')).rows[0].n;
  if (have + count > 50) return res.status(400).json({ error: 'No máximo 50 contas de teste.' });
  for (let i = 1; i <= count; i++) {
    const id = uid();
    const name = `🧪 Teste ${have + i}`;
    await q('insert into users (id, twitch_id, login, display_name, is_test) values ($1, $2, $3, $4, true)', [id, `test-${id}`, `teste${have + i}`, name]);
    if (start > 0) await q('insert into point_adjustments (user_id, delta, note) values ($1, $2, $3)', [id, start, 'Pontos iniciais (teste)']);
  }
  await computeStandings().catch(() => {});
  broadcast();
  res.status(201).json({ ok: true });
}));

app.post('/api/admin/test-users/:id/vote', requireTests, wrap(async (req, res) => {
  const u = (await q('select id from users where id = $1 and is_test', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Conta de teste não encontrada.' });
  const r = await castVote(String(req.body?.pollId ?? ''), u.id, req.body);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
}));

// Todas as contas de teste votam sozinhas numa enquete aberta (opção e aposta aleatórias)
app.post('/api/admin/test-users/random-votes', requireTests, wrap(async (req, res) => {
  const [poll] = await fetchPolls('where id = $1', [String(req.body?.pollId ?? '')]);
  if (!poll) return res.status(404).json({ error: 'Enquete não encontrada.' });
  const opts = visibleOptions(poll);
  const { rows } = await testUsers();
  const st = poll.odds ? await computeStandings() : null;
  const pts = new Map((st ? st.ranking : []).map((r) => [r.userId, r.points]));
  let done = 0;
  const skipped = [];
  for (const u of rows) {
    const body = { optionId: opts[Math.floor(Math.random() * opts.length)].id };
    if (poll.odds) {
      const free = (pts.get(u.id) || 0) - (await lockedStakes(pool, u.id, poll.id));
      if (free < 1) { skipped.push(u.display_name); continue; }
      body.stake = 1 + Math.floor(Math.random() * Math.min(free, 100, poll.maxStake || 100));
    }
    const r = await castVote(poll.id, u.id, body);
    if (r.error) { if (r.status === 409 && !r.locked) return res.status(409).json({ error: r.error }); skipped.push(u.display_name); } else done += 1;
  }
  res.json({ ok: true, done, skipped: skipped.length });
}));

app.delete('/api/admin/test-users', requireTests, wrap(async (req, res) => {
  const r = await q('delete from users where is_test'); // votos, pontos, emblemas e prêmios saem junto (cascade)
  await computeStandings().catch(() => {});
  broadcast();
  res.json({ ok: true, removed: r.rowCount });
}));

const realUser = async (id) => (await q('select id, banned from users where id = $1 and not is_house', [id])).rows[0];

app.post('/api/admin/users/:id/ban', requirePerm('users'), wrap(async (req, res) => {
  if (typeof req.body?.banned !== 'boolean') return res.status(400).json({ error: 'Informe banned como true ou false.' });
  const u = await realUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Participante não encontrado.' });
  await q('update users set banned = $2 where id = $1', [u.id, req.body.banned]);
  if (req.body.banned) await q('delete from sessions where user_id = $1', [u.id]); // derruba o login na hora
  await computeStandings().catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/points', requirePerm('users'), wrap(async (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
    return res.status(400).json({ error: 'Informe um valor inteiro diferente de zero (até 100000).' });
  }
  const note = String(req.body?.note ?? '').trim().slice(0, 120);
  // Vale para participantes e também para contas da casa
  const u = (await q('select id from users where id = $1', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Participante não encontrado.' });
  await q('insert into point_adjustments (user_id, delta, note) values ($1, $2, $3)', [u.id, delta, note]);
  await computeStandings().catch(() => {}); // conquistas e prêmio único reagem na hora
  res.json({ ok: true });
}));

app.get('/api/admin/users/:id/adjustments', requireAdmin, wrap(async (req, res) => {
  const { rows } = await q(
    'select id, delta, note, created_at from point_adjustments where user_id = $1 order by created_at desc, id desc limit 15',
    [req.params.id]
  );
  res.json({ adjustments: rows.map((r) => ({ id: String(r.id), delta: r.delta, note: r.note, createdAt: iso(r.created_at) })) });
}));

app.delete('/api/admin/adjustments/:id', requirePerm('users'), wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Ajuste não encontrado.' });
  const r = await q('delete from point_adjustments where id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Ajuste não encontrado.' });
  await computeStandings().catch(() => {});
  res.json({ ok: true });
}));

app.delete('/api/admin/hall/:id', requirePerm('ranking'), wrap(async (req, res) => {
  const r = await q('delete from hall_weeks where id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Semana não encontrada.' });
  broadcast();
  res.json({ ok: true });
}));

app.post('/api/admin/settings', requirePerm('settings'), wrap(async (req, res) => {
  const { mode, streakEvery, streakBonus } = req.body || {};
  const entries = [];
  let rankingChanged = false;

  // Chaves liga/desliga (campo da API -> chave em settings)
  const flagFields = {
    notify: 'notify_enabled',
    notifyResult: 'notify_result',
    notifyClosing: 'notify_closing',
    hallVisible: 'hall_visible',
    notifyPrize: 'notify_prize',
    lockVotes: 'lock_votes',
    showPollCreated: 'show_poll_created',
    chatEnabled: 'chat_enabled',
    chatImages: 'chat_images',
    chatVideos: 'chat_videos',
    chatEmbedLinks: 'chat_embed_links',
  };
  for (const [field, key] of Object.entries(flagFields)) {
    const v = req.body?.[field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return res.status(400).json({ error: 'Valor inválido.' });
    entries.push([key, v ? '1' : '0']);
    // hall/trava/chat: avisa as páginas abertas para esconder botão, trava, etc.
    if (field === 'hallVisible' || field === 'lockVotes' || field === 'showPollCreated' || field === 'chatEnabled'
      || field === 'chatImages' || field === 'chatVideos' || field === 'chatEmbedLinks') rankingChanged = true;
  }

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

/* ---------- Níveis de conquista (configuráveis pelo admin) ---------- */
app.get('/api/admin/achievements', requireAdmin, wrap(async (req, res) => {
  res.json({ achievements: await fetchAchievementDefs() });
}));

function parseAchievementInput(body) {
  const type = body?.type;
  if (!['points', 'streak', 'titles', 'misses', 'missstreak'].includes(type)) return { error: 'Tipo de conquista inválido.' };
  const threshold = Number(body?.threshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100000) {
    return { error: 'A meta precisa ser um número inteiro maior que 0.' };
  }
  const label = String(body?.label ?? '').trim();
  if (label.length < 2 || label.length > 40) return { error: 'O nome precisa ter de 2 a 40 caracteres.' };
  let emoji = String(body?.emoji ?? '').trim();
  if (emoji.length > 8) return { error: 'Emoji inválido.' };
  if (!emoji) emoji = '🏆';
  let imageUrl = String(body?.imageUrl ?? '').trim();
  if (imageUrl && (!imageUrl.startsWith('https://') || imageUrl.length > 500)) {
    return { error: 'A imagem precisa ser um link https:// válido.' };
  }
  return { type, threshold, label, emoji, imageUrl: imageUrl || null };
}

app.post('/api/admin/achievements', requirePerm('achievements'), wrap(async (req, res) => {
  const input = parseAchievementInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const id = uid();
  await q(
    'insert into achievement_defs (id, type, threshold, label, emoji, image_url, active) values ($1, $2, $3, $4, $5, $6, $7)',
    [id, input.type, input.threshold, input.label, input.emoji, input.imageUrl, !['misses', 'missstreak'].includes(input.type)]
  );
  broadcast();
  res.status(201).json({ id });
}));

app.put('/api/admin/achievements/:id', requirePerm('achievements'), wrap(async (req, res) => {
  const input = parseAchievementInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const r = await q(
    'update achievement_defs set type = $2, threshold = $3, label = $4, emoji = $5, image_url = $6 where id = $1',
    [req.params.id, input.type, input.threshold, input.label, input.emoji, input.imageUrl]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Nível não encontrado.' });
  broadcast();
  res.json({ ok: true });
}));

app.post('/api/admin/achievements/:id/active', requirePerm('achievements'), wrap(async (req, res) => {
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'Informe active como true ou false.' });
  const r = await q('update achievement_defs set active = $2 where id = $1', [req.params.id, req.body.active]);
  if (!r.rowCount) return res.status(404).json({ error: 'Nível não encontrado.' });
  broadcast();
  res.json({ ok: true });
}));

app.delete('/api/admin/achievements/:id', requirePerm('achievements'), wrap(async (req, res) => {
  const r = await q('delete from achievement_defs where id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Nível não encontrado.' });
  await q('delete from achievements where code = $1', [req.params.id]); // some com quem já tinha esse emblema
  broadcast();
  res.json({ ok: true });
}));

/* Cópia dos dados em JSON (os dados já ficam no Supabase; isto é uma segurança extra) */
app.get('/api/admin/backup', requirePerm('backup'), wrap(async (req, res) => {
  const [users, polls, options, votes, awards, settings, challengeRows] = await Promise.all([
    q('select * from users order by created_at'),
    q('select * from polls order by created_at'),
    q('select * from poll_options order by poll_id, position'),
    q('select * from votes'),
    q('select * from awards order by id'),
    q('select * from settings'),
    q('select * from challenges order by created_at'),
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
    challenges: challengeRows.rows,
  });
}));


/* ---------- Chat global ---------- */
const CHAT_MAX_BODY = 500;
const CHAT_HISTORY = 100;

function chatMessageView(row, canModerate) {
  const deleted = Boolean(row.deleted_at);
  const mediaUrl = row.media_url || null;
  const mediaType = row.media_type || null;
  return {
    id: Number(row.id),
    body: deleted && !canModerate ? null : row.body,
    deleted,
    createdAt: iso(row.created_at),
    media: (!deleted || canModerate) && mediaUrl && mediaType
      ? { url: mediaUrl, type: mediaType }
      : null,
    user: {
      id: row.user_id,
      name: row.display_name,
      login: row.login,
      avatar: row.avatar_url,
      nameColor: normalizeNameColor(row.name_color),
    },
  };
}

async function getActiveMute(userId) {
  const { rows } = await q(
    `select user_id, reason, until, created_at
     from chat_mutes
     where user_id = $1 and (until is null or until > now())`,
    [userId]
  );
  return rows[0] || null;
}

async function canModerateChat(req) {
  const admin = await getAdmin(req);
  return Boolean(admin && (admin.owner || admin.perms.has('chat')));
}

app.get('/api/chat', requireUser, wrap(async (req, res) => {
  if (!(await getChatEnabled())) {
    return res.status(503).json({ error: 'O chat está desativado no momento.', chatEnabled: false });
  }
  const canMod = await canModerateChat(req);
  const mute = await getActiveMute(req.user.id);
  const mediaFlags = await getChatMediaFlags();
  const { rows } = await q(
    `select m.id, m.user_id, m.body, m.created_at, m.deleted_at, m.media_url, m.media_type,
            u.display_name, u.login, u.avatar_url, u.name_color
     from (
       select id from chat_messages
       order by id desc
       limit $1
     ) last
     join chat_messages m on m.id = last.id
     join users u on u.id = m.user_id
     order by m.id asc`,
    [CHAT_HISTORY]
  );
  const visible = canMod ? rows : rows.filter((r) => !r.deleted_at);
  res.json({
    messages: visible.map((r) => chatMessageView(r, canMod)),
    canModerate: canMod,
    media: mediaFlags,
    muted: mute
      ? {
          reason: mute.reason || null,
          until: mute.until ? iso(mute.until) : null,
          permanent: !mute.until,
        }
      : null,
  });
}));

app.post('/api/chat', requireUser, limit('chat', 30, 60 * 1000), wrap(async (req, res) => {
  if (!(await getChatEnabled())) {
    return res.status(503).json({ error: 'O chat está desativado no momento.', chatEnabled: false });
  }
  const mute = await getActiveMute(req.user.id);
  if (mute) {
    const when = mute.until
      ? `até ${new Date(mute.until).toLocaleString('pt-BR')}`
      : 'permanentemente';
    return res.status(403).json({
      error: `Você está silenciado no chat ${when}.${mute.reason ? ' Motivo: ' + mute.reason : ''}`,
    });
  }
  const body = String(req.body?.body || '').trim().replace(/\s+/g, ' ');
  if (body.length > CHAT_MAX_BODY) {
    return res.status(400).json({ error: `Mensagem muito longa (máx. ${CHAT_MAX_BODY} caracteres).` });
  }
  const mediaFlags = await getChatMediaFlags();
  let mediaUrl = null;
  let mediaType = null;
  const mediaRaw = req.body?.mediaUrl;
  const mediaTypeRaw = String(req.body?.mediaType || '').toLowerCase();
  if (mediaRaw) {
    const parsed = parseChatMediaUrl(mediaRaw);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    mediaType = mediaTypeRaw === 'image' || mediaTypeRaw === 'video'
      ? mediaTypeRaw
      : guessMediaType(parsed.url);
    if (mediaType !== 'image' && mediaType !== 'video') {
      return res.status(400).json({ error: 'Tipo de mídia inválido. Use image ou video.' });
    }
    if (mediaType === 'image' && !mediaFlags.images) {
      return res.status(403).json({ error: 'Anexos de imagem estão desativados.' });
    }
    if (mediaType === 'video' && !mediaFlags.videos) {
      return res.status(403).json({ error: 'Anexos de vídeo estão desativados.' });
    }
    mediaUrl = parsed.url;
  }
  if (!body && !mediaUrl) return res.status(400).json({ error: 'Mensagem vazia.' });
  const { rows } = await q(
    `insert into chat_messages (user_id, body, media_url, media_type)
     values ($1, $2, $3, $4)
     returning id, user_id, body, created_at, deleted_at, media_url, media_type`,
    [req.user.id, body || '', mediaUrl, mediaType]
  );
  const row = {
    ...rows[0],
    display_name: req.user.display_name,
    login: req.user.login,
    avatar_url: req.user.avatar_url,
    name_color: req.user.name_color,
  };
  const msg = chatMessageView(row, false);
  broadcastChat({ type: 'message', message: msg });
  res.status(201).json({ message: msg });
}));

app.delete('/api/admin/chat/:id', requirePerm('chat'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  const { rows } = await q(
    `update chat_messages
     set deleted_at = now(), deleted_by = $2
     where id = $1 and deleted_at is null
     returning id`,
    [id, req.admin.id || 'owner']
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mensagem não encontrada ou já apagada.' });
  broadcastChat({ type: 'delete', id });
  res.json({ ok: true });
}));

// Remove permanentemente do banco (uma mensagem)
app.delete('/api/admin/chat/:id/purge', requirePerm('chat'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  const { rowCount } = await q('delete from chat_messages where id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Mensagem não encontrada.' });
  broadcastChat({ type: 'purge', id });
  res.json({ ok: true });
}));

// Remove do banco todas as mensagens já marcadas como apagadas
app.post('/api/admin/chat/purge-deleted', requirePerm('chat'), wrap(async (req, res) => {
  const { rowCount } = await q('delete from chat_messages where deleted_at is not null');
  broadcastChat({ type: 'purge_deleted' });
  res.json({ ok: true, removed: rowCount });
}));

// Busca de usuários para menção (@login) no chat
app.get('/api/chat/users', requireUser, wrap(async (req, res) => {
  if (!(await getChatEnabled())) {
    return res.status(503).json({ error: 'O chat está desativado no momento.', chatEnabled: false });
  }
  const qtext = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  if (!qtext) return res.json({ users: [] });
  const { rows } = await q(
    `select id, display_name, login, avatar_url
     from users
     where not banned and not is_house and not coalesce(is_test, false)
       and (lower(login) like $1 or lower(display_name) like $1)
     order by
       case when lower(login) like $2 then 0 else 1 end,
       lower(display_name)
     limit 8`,
    [`%${qtext}%`, `${qtext}%`]
  );
  res.json({
    users: rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      login: r.login,
      avatar: r.avatar_url,
    })),
  });
}));

app.post('/api/admin/chat/mute', requirePerm('chat'), wrap(async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'Informe o usuário.' });
  const duration = String(req.body?.duration || 'permanent');
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  let until = null;
  if (duration === '1h') until = new Date(Date.now() + 60 * 60 * 1000);
  else if (duration === '24h') until = new Date(Date.now() + 24 * 60 * 60 * 1000);
  else if (duration !== 'permanent') {
    return res.status(400).json({ error: 'Duração inválida (use 1h, 24h ou permanent).' });
  }
  const u = await q('select id, display_name from users where id = $1', [userId]);
  if (!u.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });
  await q(
    `insert into chat_mutes (user_id, muted_by, reason, until)
     values ($1, $2, $3, $4)
     on conflict (user_id) do update set
       muted_by = excluded.muted_by,
       reason = excluded.reason,
       until = excluded.until,
       created_at = now()`,
    [userId, req.admin.id || 'owner', reason, until]
  );
  broadcastChat({ type: 'mute', userId });
  res.json({
    ok: true,
    user: u.rows[0].display_name,
    until: until ? iso(until) : null,
    permanent: !until,
  });
}));

app.delete('/api/admin/chat/mute/:userId', requirePerm('chat'), wrap(async (req, res) => {
  const { rowCount } = await q('delete from chat_mutes where user_id = $1', [req.params.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Este usuário não está silenciado.' });
  broadcastChat({ type: 'unmute', userId: req.params.userId });
  res.json({ ok: true });
}));

app.get('/api/admin/chat/mutes', requirePerm('chat'), wrap(async (req, res) => {
  const { rows } = await q(
    `select m.user_id, m.reason, m.until, m.created_at,
            u.display_name, u.login, u.avatar_url
     from chat_mutes m
     join users u on u.id = m.user_id
     where m.until is null or m.until > now()
     order by m.created_at desc`
  );
  res.json({
    mutes: rows.map((r) => ({
      userId: r.user_id,
      name: r.display_name,
      login: r.login,
      avatar: r.avatar_url,
      reason: r.reason,
      until: r.until ? iso(r.until) : null,
      permanent: !r.until,
      createdAt: iso(r.created_at),
    })),
  });
}));

// Últimas mensagens do chat (incluindo apagadas) para moderação no painel
app.get('/api/admin/chat/messages', requirePerm('chat'), wrap(async (req, res) => {
  const { rows } = await q(
    `select m.id, m.user_id, m.body, m.created_at, m.deleted_at, m.media_url, m.media_type,
            u.display_name, u.login, u.avatar_url
     from (
       select id from chat_messages order by id desc limit $1
     ) last
     join chat_messages m on m.id = last.id
     join users u on u.id = m.user_id
     order by m.id desc`,
    [CHAT_HISTORY]
  );
  res.json({
    messages: rows.map((r) => ({
      id: Number(r.id),
      body: r.body,
      deleted: Boolean(r.deleted_at),
      createdAt: iso(r.created_at),
      media: r.media_url && r.media_type ? { url: r.media_url, type: r.media_type } : null,
      user: {
        id: r.user_id,
        name: r.display_name,
        login: r.login,
        avatar: r.avatar_url,
      },
    })),
  });
}));

/* ---------- X1 Bolado (ver challenges.js) ---------- */
// `challenges` é usado pelas rotas de enquete acima só durante requisições, quando já está pronto.
challenges = require('./challenges')({
  app, q, tx, wrap, uid, limit, requireUser, requireAdmin, requirePerm, broadcast,
  fetchPolls, pollStatus, getFlag, getSetting, setSetting, iso, sendPush, pushEnabled: PUSH_ENABLED, short,
  computeStandings, lockedStakes, availableBalance,
});

/* ---------- Páginas e arquivos estáticos ---------- */
// A página e o script do admin ficam fora de /public: só existem sob o endereço secreto.
const ADMIN_HTML = fs
  .readFileSync(path.join(__dirname, 'admin', 'admin.html'), 'utf8')
  .replaceAll('%ADMIN_PATH%', `/${ADMIN_PATH}`);
app.get(`/${ADMIN_PATH}`, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(ADMIN_HTML);
});
app.get(`/${ADMIN_PATH}/admin.js`, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin', 'admin.js'));
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
    try { // diagnóstico: mostra linhas de conquista com tipo fora do esperado
      const bad = await pool.query(
        "select id, type from achievement_defs where type not in ('points','streak','misses','missstreak','titles')"
      );
      if (bad.rowCount) console.error('Conquistas com tipo desconhecido:', JSON.stringify(bad.rows));
    } catch (_) { /* tabela pode nem existir */ }
    process.exit(1);
  }
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Bolão rodando na porta ${PORT}`));

  // Lembrete de "enquete fechando": confere a cada minuto (só roda enquanto o servidor está acordado)
  setInterval(() => {
    notifyClosingSoon().catch((e) => console.error('Lembrete de enquete falhou:', e.message));
  }, 60 * 1000).unref();

  const shutdown = () => {
    server.close();
    pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})();
