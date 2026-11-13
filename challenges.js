'use strict';

/* X1 Bolado valendo pontos do ranking geral.

   Dois tipos:
   - 'poll'   : em cima de uma enquete aberta. Cada lado fica com uma opção diferente; quando o admin define a
                resposta certa, quem estiver nela leva a aposta do outro. Se nenhuma das duas for a certa
                (enquete com 3+ opções ou "a casa ganha"), empata e cada um fica com os seus pontos.
   - 'custom' : X1 Bolado livre ("quem vence a partida?"). Um mediador (um participante ou o admin) decide quem
                ganhou e paga o lado certo.

   Pontos: o valor apostado de cada lado fica travado (sai do saldo para apostar) enquanto o X1 Bolado estiver
   pendente (só quem desafiou) ou ativo (os dois). Quando é decidido, o vencedor soma `stake` e o perdedor
   perde `stake` no ranking geral e no semanal (ver computeStandings / computeWeeklyStandings no server.js). */

module.exports = function setupChallenges(d) {
  const {
    app, q, tx, wrap, uid, limit, requireUser, requireAdmin, requirePerm, broadcast,
    fetchPolls, pollStatus, getFlag, getSetting, setSetting, iso, sendPush, pushEnabled, short,
    computeStandings, lockedStakes, availableBalance,
  } = d;

  const DEFAULT_HOURS = 48;
  const HOURS_ALLOWED = [6, 24, 48, 72, 168];
  const MAX_PENDING_PER_USER = 10;

  const run = (client, text, params) => (client ? client.query(text, params) : q(text, params));

  /* ---------- Configuração (guardada em settings) ---------- */
  const enabled = () => getFlag('challenges_enabled'); // ligado por padrão; só '0' desliga
  async function maxStake() {
    const n = Number(await getSetting('challenge_max_stake', ''));
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /* ---------- Expiração ---------- */
  // Pendente vira "expirado" quando o prazo passa ou quando a enquete deixa de estar aberta
  const EXPIRE_SQL = `update challenges c set status = 'expired'
    where c.status = 'pending' and (
      c.expires_at <= now()
      or (c.poll_id is not null and exists (
        select 1 from polls p where p.id = c.poll_id
          and (p.closed or p.cancelled or p.correct_option_id is not null
               or (p.closes_at is not null and p.closes_at <= now()))))
    )`;
  const expireChallenges = (client = null) => run(client, EXPIRE_SQL);
  setInterval(() => { expireChallenges().catch(() => {}); }, 60 * 1000).unref();

  /* ---------- Avisos (push) ---------- */
  async function pushTo(userId, payload) {
    if (!pushEnabled || !userId) return;
    try {
      const { rows } = await q('select endpoint, p256dh, auth from push_subscriptions where user_id = $1', [userId]);
      await sendPush(rows, { url: '/#desafios', ...payload });
    } catch (e) {
      console.error('[X1 Bolados] push falhou:', e.message);
    }
  }

  /* ---------- Leitura ---------- */
  const SELECT_SQL = `select c.*,
      uc.display_name as creator_name, uc.avatar_url as creator_avatar,
      uo.display_name as opponent_name, uo.avatar_url as opponent_avatar,
      um.display_name as mediator_name, um.avatar_url as mediator_avatar
    from challenges c
    join users uc on uc.id = c.creator_id
    join users uo on uo.id = c.opponent_id
    left join users um on um.id = c.mediator_id`;

  const person = (id, name, avatar) => (id ? { id, name, avatar } : null);
  const loserOf = (r) => (r.winner_id ? (r.winner_id === r.creator_id ? r.opponent_id : r.creator_id) : null);

  function view(r, meId) {
    const status = r.status === 'pending' && new Date(r.expires_at).getTime() <= Date.now() ? 'expired' : r.status;
    const role = r.creator_id === meId ? 'creator' : r.opponent_id === meId ? 'opponent' : r.mediator_id === meId ? 'mediator' : null;
    return {
      id: r.id,
      kind: r.kind,
      status,
      role,
      title: r.title,
      description: r.description,
      stake: r.stake,
      creatorSide: r.creator_side,
      opponentSide: r.opponent_side,
      creator: person(r.creator_id, r.creator_name, r.creator_avatar),
      opponent: person(r.opponent_id, r.opponent_name, r.opponent_avatar),
      mediator: person(r.mediator_id, r.mediator_name, r.mediator_avatar),
      mediatorIsAdmin: r.kind === 'custom' && !r.mediator_id,
      pollId: r.poll_id,
      winnerId: r.winner_id,
      draw: status === 'settled' && !r.winner_id,
      expiresAt: iso(r.expires_at),
      createdAt: iso(r.created_at),
      acceptedAt: iso(r.accepted_at),
      resolvedAt: iso(r.resolved_at),
    };
  }

  // Opções que o desafiado pode escolher (todas, menos a de quem desafiou) em X1 Bolados de enquete pendentes
  async function attachChoices(rows, views) {
    const need = views.filter((v) => v.kind === 'poll' && v.role === 'opponent' && v.status === 'pending' && v.pollId);
    if (!need.length) return;
    const polls = await fetchPolls('where id = any($1::text[])', [[...new Set(need.map((v) => v.pollId))]]);
    const byPoll = new Map(polls.map((p) => [p.id, p]));
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const v of need) {
      const p = byPoll.get(v.pollId);
      const mine = rowById.get(v.id).creator_option_id;
      v.choices = p ? p.options.filter((o) => !o.isHouse && o.id !== mine).map((o) => ({ id: o.id, text: o.text })) : [];
    }
  }

  /* ---------- Liquidação de X1 Bolados de enquete ---------- */
  // Chamado quando a enquete recebe (ou troca) a resposta certa, e depois de "reabrir e zerar".
  // Sem resposta, o X1 Bolado volta a ficar ativo; com resposta, quem estava na opção certa ganha.
  async function settlePollChallenges(pollId) {
    const { rows: pr } = await q('select correct_option_id, cancelled, resolved_at from polls where id = $1', [pollId]);
    const p = pr[0];
    if (!p || p.cancelled) return;
    const { rows } = await q("select * from challenges where poll_id = $1 and status in ('active', 'settled')", [pollId]);
    for (const c of rows) {
      if (!p.correct_option_id) {
        if (c.status === 'settled') {
          await q("update challenges set status = 'active', winner_id = null, resolved_at = null where id = $1", [c.id]);
        }
        continue;
      }
      const winner = p.correct_option_id === c.creator_option_id ? c.creator_id
        : p.correct_option_id === c.opponent_option_id ? c.opponent_id : null;
      await q(
        "update challenges set status = 'settled', winner_id = $2, resolved_at = coalesce($3::timestamptz, now()) where id = $1",
        [c.id, winner, p.resolved_at]
      );
      if (c.status === 'active') notifyResult({ ...c, winner_id: winner });
    }
  }

  async function notifyResult(c) {
    const { rows } = await q('select id, display_name from users where id = any($1::text[])', [[c.creator_id, c.opponent_id]]);
    const name = (id) => rows.find((r) => r.id === id)?.display_name || 'o outro participante';
    const title = short(c.title || 'X1 Bolado', 60);
    for (const id of [c.creator_id, c.opponent_id]) {
      const other = name(id === c.creator_id ? c.opponent_id : c.creator_id);
      if (!c.winner_id) {
        pushTo(id, { title: '⚔️ X1 Bolado empatado', body: `"${title}" contra ${other}: ninguém perde pontos.` });
      } else if (c.winner_id === id) {
        pushTo(id, { title: '⚔️ Você ganhou o X1 Bolado!', body: `+${c.stake} pontos contra ${other} em "${title}".` });
      } else {
        pushTo(id, { title: '⚔️ X1 Bolado perdido', body: `−${c.stake} pontos contra ${other} em "${title}".` });
      }
    }
  }

  const cancelAllOfPoll = (client, pollId, includeSettled) => run(client,
    `update challenges set status = 'cancelled', winner_id = null, resolved_at = null
     where poll_id = $1 and (status in ('pending', 'active') or ($2::boolean and status = 'settled'))`,
    [pollId, includeSettled]);
  // Reabrir mantendo os pontos: o resultado dos X1 Bolados fica gravado e eles se soltam da enquete
  const detachSettledOfPoll = (client, pollId) => run(client,
    "update challenges set poll_id = null where poll_id = $1 and status = 'settled'", [pollId]);

  /* ---------- Validações ---------- */
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  async function loadParticipant(id) {
    if (!id) return null;
    const { rows } = await q('select id, display_name from users where id = $1 and not is_house and not banned', [id]);
    return rows[0] || null;
  }

  function parseStake(body, cap) {
    const stake = Number(body?.stake);
    if (!Number.isInteger(stake) || stake < 1 || stake > 1000000) {
      return { error: 'Informe quantos pontos quer apostar (número inteiro, mínimo 1).' };
    }
    if (cap && stake > cap) return { error: `O valor máximo de um X1 Bolado é ${cap} ${cap === 1 ? 'ponto' : 'pontos'}.` };
    return { stake };
  }

  const gate = wrap(async (req, res, next) => {
    if (!(await enabled())) return res.status(403).json({ error: 'Os X1 Bolados estão desligados no momento.' });
    next();
  });

  /* ---------- Rotas dos participantes ---------- */
  // Lista de pessoas que dá para desafiar (ou escolher como mediador)
  app.get('/api/challenges/users', requireUser, wrap(async (req, res) => {
    const { rows } = await q(
      `select id, display_name, login, avatar_url from users
       where not is_house and not banned and not is_test and id <> $1
       order by lower(display_name) limit 1000`,
      [req.user.id]
    );
    res.json({ users: rows.map((u) => ({ id: u.id, name: u.display_name, login: u.login, avatar: u.avatar_url })) });
  }));

  app.get('/api/challenges', requireUser, wrap(async (req, res) => {
    await expireChallenges();
    const { rows } = await q(
      `${SELECT_SQL}
       where c.creator_id = $1 or c.opponent_id = $1 or c.mediator_id = $1
       order by c.created_at desc limit 150`,
      [req.user.id]
    );
    const list = rows.map((r) => view(r, req.user.id));
    await attachChoices(rows, list);
    const [balance, cap] = await Promise.all([availableBalance(req.user.id), maxStake()]);
    res.json({ enabled: await enabled(), balance, maxStake: cap, challenges: list });
  }));

  app.post('/api/challenges', requireUser, gate, limit('challenge', 30, 60 * 1000), wrap(async (req, res) => {
    const body = req.body || {};
    const kind = body.kind === 'poll' ? 'poll' : body.kind === 'custom' ? 'custom' : null;
    if (!kind) return res.status(400).json({ error: 'Tipo de X1 Bolado inválido.' });

    const parsed = parseStake(body, await maxStake());
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { stake } = parsed;

    const opponentId = String(body.opponentId ?? '');
    if (opponentId === req.user.id) return res.status(400).json({ error: 'Você não pode desafiar a si mesmo.' });
    const opponent = await loadParticipant(opponentId);
    if (!opponent) return res.status(400).json({ error: 'Escolha um participante para desafiar.' });

    const f = { kind, title: '', description: '', creatorSide: '', pollId: null, creatorOptionId: null, opponentOptionId: null, opponentSide: '', mediatorId: null, hours: DEFAULT_HOURS };
    let pollCloses = null;

    if (kind === 'poll') {
      const [poll] = await fetchPolls('where id = $1', [String(body.pollId ?? '')]);
      if (!poll || !poll.visible) return res.status(404).json({ error: 'Enquete não encontrada.' });
      if (pollStatus(poll) !== 'open') return res.status(409).json({ error: 'Só dá para desafiar em enquetes com a votação aberta.' });
      const options = poll.options.filter((o) => !o.isHouse);
      if (options.length < 2) return res.status(400).json({ error: 'Esta enquete não tem opções suficientes para um X1 Bolado.' });
      const mine = options.find((o) => o.id === String(body.optionId ?? ''));
      if (!mine) return res.status(400).json({ error: 'Escolha a sua opção.' });
      // O desafiado escolhe o lado dele na hora de aceitar (qualquer opção diferente da sua)
      Object.assign(f, { title: poll.title, creatorSide: mine.text, pollId: poll.id, creatorOptionId: mine.id });
      pollCloses = poll.closesAt ? Date.parse(poll.closesAt) : null;
    } else {
      f.title = text(body.title, 120);
      f.description = text(body.description, 300);
      f.creatorSide = text(body.creatorSide, 60);
      f.opponentSide = text(body.opponentSide, 60);
      if (f.title.length < 3) return res.status(400).json({ error: 'Escreva o X1 Bolado (mínimo 3 letras).' });
      if (!f.creatorSide || !f.opponentSide) return res.status(400).json({ error: 'Preencha o lado de cada um.' });
      if (f.creatorSide.toLowerCase() === f.opponentSide.toLowerCase()) return res.status(400).json({ error: 'Os dois lados precisam ser diferentes.' });
      const mid = String(body.mediatorId ?? '');
      if (mid && mid !== 'admin') {
        if (mid === req.user.id || mid === opponentId) return res.status(400).json({ error: 'O mediador precisa ser uma terceira pessoa.' });
        const med = await loadParticipant(mid);
        if (!med) return res.status(400).json({ error: 'Mediador não encontrado.' });
        f.mediatorId = med.id;
      }
      const hours = Number(body.hours);
      f.hours = HOURS_ALLOWED.includes(hours) ? hours : DEFAULT_HOURS;
    }

    let expiresAt = Date.now() + f.hours * 3600 * 1000;
    if (pollCloses) expiresAt = Math.min(expiresAt, pollCloses);

    const points = (await computeStandings()).ranking.find((r) => r.userId === req.user.id)?.points || 0;
    const out = await tx(async (c) => {
      // Mesma trava por pessoa das apostas: dois gastos ao mesmo tempo não usam o mesmo saldo duas vezes
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [req.user.id]);
      await expireChallenges(c);
      const pending = (await c.query("select count(*)::int as n from challenges where creator_id = $1 and status = 'pending'", [req.user.id])).rows[0].n;
      if (pending >= MAX_PENDING_PER_USER) return { status: 429, error: `Você já tem ${MAX_PENDING_PER_USER} X1 Bolados esperando resposta. Aguarde ou cancele algum.` };
      if (f.pollId) {
        const dup = await c.query(
          "select 1 from challenges where poll_id = $1 and creator_id = $2 and opponent_id = $3 and status = 'pending'",
          [f.pollId, req.user.id, opponentId]
        );
        if (dup.rowCount) return { status: 409, error: 'Você já desafiou essa pessoa nesta enquete e ela ainda não respondeu.' };
      }
      const free = points - (await lockedStakes(c, req.user.id));
      if (stake > free) {
        const n = Math.max(0, free);
        return { status: 400, error: `Saldo insuficiente: ${n} ${n === 1 ? 'ponto disponível' : 'pontos disponíveis'} para apostar.` };
      }
      const id = uid();
      await c.query(
        `insert into challenges (id, kind, creator_id, opponent_id, mediator_id, poll_id, creator_option_id, opponent_option_id,
                                 title, description, creator_side, opponent_side, stake, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, f.kind, req.user.id, opponentId, f.mediatorId, f.pollId, f.creatorOptionId, f.opponentOptionId,
          f.title, f.description, f.creatorSide, f.opponentSide, stake, new Date(expiresAt)]
      );
      return { id };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });

    broadcast();
    pushTo(opponentId, { title: '⚔️ Você foi desafiado!', body: `${short(req.user.display_name, 40)} apostou ${stake} pts: "${short(f.title, 80)}"` });
    if (f.mediatorId) pushTo(f.mediatorId, { title: '⚖️ Você foi chamado para mediar', body: `${short(req.user.display_name, 40)} vs ${short(opponent.display_name, 40)}: "${short(f.title, 80)}"` });
    res.status(201).json({ ok: true, id: out.id });
  }));

  // Carrega o X1 Bolado e confere o papel da pessoa; devolve { row } ou { status, error }
  async function mine(req, role, client = null) {
    const { rows } = await run(client, `select * from challenges where id = $1${client ? ' for update' : ''}`, [req.params.id]);
    const row = rows[0];
    if (!row) return { status: 404, error: 'X1 Bolado não encontrado.' };
    const ok = role === 'creator' ? row.creator_id === req.user.id
      : role === 'opponent' ? row.opponent_id === req.user.id
      : role === 'mediator' ? row.mediator_id === req.user.id : false;
    if (!ok) return { status: 403, error: 'Você não pode fazer isso neste X1 Bolado.' };
    return { row };
  }

  app.post('/api/challenges/:id/accept', requireUser, gate, wrap(async (req, res) => {
    const pre = await mine(req, 'opponent');
    if (pre.error) return res.status(pre.status).json({ error: pre.error });
    let opponentOption = null;
    if (pre.row.kind === 'poll') {
      const [poll] = await fetchPolls('where id = $1', [pre.row.poll_id || '']);
      if (!poll || pollStatus(poll) !== 'open') return res.status(409).json({ error: 'A votação desta enquete já encerrou. O X1 Bolado não vale mais.' });
      const choices = poll.options.filter((o) => !o.isHouse && o.id !== pre.row.creator_option_id);
      if (!choices.length) return res.status(409).json({ error: 'Não sobrou opção para você nesta enquete.' });
      opponentOption = choices.length === 1 ? choices[0] : choices.find((o) => o.id === String(req.body?.optionId ?? ''));
      if (!opponentOption) return res.status(400).json({ error: 'Escolha o seu lado (uma opção diferente da de quem desafiou).' });
    }
    const points = (await computeStandings()).ranking.find((r) => r.userId === req.user.id)?.points || 0;
    const out = await tx(async (c) => {
      const cur = await mine(req, 'opponent', c);
      if (cur.error) return cur;
      const row = cur.row;
      // Trava as duas pessoas, sempre na mesma ordem (evita impasse entre dois aceites cruzados)
      for (const id of [row.creator_id, row.opponent_id].sort()) await c.query('select pg_advisory_xact_lock(hashtext($1))', [id]);
      await expireChallenges(c);
      const fresh = (await c.query('select status from challenges where id = $1', [row.id])).rows[0];
      if (fresh.status === 'expired') return { status: 409, error: 'Este X1 Bolado expirou.' };
      if (fresh.status !== 'pending') return { status: 409, error: 'Este X1 Bolado já foi respondido.' };
      const free = points - (await lockedStakes(c, req.user.id));
      if (row.stake > free) {
        const n = Math.max(0, free);
        return { status: 400, error: `Saldo insuficiente: você tem ${n} ${n === 1 ? 'ponto disponível' : 'pontos disponíveis'} e o X1 Bolado vale ${row.stake}.` };
      }
      await c.query(
        `update challenges set status = 'active', accepted_at = now(),
           opponent_option_id = coalesce($2::text, opponent_option_id),
           opponent_side = case when $3::text <> '' then $3::text else opponent_side end
         where id = $1`,
        [row.id, opponentOption ? opponentOption.id : null, opponentOption ? opponentOption.text : '']
      );
      return { row };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    broadcast();
    pushTo(out.row.creator_id, { title: '⚔️ X1 Bolado aceito!', body: `${short(req.user.display_name, 40)} topou "${short(out.row.title, 80)}" valendo ${out.row.stake} pts.` });
    res.json({ ok: true });
  }));

  app.post('/api/challenges/:id/decline', requireUser, wrap(async (req, res) => {
    const cur = await mine(req, 'opponent');
    if (cur.error) return res.status(cur.status).json({ error: cur.error });
    const r = await q("update challenges set status = 'declined' where id = $1 and status = 'pending'", [cur.row.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Este X1 Bolado já foi respondido ou expirou.' });
    broadcast();
    pushTo(cur.row.creator_id, { title: 'X1 Bolado recusado', body: `${short(req.user.display_name, 40)} recusou "${short(cur.row.title, 80)}". Seus pontos foram liberados.` });
    res.json({ ok: true });
  }));

  app.post('/api/challenges/:id/cancel', requireUser, wrap(async (req, res) => {
    const cur = await mine(req, 'creator');
    if (cur.error) return res.status(cur.status).json({ error: cur.error });
    const r = await q("update challenges set status = 'cancelled' where id = $1 and status = 'pending'", [cur.row.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Só dá para cancelar enquanto o X1 Bolado espera resposta.' });
    broadcast();
    res.json({ ok: true });
  }));

  const WINNER_KEYS = ['creator', 'opponent', 'draw'];
  const winnerFor = (row, key) => (key === 'creator' ? row.creator_id : key === 'opponent' ? row.opponent_id : null);

  // O mediador diz quem ganhou: o vencedor leva a aposta do outro
  app.post('/api/challenges/:id/resolve', requireUser, wrap(async (req, res) => {
    const key = String(req.body?.winner ?? '');
    if (!WINNER_KEYS.includes(key)) return res.status(400).json({ error: 'Diga quem ganhou (ou empate).' });
    const cur = await mine(req, 'mediator');
    if (cur.error) return res.status(cur.status).json({ error: cur.error });
    if (cur.row.kind !== 'custom') return res.status(409).json({ error: 'Este X1 Bolado é decidido pela enquete.' });
    const winner = winnerFor(cur.row, key);
    const r = await q(
      "update challenges set status = 'settled', winner_id = $2, resolved_at = now() where id = $1 and status = 'active'",
      [cur.row.id, winner]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'Só dá para decidir um X1 Bolado que já foi aceito e ainda não tem resultado.' });
    await computeStandings(); // grava na hora conquistas/prêmios que esse resultado destravar
    broadcast();
    notifyResult({ ...cur.row, winner_id: winner });
    res.json({ ok: true });
  }));

  // O mediador desiste de mediar: tudo é devolvido
  app.post('/api/challenges/:id/void', requireUser, wrap(async (req, res) => {
    const cur = await mine(req, 'mediator');
    if (cur.error) return res.status(cur.status).json({ error: cur.error });
    const r = await q("update challenges set status = 'cancelled' where id = $1 and status in ('pending', 'active')", [cur.row.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Este X1 Bolado já terminou.' });
    broadcast();
    for (const id of [cur.row.creator_id, cur.row.opponent_id]) {
      pushTo(id, { title: 'X1 Bolado anulado', body: `O mediador anulou "${short(cur.row.title, 80)}". Os pontos foram devolvidos.` });
    }
    res.json({ ok: true });
  }));

  /* ---------- Rotas do admin ---------- */
  app.get('/api/admin/challenges', requireAdmin, wrap(async (req, res) => {
    await expireChallenges();
    const { rows } = await q(`${SELECT_SQL} order by c.created_at desc limit 300`);
    res.json({
      enabled: await enabled(),
      maxStake: await maxStake(),
      challenges: rows.map((r) => view(r, null)),
    });
  }));

  app.post('/api/admin/challenges/config', requirePerm('challenges'), wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') await setSetting('challenges_enabled', b.enabled ? '1' : '0');
    if (b.maxStake !== undefined) {
      const raw = b.maxStake === null || b.maxStake === '' ? null : Number(b.maxStake);
      if (raw !== null && (!Number.isInteger(raw) || raw < 1 || raw > 1000000)) {
        return res.status(400).json({ error: 'O valor máximo precisa ser um número inteiro de 1 a 1.000.000 (ou vazio, sem limite).' });
      }
      await setSetting('challenge_max_stake', raw === null ? '' : String(raw));
    }
    res.json({ ok: true });
  }));

  // Admin decide (ou corrige) o vencedor de um X1 Bolado livre
  app.post('/api/admin/challenges/:id/resolve', requirePerm('challenges'), wrap(async (req, res) => {
    const key = String(req.body?.winner ?? '');
    if (!WINNER_KEYS.includes(key)) return res.status(400).json({ error: 'Diga quem ganhou (ou empate).' });
    const { rows } = await q('select * from challenges where id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'X1 Bolado não encontrado.' });
    if (row.kind !== 'custom') return res.status(409).json({ error: 'Este X1 Bolado é decidido pelo resultado da enquete.' });
    if (!['active', 'settled'].includes(row.status)) return res.status(409).json({ error: 'Só dá para decidir um X1 Bolado aceito.' });
    const winner = winnerFor(row, key);
    await q("update challenges set status = 'settled', winner_id = $2, resolved_at = now() where id = $1", [row.id, winner]);
    await computeStandings();
    if (row.status === 'active') notifyResult({ ...row, winner_id: winner });
    res.json({ ok: true });
  }));

  // Anular: devolve tudo (se já tinha resultado, os pontos dele saem do ranking)
  app.post('/api/admin/challenges/:id/void', requirePerm('challenges'), wrap(async (req, res) => {
    const r = await q(
      "update challenges set status = 'cancelled', winner_id = null, resolved_at = null where id = $1 and status in ('pending', 'active', 'settled')",
      [req.params.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'Este X1 Bolado já está encerrado sem pontos em jogo.' });
    res.json({ ok: true });
  }));

  app.delete('/api/admin/challenges/:id', requirePerm('challenges'), wrap(async (req, res) => {
    const r = await q('delete from challenges where id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'X1 Bolado não encontrado.' });
    res.json({ ok: true });
  }));

  return { settlePollChallenges, cancelAllOfPoll, detachSettledOfPoll, enabled };
};
