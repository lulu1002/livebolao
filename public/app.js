(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const state = {
    user: null,
    polls: [],
    pollsError: null,
    loaded: false,
    ranking: null,
    rankError: null,
    view: 'polls',
    profileId: null,
    profile: null,
    profileError: null,
  };

  /* ---------- Utilidades ---------- */
  // Monta elementos com textContent (nada de innerHTML: sem risco de XSS)
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw new Error('Sem resposta do servidor. Se ele estava parado, aguarde alguns segundos e tente de novo.');
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* resposta sem corpo */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Algo deu errado. Tente de novo.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const fmtDate = (iso) =>
    new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function xMark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M5 5 L19 19 M19 5 L5 19');
    svg.append(path);
    return svg;
  }

  // Foto da Twitch, ou a inicial do nome quando não há foto
  function avatarEl(name, url, size = '') {
    const cls = `avatar${size ? ` ${size}` : ''}`;
    if (url) {
      return h('img', { class: cls, src: url, alt: '', width: '36', height: '36', loading: 'lazy', referrerpolicy: 'no-referrer' });
    }
    return h('span', { class: `${cls} ph`, 'aria-hidden': 'true' }, (name || '?').slice(0, 1).toUpperCase());
  }

  /* ---------- Cabeçalho ---------- */
  function renderWho() {
    const box = $('#who');
    box.replaceChildren();
    if (state.user) {
      box.append(
        avatarEl(state.user.name, state.user.avatar),
        h('a', { class: 'me-name', href: `#perfil/${state.user.id}` }, state.user.name),
        h('button', { class: 'btn ghost small', type: 'button', onclick: logout }, 'Sair')
      );
    } else {
      box.append(h('a', { class: 'btn twitch small', href: '/auth/twitch' }, 'Entrar com a Twitch'));
    }
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* segue */ }
    state.user = null;
    renderWho();
    refresh();
  }

  /* ---------- Enquetes ---------- */
  async function loadPolls() {
    try {
      const data = await api('/api/polls');
      state.polls = data.polls;
      state.pollsError = null;
    } catch (e) {
      state.pollsError = e.message;
    }
    state.loaded = true;
    renderPolls();
  }

  function whenLabel(p) {
    if (p.status === 'open') return p.closesAt ? `Fecha em ${fmtDate(p.closesAt)}` : 'Fecha quando o admiro encerrar';
    if (p.status === 'closed') return 'Aguardando resultado';
    return 'Resultado definido';
  }

  function noteFor(p) {
    if (p.status === 'open') {
      if (!state.user) {
        return h('p', { class: 'note' }, 'Entre com a Twitch Meu nobre rlk para registrar seu palpite. ',
          h('a', { class: 'linkish', href: '/auth/twitch' }, 'Entrar'));
      }
      return h('p', { class: 'note' },
        p.myVote ? 'Palpite registrado. Você pode trocar até a votação encerrar.' : 'Toque em uma opção para dar seu palpite.');
    }
    if (!state.user) return null;
    if (!p.myVote) return h('p', { class: 'note' }, 'Você não votou nesta enquete.');
    if (p.status === 'closed') return h('p', { class: 'note' }, 'Palpite registrado. Aguardando o resultado.');
    if (p.myPoints === null) {
      return h('p', { class: p.myHit ? 'note hit' : 'note miss' },
        p.myHit ? 'Você acertou. Os pontos foram zerados junto com o ranking.' : 'Você errou desta vez.');
    }
    if (p.myPoints > 0) {
      return h('p', { class: 'note hit' }, `Você acertou: +${p.myPoints} ${p.myPoints === 1 ? 'ponto' : 'pontos'}.`);
    }
    return h('p', { class: 'note miss' }, 'Você errou desta vez. 0 pontos.');
  }

  function renderOption(p, o) {
    const isOpen = p.status === 'open';
    const mine = p.myVote === o.id;
    const correct = p.status === 'resolved' && p.correctOptionId === o.id;
    const wrong = p.status === 'resolved' && mine && !correct;
    const cls = ['opt', mine && 'is-mine', correct && 'is-correct', wrong && 'is-wrong'].filter(Boolean).join(' ');

    const btn = h('button', {
      type: 'button',
      class: cls,
      role: 'radio',
      'aria-checked': String(mine),
      disabled: !isOpen,
      'data-key': `${p.id}:${o.id}`,
      onclick: () => vote(p, o.id),
    }, h('span', { class: 'box' }, xMark()), h('span', { class: 'opt-text' }, o.text));

    if (!isOpen) {
      const total = p.totalVotes || 0;
      const pct = total ? Math.round((o.votes / total) * 100) : 0;
      btn.style.setProperty('--pct', `${pct}%`);
      btn.prepend(h('span', { class: 'bar' }));
      if (correct) btn.append(h('span', { class: 'tag' }, 'Certa'));
      btn.append(h('span', { class: 'opt-meta' }, `${pct}% (${o.votes})`));
    }
    return btn;
  }

  function renderPoll(p) {
    const statusText = { open: 'Aberta', closed: 'Encerrada', resolved: 'Resultado' }[p.status];
    return h('article', { class: 'ticket' },
      h('div', { class: 'stub' },
        h('div', { class: 'pts' },
          h('span', { class: 'pts-n' }, p.points),
          h('span', { class: 'pts-l' }, p.points === 1 ? 'ponto' : 'pontos')),
        h('span', { class: `pill ${p.status}` }, statusText),
        h('div', { class: 'when' }, whenLabel(p))),
      h('div', { class: 'body' },
        h('h2', {}, p.title),
        p.description ? h('p', { class: 'desc' }, p.description) : null,
        h('div', { class: 'opts', role: 'radiogroup', 'aria-label': p.title }, p.options.map((o) => renderOption(p, o))),
        noteFor(p)));
  }

  function renderPolls() {
    const box = $('#polls');
    const active = document.activeElement && box.contains(document.activeElement)
      ? document.activeElement.dataset.key : null;
    box.replaceChildren();

    if (state.pollsError) {
      box.append(h('div', { class: 'empty' },
        h('p', {}, state.pollsError),
        h('button', { class: 'btn', type: 'button', onclick: loadPolls }, 'Tentar de novo')));
      return;
    }
    if (!state.polls.length) {
      box.append(h('div', { class: 'empty' },
        h('p', {}, 'Ainda não há enquetes. Quando o alto escalao publicar a primeira, ela aparece aqui.')));
      return;
    }
    state.polls.forEach((p) => box.append(renderPoll(p)));
    if (active) {
      const el = box.querySelector(`[data-key="${active}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  async function vote(p, optionId) {
    if (!state.user) {
      toast('Entre com a Twitch para dar seu palpite.');
      return;
    }
    try {
      const { poll } = await api(`/api/polls/${p.id}/vote`, { method: 'POST', body: { optionId } });
      state.polls = state.polls.map((x) => (x.id === poll.id ? poll : x));
      renderPolls();
      toast('Palpite salvo');
    } catch (e) {
      toast(e.message, true);
      if (e.status === 401) {
        state.user = null;
        renderWho();
      }
      loadPolls();
    }
  }

  /* ---------- Ranking ---------- */
  async function loadRanking() {
    try {
      state.ranking = await api('/api/ranking');
      state.rankError = null;
    } catch (e) {
      state.rankError = e.message;
    }
    renderRanking();
  }

  function renderRanking() {
    const box = $('#ranking');
    box.replaceChildren();
    if (state.rankError) {
      box.append(h('div', { class: 'empty' },
        h('p', {}, state.rankError),
        h('button', { class: 'btn', type: 'button', onclick: loadRanking }, 'Tentar de novo')));
      return;
    }
    const r = state.ranking;
    if (!r) {
      box.append(h('p', { class: 'note' }, 'Carregando ranking…'));
      return;
    }
    if (!r.ranking.length) {
      box.append(h('div', { class: 'empty' }, h('p', {}, 'Ninguém entrou no bolão ainda. Entre com a Twitch e faça o primeiro palpite.')));
      return;
    }
    if (!r.resolved) {
      box.append(h('p', { class: 'note' }, 'Os pontos aparecem quando o admiro definir a primeira resposta certa.'));
    }
    box.append(h('ol', { class: 'rank' }, r.ranking.map((s) => {
      const me = state.user && state.user.id === s.userId;
      const hits = (s.played
        ? `${s.hits} ${s.hits === 1 ? 'acerto' : 'acertos'} em ${s.played} ${s.played === 1 ? 'enquete' : 'enquetes'}`
        : 'Sem enquetes resolvidas') + (s.streak >= 2 ? ` · sequência de ${s.streak}` : '');
      return h('li', { class: me ? 'me' : null },
        h('span', { class: `pos${s.position === 1 && s.points > 0 ? ' first' : ''}` }, s.position),
        avatarEl(s.name, s.avatar),
        h('span', {}, h('a', { class: 'nm', href: `#perfil/${s.userId}` }, s.name + (me ? ' (você)' : '')), h('span', { class: 'hits' }, hits)),
        h('span', { class: 'score' }, h('b', {}, s.points), ' pts'));
    })));
  }

  /* ---------- Perfil ---------- */
  async function loadProfile() {
    const id = state.profileId;
    try {
      const data = await api(`/api/users/${encodeURIComponent(id)}/profile`);
      if (id !== state.profileId) return; // já navegou para outro perfil
      state.profile = data;
      state.profileError = null;
    } catch (e) {
      state.profile = null;
      state.profileError = e.message;
    }
    renderProfile();
  }

  function stat(label, value, sub) {
    return h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, h('b', {}, String(value)), sub ? h('small', {}, sub) : null));
  }

  function historyItem(i) {
    const detail = i.chosen
      ? `Palpite: ${i.chosen}${i.correct ? ` · Certa: ${i.correct}` : ''}`
      : 'Rodada guardada';
    return h('li', {},
      h('div', {},
        h('span', { class: 'nm' }, i.title),
        h('span', { class: 'hits' }, detail)),
      h('div', { class: 'hist-res' },
        h('span', { class: `pill ${i.hit ? 'hit' : 'miss'}` }, i.hit ? `Acertou +${i.points}` : 'Errou'),
        i.bonus ? h('span', { class: 'pill bonus' }, `+${i.bonus} bônus`) : null));
  }

  function renderProfile() {
    const box = $('#profile');
    box.replaceChildren(
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => navigate('#ranking') }, 'Voltar ao ranking'));
    if (state.profileError) {
      box.append(h('div', { class: 'empty' }, h('p', {}, state.profileError)));
      return;
    }
    const p = state.profile;
    if (!p) {
      box.append(h('p', { class: 'note' }, 'Carregando perfil…'));
      return;
    }
    const me = state.user && state.user.id === p.userId;
    box.append(
      h('div', { class: 'profile-head' },
        avatarEl(p.name, p.avatar, 'big'),
        h('div', {},
          h('h2', {}, p.name + (me ? ' (você)' : '')),
          h('a', { class: 'linkish', href: `https://www.twitch.tv/${encodeURIComponent(p.login)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Canal na Twitch'))),
      h('dl', { class: 'stats' },
        stat('Posição', `${p.position}º`),
        stat('Pontos', p.points),
        stat('Acertos', `${p.hits}/${p.played}`, p.played ? `${p.accuracy}% de aproveitamento` : ''),
        stat('Sequência', p.streak, `melhor: ${p.bestStreak}`)),
      p.rule.every > 0
        ? h('p', { class: 'note' },
          `Bônus de sequência: +${p.rule.bonus} pontos a cada ${p.rule.every} acertos seguidos.` +
          (p.bonus ? ` Já rendeu ${p.bonus} pontos.` : ''))
        : null,
      h('h3', { class: 'section-title' }, 'Histórico'),
      p.history.length
        ? h('ol', { class: 'hist' }, p.history.map(historyItem))
        : h('div', { class: 'empty' }, h('p', {}, 'Nenhum palpite resolvido ainda.')));
  }

  /* ---------- Navegação ---------- */
  function setView(view, profileId) {
    state.view = view;
    $('#view-polls').hidden = view !== 'polls';
    $('#view-ranking').hidden = view !== 'ranking';
    $('#view-profile').hidden = view !== 'profile';
    $('#tab-polls').setAttribute('aria-selected', String(view === 'polls'));
    $('#tab-ranking').setAttribute('aria-selected', String(view !== 'polls'));
    if (view === 'ranking') loadRanking();
    if (view === 'profile') {
      state.profileId = profileId;
      state.profile = null;
      state.profileError = null;
      renderProfile();
      loadProfile();
      window.scrollTo(0, 0);
    }
  }

  function route() {
    const m = location.hash.match(/^#perfil\/([\w-]+)$/);
    if (m) setView('profile', m[1]);
    else setView(location.hash === '#ranking' ? 'ranking' : 'polls');
  }

  function navigate(hash) {
    history.pushState(null, '', hash || location.pathname);
    route();
  }

  window.addEventListener('popstate', route); // botão voltar e links #perfil/...
  $('#tab-polls').addEventListener('click', () => navigate(''));
  $('#tab-ranking').addEventListener('click', () => navigate('#ranking'));

  /* ---------- Atualização automática ---------- */
  function refresh() {
    loadPolls();
    if (state.view === 'ranking') loadRanking();
    if (state.view === 'profile') loadProfile();
  }

  // O servidor avisa quando o admin publica, encerra ou define uma resposta
  function connectEvents() {
    if (!('EventSource' in window)) return;
    const es = new EventSource('/api/events');
    let opened = false;
    es.addEventListener('open', () => {
      if (opened) refresh(); // reconectou: pode ter perdido algo
      opened = true;
    });
    es.addEventListener('update', () => {
      // pequeno atraso aleatório para não sobrecarregar o servidor
      setTimeout(refresh, Math.random() * 400);
    });
  }

  /* ---------- Início ---------- */
  function showLoginResult() {
    const params = new URLSearchParams(location.search);
    const result = params.get('login');
    if (!result) return;
    if (result === 'cancelado') toast('Login cancelado.');
    else toast('Não foi possível entrar com a Twitch. Tente de novo.', true);
    history.replaceState(null, '', location.pathname + location.hash);
  }

  async function init() {
    renderWho();
    showLoginResult();
    try {
      const me = await api('/api/me');
      state.user = me.user;
    } catch (_) { /* segue como visitante */ }
    renderWho();
    route();
    loadPolls();
    connectEvents();
    // Plano B caso a conexão em tempo real caia
    setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    // Celulares pausam a conexão com a aba em segundo plano: atualiza ao voltar
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  init();
})();
