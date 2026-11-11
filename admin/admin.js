(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { notifyPrize: true, prizes: [], prizeEditing: null, adminUsers: [], polls: [], topics: [], topicTab: null, users: 0, editing: null, mode: 'replace', streak: { every: 0, bonus: 0 }, notify: true, notifyResult: true, notifyClosing: true, hallVisible: true, lockVotes: false, chatEnabled: true, chatImages: true, chatVideos: true, chatEmbedLinks: true, hall: [], pushEnabled: true, house: [], houseEditing: null, achievements: [], achEditing: null };

  /* ---------- Utilidades ---------- */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v; // via CSSOM: a CSP não deixa o atributo style
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
    try { data = await res.json(); } catch (_) { /* sem corpo */ }
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
    toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  function handleError(e) {
    if (e.status === 401) {
      showLogin();
      return;
    }
    toast(e.message, true);
  }

  const fmtDate = (iso) =>
    new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------- Login ---------- */
  function showLogin() {
    $('#login').hidden = false;
    $('#panel').hidden = true;
    $('#logout').hidden = true;
    $('#whoami').hidden = true;
    $('#admin-pass').focus();
  }

  const ADMIN_TABS = ['create', 'polls', 'house', 'streak', 'ach', 'prizes', 'hall', 'users', 'chat', 'tests', 'admins', 'bot', 'log', 'backup'];

  // Nível de acesso de quem está logado (vem de /api/admin/me). O servidor confere tudo de novo; aqui só se esconde o que não vale.
  let me = { owner: false, permissions: [], name: '' };
  const can = (key) => me.owner || me.permissions.includes(key);

  // Somente leitura: o admin sem permissão vê tudo, mas os controles ficam travados (inclusive os que aparecem depois, nas listas)
  function lockEl(el) {
    el.classList.add('readonly');
    const run = () => el.querySelectorAll('button, input, select, textarea').forEach((c) => {
      if (!c.closest('[data-keep]')) c.disabled = true;
    });
    run();
    new MutationObserver(run).observe(el, { childList: true, subtree: true });
    if (el.id.startsWith('apane-') || el.id === 'form-panel') {
      el.prepend(h('p', { class: 'hint readonly-note' }, '👁️ Somente leitura: seu nível de admin não permite alterar aqui.'));
    }
  }

  function applyPerms() {
    // Abas de uso restrito (dono, testes, backup) ficam escondidas; o resto fica visível
    document.querySelectorAll('[data-perm]').forEach((el) => {
      const need = el.dataset.perm.split('|');
      el.hidden = !(need.includes('owner') ? me.owner : need.some(can));
    });
    document.querySelectorAll('[data-need]').forEach((el) => {
      if (!el.dataset.need.split('|').some(can)) lockEl(el);
    });
    $('#whoami').textContent = me.owner ? '👑 Dono' : `👤 ${me.name}`;
    $('#whoami').hidden = false;
  }

  function setAdminTab(tab) {
    if (!ADMIN_TABS.includes(tab) || $(`#atab-${tab}`).hidden) tab = 'polls';
    ADMIN_TABS.forEach((t) => {
      $(`#apane-${t}`).hidden = t !== tab;
      $(`#atab-${t}`).setAttribute('aria-selected', String(t === tab));
    });
    history.replaceState(null, '', tab === 'polls' ? location.pathname : `#${tab}`);
    // Estas abas carregam só quando abertas (a lista de usuários é a mais pesada)
    if (tab === 'prizes') loadPrizes();
    if (tab === 'users') loadUsers();
    if (tab === 'chat') loadChatAdmin();
    if (tab === 'tests') loadTests();
    if (tab === 'admins') loadAdmins();
    if (tab === 'log') loadLog(true);
    if (tab === 'bot') loadBot();
  }
  ADMIN_TABS.forEach((t) => $(`#atab-${t}`).addEventListener('click', () => setAdminTab(t)));

  function showPanel(info) {
    me = { owner: Boolean(info.owner), permissions: info.permissions || [], name: info.name || '' };
    applyPerms();
    applyFormPerms();
    $('#login').hidden = true;
    $('#panel').hidden = false;
    $('#logout').hidden = false;
    setAdminTab(location.hash.slice(1));
    loadPolls();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { name: $('#admin-name').value, password: $('#admin-pass').value } });
      $('#admin-pass').value = '';
      location.reload(); // recarrega já logado, com o nível de acesso novo e sem sobras de uma sessão anterior
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch (_) { /* segue */ }
    showLogin();
  });

  /* ---------- Lista de enquetes ---------- */
  async function loadPolls() {
    try {
      const data = await api('/api/admin/polls');
      state.polls = data.polls;
      state.topics = data.topics || [];
      state.users = data.users;
      state.mode = data.mode;
      state.streak = data.streak;
      state.notify = data.notify;
      state.notifyResult = data.notifyResult;
      state.notifyClosing = data.notifyClosing;
      state.hallVisible = data.hallVisible;
      state.lockVotes = data.lockVotes;
      $('#lock-votes').checked = state.lockVotes;
      state.chatEnabled = data.chatEnabled !== false;
      state.chatImages = data.chatImages !== false;
      state.chatVideos = data.chatVideos !== false;
      state.chatEmbedLinks = data.chatEmbedLinks !== false;
      const chatCb = $('#chat-enabled');
      if (chatCb) chatCb.checked = state.chatEnabled;
      const imgCb = $('#chat-images');
      if (imgCb) imgCb.checked = state.chatImages;
      const vidCb = $('#chat-videos');
      if (vidCb) vidCb.checked = state.chatVideos;
      const embCb = $('#chat-embed-links');
      if (embCb) embCb.checked = state.chatEmbedLinks;
      state.pushEnabled = data.pushEnabled;
      renderMode();
      renderNotify();
      renderStreak();
      renderTopics();
      renderList();
      loadHouse();
      loadAchievements();
      loadHall();
    } catch (e) {
      handleError(e);
    }
  }

  async function act(request, okMessage) {
    try {
      await request();
      toast(okMessage);
      await loadPolls();
    } catch (e) {
      handleError(e);
    }
  }

  function cancelPoll(p) {
    const extra = p.status === 'resolved' ? ' Os pontos que ela já deu ou tirou também são desfeitos.' : '';
    if (!confirm(`Cancelar "${p.title}"? Ninguém ganha nem perde pontos por ela e as apostas são devolvidas.${extra} Dá para reabrir depois.`)) return;
    act(() => api(`/api/admin/polls/${p.id}/cancel`, { method: 'POST' }), 'Enquete cancelada. Pontos devolvidos');
  }

  function statusText(p) {
    return { open: 'Aberta', closed: 'Encerrada', resolved: 'Resultado', cancelled: 'Cancelada' }[p.status];
  }

  function renderPoll(p) {
    const group = `ans-${p.id}`;
    const correct = p.options.find((o) => o.id === p.correctOptionId);

    const options = p.options.map((o) => h('label', { class: 'aopt' },
      h('input', { type: 'radio', name: group, value: o.id, checked: o.id === p.correctOptionId }),
      h('span', {}, o.text),
      h('span', { class: 'count' }, `${o.voters.length} ${o.voters.length === 1 ? 'voto' : 'votos'}`)));

    const meta = [
      p.optionPoints ? `🎯 pontos por opção${p.sumPoints ? ` + ${p.points} da enquete` : ''}: ${p.options.map((o) => `${o.text} (${o.points})`).join(' · ')}` : p.poolOdds ? `🎲 prêmio de ${p.points} pts dividido entre quem acertar${p.maxWin ? ` · ganho máx. +${p.maxWin}` : ''}` : p.odds ? `🎲 odd · ${p.pool} pts apostados${p.maxStake ? ` · aposta máx. ${p.maxStake}` : ''}${p.maxWin ? ` · ganho máx. +${p.maxWin}` : ''}` : `${p.points} ${p.points === 1 ? 'ponto' : 'pontos'} por acerto`,
      p.closesAt ? `encerra em ${fmtDate(p.closesAt)}` : 'sem prazo',
      `${p.totalVotes} ${p.totalVotes === 1 ? 'voto' : 'votos'}`,
    ].join(', ');

    const article = h('article', { class: 'panel apoll' },
      h('div', { class: 'apoll-head' }, h('h3', {}, p.title),
        h('span', { class: 'pills' },
          p.house ? h('span', { class: 'pill' }, '🏠 Casa') : null,
          p.odds || p.poolOdds || p.optionPoints ? h('span', { class: 'pill' }, p.optionPoints ? '🎯 Pontos por opção' : p.poolOdds ? '🎲 Prêmio dividido' : '🎲 Odd') : null,
          p.visible ? null : h('span', { class: 'pill' }, 'Fora da página'),
          h('span', { class: `pill ${p.status}` }, statusText(p)))),
      h('p', { class: 'meta' }, meta),
      p.description ? h('p', { class: 'desc' }, p.description) : null,
      p.houseWon
        ? h('p', { class: 'result house' }, `🏠 A casa ganhou: nenhuma opção bateu. +${p.points} pts pra cada conta da casa.`)
        : correct
          ? h('p', { class: 'result' }, p.optionPoints
            ? `Resposta certa: ${correct.text}. ${p.hits} de ${p.totalVotes} acertaram (+${correct.points + (p.sumPoints ? p.points : 0)} pts cada).`
            : p.poolOdds
            ? `Resposta certa: ${correct.text}. ${p.hits} de ${p.totalVotes} acertaram (+${p.hits ? Math.min(Math.floor(p.points / p.hits), p.maxWin || Infinity) : 0} pts cada).`
            : p.odds
            ? `Resposta certa: ${correct.text}. ${p.hits} de ${p.totalVotes} acertaram (odd ${(p.hits ? p.totalVotes / p.hits : 0).toFixed(2)}x).`
            : `Resposta certa: ${correct.text}. ${p.hits} de ${p.totalVotes} acertaram (+${p.points} pts cada).`)
          : null,
      h('fieldset', { disabled: !can('polls_resolve') }, h('legend', {}, 'Resposta certa'), options),
      h('details', { class: 'voters' },
        h('summary', {}, `Quem votou (${p.totalVotes})`),
        p.options.map((o) => h('p', {}, h('b', {}, `${o.text}: `), o.voters.length ? o.voters.join(', ') : 'ninguém'))),
      h('div', { class: 'actions' },
        can('polls_resolve') && h('button', { class: 'btn', type: 'button', onclick: () => confirmAnswer(p, article) },
          p.status === 'resolved' && !p.houseWon ? 'Atualizar resposta' : 'Confirmar resposta certa'),
        can('polls_resolve') && h('button', { class: 'btn ghost', type: 'button', onclick: () => confirmHouse(p) }, '🏠 A casa ganha'),
        !can('polls_resolve') ? null : p.status === 'open'
          ? h('button', { class: 'btn ghost', type: 'button', onclick: () => act(() => api(`/api/admin/polls/${p.id}/close`, { method: 'POST' }), 'Votação encerrada') }, 'Encerrar votação')
          : h('button', { class: 'btn ghost', type: 'button', onclick: () => reopen(p) }, 'Reabrir votação'),
        can('polls_resolve') && p.status !== 'cancelled' && h('button', { class: 'btn ghost', type: 'button', onclick: () => cancelPoll(p) }, 'Cancelar e devolver pontos'),
        can('polls_visibility') && h('button', { class: 'btn ghost', type: 'button', onclick: () => act(() => api(`/api/admin/polls/${p.id}/visibility`, { method: 'POST', body: { visible: !p.visible } }), p.visible ? 'Enquete ocultada da página' : 'Enquete de volta na página') },
          p.visible ? 'Ocultar da página' : 'Mostrar na página'),
        can('polls_edit') && h('button', { class: 'btn ghost', type: 'button', onclick: () => moveTopic(p) }, 'Mover de tópico'),
        (can('polls_edit') || can('polls_odds')) && h('button', { class: 'btn ghost', type: 'button', onclick: () => startEdit(p) }, 'Editar'),
        can('polls_delete') && h('button', { class: 'btn danger', type: 'button', onclick: () => remove(p) }, 'Excluir')));
    return article;
  }

  /* ---------- Tópicos ---------- */
  const firstTopicId = () => (state.topics[0] ? state.topics[0].id : null);
  // Enquete sem tópico válido cai no primeiro tópico
  const pollTopicId = (p) => (state.topics.some((t) => t.id === p.topicId) ? p.topicId : firstTopicId());
  const selectedTopicId = () => (state.topics.some((t) => t.id === state.topicTab) ? state.topicTab : firstTopicId());

  function renderTopics() {
    const sel = selectedTopicId();
    $('#topic-tabs').replaceChildren(...state.topics.map((t) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(t.id === sel),
      onclick: () => { state.topicTab = t.id; renderTopics(); renderList(); },
    }, `${t.name} (${state.polls.filter((p) => pollTopicId(p) === t.id).length})`)));

    $('#topic-list').replaceChildren(...state.topics.map((t) => h('div', { class: 'house-row' },
      h('span', { class: 'nm' }, `${t.name} · ${t.polls} ${t.polls === 1 ? 'enquete' : 'enquetes'}`),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => renameTopic(t) }, 'Renomear'),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => removeTopic(t) }, 'Excluir'))));
  }

  function renameTopic(t) {
    const name = prompt('Novo nome do tópico:', t.name);
    if (name === null || name.trim() === '' || name.trim() === t.name) return;
    act(() => api(`/api/admin/topics/${t.id}`, { method: 'PUT', body: { name } }), 'Tópico renomeado');
  }

  function removeTopic(t) {
    if (!confirm(`Excluir o tópico "${t.name}"? Só é possível se ele estiver sem enquetes.`)) return;
    act(() => api(`/api/admin/topics/${t.id}`, { method: 'DELETE' }), 'Tópico excluído');
  }

  $('#topic-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#topic-error').textContent = '';
    try {
      await api('/api/admin/topics', { method: 'POST', body: { name: $('#topic-name').value } });
      $('#topic-name').value = '';
      toast('Tópico criado');
      await loadPolls();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#topic-error').textContent = err.message;
    }
  });

  // Caixa "em qual tópico?", usada ao publicar e ao mover uma enquete
  const topicDialog = $('#topic-dialog');
  function askTopic(title, name, currentId, onPick) {
    $('#topic-dlg-title').textContent = title;
    $('#topic-dlg-name').textContent = name;
    $('#topic-dlg-choices').replaceChildren(...state.topics.map((t) => h('button', {
      class: 'btn', type: 'button', disabled: t.id === currentId,
      onclick: () => { topicDialog.close(); onPick(t); },
    }, t.id === currentId ? `${t.name} (atual)` : t.name)));
    topicDialog.showModal();
  }
  $('#topic-dlg-cancel').addEventListener('click', () => topicDialog.close());
  topicDialog.addEventListener('click', (e) => { if (e.target === topicDialog) topicDialog.close(); });

  function moveTopic(p) {
    askTopic('Mover para qual tópico?', p.title, pollTopicId(p), (t) =>
      act(() => api(`/api/admin/polls/${p.id}/topic`, { method: 'POST', body: { topicId: t.id } }), `Enquete movida para ${t.name}`));
  }

  function renderList() {
    const box = $('#poll-list');
    const sel = selectedTopicId();
    const topic = state.topics.find((t) => t.id === sel);
    const polls = state.polls.filter((p) => pollTopicId(p) === sel);
    $('#list-title').textContent = `${topic ? topic.name : 'Enquetes'}: ${polls.length} ${polls.length === 1 ? 'enquete' : 'enquetes'} · ${state.users} ${state.users === 1 ? 'participante' : 'participantes'}`;
    box.replaceChildren();
    if (!polls.length) {
      box.append(h('div', { class: 'empty' }, h('p', {}, 'Nenhuma enquete neste tópico. Use a aba ✏️ Criar para publicar uma.')));
      return;
    }
    polls.forEach((p) => box.append(renderPoll(p)));
  }

  function confirmAnswer(p, article) {
    const sel = article.querySelector('input[type="radio"]:checked');
    if (!sel) {
      toast('Escolha a resposta certa antes de confirmar.', true);
      return;
    }
    const text = p.options.find((o) => o.id === sel.value).text;
    if (p.house && state.house.length) {
      // Enquete com a opção Casa: antes de confirmar, escolhe quais contas da casa erram
      houseLoseTarget = { poll: p, optionId: sel.value };
      $('#house-lose-name').textContent = `${p.title} — resposta certa: ${text}`;
      $('#house-lose-options').replaceChildren(...state.house.map((acc) => h('label', { class: 'aopt' },
        h('input', { type: 'checkbox', name: 'house-lose', value: acc.id }),
        houseThumb(acc),
        h('span', {}, acc.name))));
      houseLoseDialog.showModal();
      return;
    }
    if (!confirm(`Confirmar "${text}" como resposta certa? Os pontos do ranking serão calculados agora.`)) return;
    act(() => api(`/api/admin/polls/${p.id}/resolve`, { method: 'POST', body: { optionId: sel.value } }), 'Resposta salva e ranking atualizado');
  }

  const houseLoseDialog = $('#house-lose-dialog');
  let houseLoseTarget = null;
  $('#house-lose-cancel').addEventListener('click', () => houseLoseDialog.close());
  houseLoseDialog.addEventListener('click', (e) => { if (e.target === houseLoseDialog) houseLoseDialog.close(); });
  $('#house-lose-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ids = [...$('#house-lose-options').querySelectorAll('input:checked')].map((i) => i.value);
    const { poll, optionId } = houseLoseTarget;
    houseLoseDialog.close();
    act(() => api(`/api/admin/polls/${poll.id}/resolve`, { method: 'POST', body: { optionId, houseLoseIds: ids } }),
      'Resposta salva e ranking atualizado');
  });

  const houseWinDialog = $('#house-win-dialog');
  let houseWinTarget = null;

  function confirmHouse(p) {
    if (!state.house.length) {
      toast('Cadastre pelo menos uma conta da casa antes de usar essa opção.', true);
      return;
    }
    houseWinTarget = p;
    $('#house-win-name').textContent = `${p.title} — ${p.points} pts`;
    $('#house-win-error').textContent = '';
    $('#house-win-options').replaceChildren(...state.house.map((acc, i) => h('label', { class: 'aopt' },
      h('input', { type: 'checkbox', name: 'house-win', value: acc.id, checked: i === 0 ? true : null }),
      houseThumb(acc),
      h('span', {}, acc.name))));
    houseWinDialog.showModal();
  }

  $('#house-win-cancel').addEventListener('click', () => houseWinDialog.close());
  houseWinDialog.addEventListener('click', (e) => { if (e.target === houseWinDialog) houseWinDialog.close(); });

  $('#house-win-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ids = [...$('#house-win-options').querySelectorAll('input:checked')].map((i) => i.value);
    if (!ids.length) {
      $('#house-win-error').textContent = 'Escolha pelo menos uma conta.';
      return;
    }
    const p = houseWinTarget;
    houseWinDialog.close();
    act(() => api(`/api/admin/polls/${p.id}/resolve`, { method: 'POST', body: { house: true, houseIds: ids } }),
      'A casa ganhou e o ranking foi atualizado');
  });

  // Diálogo "o que fazer com os pontos" — compartilhado entre reabrir e excluir
  const pointsDialog = $('#reopen-dialog');
  let pointsDialogTarget = null; // { poll, action: 'reopen' | 'delete' }

  function openPointsDialog(p, action) {
    pointsDialogTarget = { poll: p, action };
    $('#reopen-title').textContent = action === 'reopen' ? 'Reabrir votação' : 'Excluir enquete';
    $('#reopen-name').textContent = p.title;
    $('#reopen-desc').textContent =
      action === 'reopen'
        ? 'Esta enquete já tem resposta e soma pontos no ranking. O que fazer com esses pontos?'
        : 'Esta enquete já tem resposta e soma pontos no ranking. O que fazer com esses pontos antes de excluir?';
    $('#reopen-hint-keep').textContent =
      action === 'reopen'
        ? 'Os pontos continuam no ranking e os votos desta enquete são limpos, para valer como uma nova rodada.'
        : 'Os pontos já conquistados continuam no ranking, guardados. A enquete e os votos são apagados.';
    $('#reopen-hint-zero').textContent =
      action === 'reopen'
        ? 'Os pontos dela saem do ranking. Os votos são mantidos e os participantes podem trocá-los.'
        : 'Os pontos dela não entram no ranking. A enquete e os votos são apagados.';
    pointsDialog.showModal();
  }

  function doReopen(p, points) {
    act(() => api(`/api/admin/polls/${p.id}/reopen`, { method: 'POST', body: points ? { points } : undefined }), 'Votação reaberta');
  }

  function doRemove(p, points) {
    if (state.editing === p.id) resetForm();
    act(() => api(`/api/admin/polls/${p.id}`, { method: 'DELETE', body: points ? { points } : undefined }), 'Enquete excluída');
  }

  function reopen(p) {
    // Com resposta e pontos valendo no ranking: pergunta o que fazer com os pontos
    if (p.status === 'resolved' && p.counted) return openPointsDialog(p, 'reopen');
    if (!confirm(`Reabrir a votação de "${p.title}"?`)) return;
    doReopen(p);
  }

  function remove(p) {
    if (p.status === 'resolved' && p.counted) return openPointsDialog(p, 'delete');
    if (!confirm(`Excluir "${p.title}" e os votos dela? Como não tem resposta definida, ela não gera pontos. Isso não pode ser desfeito.`)) return;
    doRemove(p);
  }

  pointsDialog.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => {
    const target = pointsDialogTarget;
    pointsDialog.close();
    if (!target) return;
    const { poll, action } = target;
    if (action === 'reopen') doReopen(poll, b.dataset.choice);
    else doRemove(poll, b.dataset.choice);
  }));
  $('#reopen-cancel').addEventListener('click', () => pointsDialog.close());
  pointsDialog.addEventListener('click', (e) => { if (e.target === pointsDialog) pointsDialog.close(); });

  /* ---------- Formulário (criar e editar) ---------- */
  // Os tetos só aparecem quando a enquete é com odd
  function syncOddsLimits() {
    const on = $('#f-odds').checked;
    const pool = $('#f-odds-kind').value === 'pool';
    $('#f-odds-limits').hidden = !can('polls_odds') || !on;
    $('#f-max-stake-field').hidden = pool;
    const opt = $('#f-opt-points').checked;
    document.querySelector('label[for=f-points]').textContent = on && pool ? 'Prêmio total (dividido entre quem acertar)'
      : opt ? ($('#f-sum-points').checked ? 'Pontos da enquete (somados aos de cada opção)' : 'Pontos da casa (só valem se ninguém acertar)')
      : 'Pontos por acerto';
    $('#f-odds-kind-hint').textContent = pool
      ? 'Os pontos viram um prêmio único: cada acertador leva prêmio ÷ nº de acertadores (para baixo). Ninguém perde pontos.'
      : 'Aposta com pontos do ranking: acerto = aposta × odd; erro = perde a aposta. Se a casa ganhar, valem os “Pontos por acerto”.';
    $('#f-max-win-hint').textContent = pool
      ? 'Teto da parte de cada acertador. Vazio = sem teto.'
      : 'Teto do lucro de quem acertar. Vazio = sem teto.';
  }
  // Mostra só o que o nível do admin permite mexer: ao editar, os campos básicos pedem "editar enquetes" e a odd pede "definir odd"
  // "Pontos por opção" e "odd" são excludentes; ao editar, o tipo já não pode mudar
  function syncOptionMode() {
    const op = $('#f-opt-points').checked;
    $('#f-show-opt-points-field').hidden = !op;
    $('#f-sum-points-field').hidden = !op || !can('polls_odds');
    if (op) $('#f-odds').checked = false;
    $('#f-odds').disabled = op;
    $('#f-opt-points').disabled = Boolean(state.editing) || $('#f-odds').checked;
    $('#f-options').placeholder = op ? 'Uma por linha: Texto | pontos (ex.: Time A | 5)' : 'Uma opção por linha';
    if (!state.editing) $('#f-options-hint').textContent = op ? 'De 1 a 10 opções, uma por linha, no formato Texto | pontos.' : 'De 1 a 10 opções, uma por linha.';
  }
  $('#f-opt-points').addEventListener('change', () => { syncOptionMode(); syncOddsLimits(); });
  $('#f-sum-points').addEventListener('change', syncOddsLimits);
  $('#f-odds').addEventListener('change', () => { if ($('#f-odds').checked) $('#f-opt-points').checked = false; syncOptionMode(); });

  function applyFormPerms() {
    const lockBase = Boolean(state.editing) && !can('polls_edit');
    ['#f-title', '#f-desc', '#f-points', '#f-closes', '#f-house', '#f-show-opt-points'].forEach((s) => { $(s).disabled = lockBase; });
    $('#f-type-box').hidden = !can('polls_odds'); // a caixa do tipo de enquete só aparece para quem pode definir odd/pontos por opção
    $('#f-odds').closest('.field').hidden = !can('polls_odds');
    $('#f-opt-points').closest('.field').hidden = !can('polls_odds');
    syncOptionMode();
    $('#form-submit').disabled = !state.editing && !can('polls_create'); // sem permissão de criar, só edita
    syncOddsLimits();
  }
  $('#f-odds').addEventListener('change', syncOddsLimits);
  $('#f-odds-kind').addEventListener('change', syncOddsLimits);

  function resetForm() {
    state.editing = null;
    $('#poll-form').reset();
    $('#f-points').value = 10;
    $('#f-house').checked = false;
    $('#f-odds').checked = false;
    $('#f-opt-points').checked = false;
    $('#f-show-opt-points').checked = true;
    $('#f-sum-points').checked = false;
    $('#f-odds-kind').value = 'stake';
    $('#f-max-stake').value = '';
    $('#f-max-win').value = '';
    applyFormPerms();
    $('#f-options').disabled = false;
    $('#f-options-hint').textContent = 'De 1 a 10 opções, uma por linha.';
    $('#form-title').textContent = 'Nova enquete';
    $('#form-submit').textContent = 'Publicar enquete';
    $('#form-cancel').hidden = true;
    $('#form-error').textContent = '';
    $('#f-notify-field').hidden = false;
    renderNotify();
  }

  function startEdit(p) {
    setAdminTab('create'); // o formulário fica na aba Criar
    state.editing = p.id;
    $('#f-title').value = p.title;
    $('#f-desc').value = p.description || '';
    $('#f-options').value = p.options.map((o) => (p.optionPoints ? `${o.text} | ${o.points}` : o.text)).join('\n');
    $('#f-options').disabled = true;
    $('#f-options-hint').textContent = 'As opções não podem ser alteradas depois de publicar.';
    $('#f-points').value = p.points;
    $('#f-house').checked = Boolean(p.house);
    $('#f-odds').checked = Boolean(p.odds || p.poolOdds);
    $('#f-opt-points').checked = Boolean(p.optionPoints);
    $('#f-show-opt-points').checked = p.showOptionPoints !== false;
    $('#f-sum-points').checked = Boolean(p.sumPoints);
    $('#f-odds-kind').value = p.poolOdds ? 'pool' : 'stake';
    $('#f-max-stake').value = p.maxStake || '';
    $('#f-max-win').value = p.maxWin || '';
    applyFormPerms();
    $('#f-closes').value = toLocalInput(p.closesAt);
    $('#f-notify-field').hidden = true; // editar não envia notificação
    $('#form-title').textContent = 'Editar enquete';
    $('#form-submit').textContent = 'Salvar alterações';
    $('#form-cancel').hidden = false;
    $('#form-error').textContent = '';
    $('#form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#f-title').focus({ preventScroll: true });
  }

  $('#form-cancel').addEventListener('click', () => { resetForm(); setAdminTab('polls'); });

  async function saveForm(body, editing, topic) {
    const submit = $('#form-submit');
    submit.disabled = true;
    try {
      if (editing) {
        await api(`/api/admin/polls/${editing}`, { method: 'PUT', body });
        toast('Alterações salvas');
      } else {
        await api('/api/admin/polls', { method: 'POST', body: { ...body, topicId: topic.id } });
        const notified = body.notify && state.notify && state.pushEnabled;
        toast(`Enquete publicada em ${topic.name}${notified ? ' e inscritos avisados' : ' (sem notificação)'}`);
        state.topicTab = topic.id; // a aba Enquetes abre direto no tópico escolhido
      }
      resetForm();
      await loadPolls();
      if (editing) setAdminTab('polls');
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#form-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  }

  $('#poll-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#form-error').textContent = '';
    const closes = $('#f-closes').value;
    const body = {
      title: $('#f-title').value,
      description: $('#f-desc').value,
      points: $('#f-points').value,
      closesAt: closes ? new Date(closes).toISOString() : null,
      house: $('#f-house').checked,
      optionPoints: $('#f-opt-points').checked,
      showOptionPoints: $('#f-show-opt-points').checked,
      sumPoints: $('#f-opt-points').checked && $('#f-sum-points').checked,
      odds: $('#f-odds').checked && $('#f-odds-kind').value === 'stake',
      poolOdds: $('#f-odds').checked && $('#f-odds-kind').value === 'pool',
      maxStake: $('#f-max-stake').value,
      maxWin: $('#f-max-win').value,
    };
    const editing = state.editing;
    if (editing) {
      saveForm(body, editing, null);
      return;
    }
    body.options = $('#f-options').value.split('\n');
    body.notify = $('#f-notify').checked;
    if (!state.topics.length) {
      $('#form-error').textContent = 'Crie um tópico (aba Enquetes, Gerenciar tópicos) antes de publicar.';
      return;
    }
    // Com um só tópico não há o que perguntar; com mais de um, abre a caixa de escolha
    if (state.topics.length === 1) {
      saveForm(body, null, state.topics[0]);
      return;
    }
    askTopic('Em qual tópico publicar?', body.title, null, (topic) => saveForm(body, null, topic));
  });

  /* ---------- Prêmios únicos ---------- */
  function prizeIcon(p) {
    return p.imageUrl
      ? h('img', { class: 'ach-thumb', src: p.imageUrl, alt: '' })
      : h('span', { class: 'ach-thumb ph' }, p.emoji);
  }

  async function loadPrizes() {
    try {
      const data = await api('/api/admin/prizes');
      state.prizes = data.prizes;
      state.notifyPrize = data.notifyPrize;
      state.pushEnabled = data.pushEnabled;
      renderPrizeNotify();
      renderPrizes();
    } catch (e) {
      handleError(e);
    }
  }

  function renderPrizeNotify() {
    const el = $('#notify-prize');
    el.checked = state.notifyPrize;
    el.disabled = !state.pushEnabled;
    $('#notify-prize-hint').textContent = state.pushEnabled
      ? 'A notificação diz o nome de quem conquistou e o nome do prêmio.'
      : 'As notificações push não estão configuradas neste servidor (faltam as chaves VAPID).';
  }
  bindFlag('#notify-prize', 'notifyPrize', 'notifyPrize', 'Aviso de prêmio conquistado ligado', 'Aviso de prêmio conquistado desligado', renderPrizeNotify);

  function prizeStatusText(p) {
    if (p.status === 'held') {
      const who = `${p.holder.name}${p.holder.banned ? ' (banido)' : ''}`;
      return `Com ${who} desde ${new Date(p.holder.wonAt).toLocaleDateString('pt-BR')}`;
    }
    return p.status === 'open' ? 'Disponível: o primeiro a chegar leva' : 'Sem dono (liberar para voltar a disputar)';
  }

  function renderPrizes() {
    const box = $('#prize-list');
    box.replaceChildren();
    if (!state.prizes.length) {
      box.append(h('p', { class: 'hint' }, 'Nenhum prêmio criado ainda.'));
      return;
    }
    box.append(...state.prizes.map((p) => h('div', { class: 'house-row prize-row' },
      prizeIcon(p),
      h('span', { class: 'nm' },
        `${p.name} — ${p.points} pts`,
        h('small', { class: 'hint' }, prizeStatusText(p)),
        p.description ? h('small', { class: 'prize-desc' }, p.description) : null),
      p.status === 'held'
        ? h('button', { class: 'btn danger small', type: 'button', onclick: () => removePrizeHolder(p) }, 'Remover do dono')
        : null,
      p.status === 'vacant'
        ? h('button', { class: 'btn small', type: 'button', onclick: () => releasePrize(p) }, 'Liberar de novo')
        : null,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => startEditPrize(p) }, 'Editar'),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => deletePrize(p) }, 'Excluir'))));
  }

  function resetPrizeForm() {
    state.prizeEditing = null;
    $('#prize-form').reset();
    $('#prize-points').value = 500;
    $('#prize-desc').value = '';
    $('#prize-submit').textContent = 'Criar prêmio';
    $('#prize-cancel').hidden = true;
    $('#prize-error').textContent = '';
  }

  function startEditPrize(p) {
    state.prizeEditing = p.id;
    $('#prize-name').value = p.name;
    $('#prize-points').value = p.points;
    $('#prize-desc').value = p.description || '';
    $('#prize-emoji').value = p.emoji || '';
    $('#prize-image').value = p.imageUrl || '';
    $('#prize-submit').textContent = 'Salvar alterações';
    $('#prize-cancel').hidden = false;
    $('#prize-error').textContent = '';
    $('#prize-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#prize-name').focus({ preventScroll: true });
  }
  $('#prize-cancel').addEventListener('click', resetPrizeForm);

  $('#prize-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#prize-error').textContent = '';
    const body = {
      name: $('#prize-name').value,
      points: $('#prize-points').value,
      description: $('#prize-desc').value,
      emoji: $('#prize-emoji').value,
      imageUrl: $('#prize-image').value,
    };
    const editing = state.prizeEditing;
    const submit = $('#prize-submit');
    submit.disabled = true;
    try {
      if (editing) {
        await api(`/api/admin/prizes/${editing}`, { method: 'PUT', body });
        toast('Prêmio atualizado');
      } else {
        await api('/api/admin/prizes', { method: 'POST', body });
        toast('Prêmio criado');
      }
      resetPrizeForm();
      await loadPrizes();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#prize-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  async function prizeAction(request, okMessage) {
    try {
      const r = await request();
      toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
      await loadPrizes();
    } catch (e) {
      handleError(e);
    }
  }

  function removePrizeHolder(p) {
    if (!confirm(`Remover "${p.name}" de ${p.holder.name}? O prêmio fica sem dono até você liberar de novo, e ${p.holder.name} não poderá ganhá-lo de volta.`)) return;
    prizeAction(() => api(`/api/admin/prizes/${p.id}/remove`, { method: 'POST' }), 'Prêmio removido. Está sem dono.');
  }

  function releasePrize(p) {
    if (!confirm(`Liberar "${p.name}" de novo? Fica com quem chegou primeiro nos ${p.points} pontos (quem já perdeu o prêmio não conta). Se já houver gente acima disso, ele é entregue agora.`)) return;
    prizeAction(() => api(`/api/admin/prizes/${p.id}/release`, { method: 'POST' }),
      (r) => (r.holder ? `Prêmio liberado e entregue a ${r.holder}` : 'Prêmio liberado. Ninguém atingiu a pontuação ainda.'));
  }

  function deletePrize(p) {
    if (!confirm(`Excluir o prêmio "${p.name}"? ${p.status === 'held' ? `${p.holder.name} perde o prêmio. ` : ''}Isso não pode ser desfeito.`)) return;
    if (state.prizeEditing === p.id) resetPrizeForm();
    prizeAction(() => api(`/api/admin/prizes/${p.id}`, { method: 'DELETE' }), 'Prêmio excluído');
  }

  /* ---------- Usuários: pontos e banimento ---------- */
  async function loadUsers() {
    try {
      state.adminUsers = (await api('/api/admin/users')).users;
      renderUsers();
    } catch (e) {
      handleError(e);
    }
  }

  function userAvatar(u) {
    return u.avatar
      ? h('img', { class: 'ach-thumb', src: u.avatar, alt: '', referrerpolicy: 'no-referrer' })
      : h('span', { class: 'ach-thumb ph' }, (u.name || '?').slice(0, 1).toUpperCase());
  }

  function renderUsers() {
    const box = $('#user-list');
    const term = $('#user-search').value.trim().toLowerCase();
    const list = state.adminUsers.filter((u) => !term || u.name.toLowerCase().includes(term) || u.login.toLowerCase().includes(term));
    box.replaceChildren();
    if (!list.length) {
      box.append(h('p', { class: 'hint' }, state.adminUsers.length ? 'Ninguém encontrado.' : 'Nenhum participante ainda.'));
      return;
    }
    box.append(...list.map((u) => {
      const pts = u.banned
        ? 'Banido'
        : `${u.points} pts no geral · ${u.weeklyPoints} na semana${u.adjust ? ` · ajuste ${u.adjust > 0 ? '+' : ''}${u.adjust}` : ''}`;
      return h('div', { class: 'house-row', style: u.banned ? 'opacity: 0.6' : '' },
        userAvatar(u),
        h('span', { class: 'nm' }, `${u.name} (@${u.login})`, h('small', { class: 'hint' }, pts)),
        u.banned ? null : h('button', { class: 'btn ghost small', type: 'button', onclick: () => openAdjust(u) }, '± Pontos'),
        h('button', {
          class: u.banned ? 'btn small' : 'btn danger small', type: 'button', onclick: () => toggleBan(u),
        }, u.banned ? 'Desbanir' : 'Banir'));
    }));
  }
  $('#user-search').addEventListener('input', renderUsers);

  async function toggleBan(u) {
    const msg = u.banned
      ? `Desbanir ${u.name}? Ele volta a poder entrar e votar, e reaparece nos rankings com os pontos que tinha.`
      : `Banir ${u.name}? Ele é desconectado, não consegue mais entrar nem votar, e some dos rankings. Os votos ficam guardados.`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/admin/users/${u.id}/ban`, { method: 'POST', body: { banned: !u.banned } });
      toast(u.banned ? `${u.name} desbanido` : `${u.name} banido`);
      await loadUsers();
    } catch (e) {
      handleError(e);
    }
  }

  // Diálogo de ajuste de pontos
  const adjDialog = $('#adj-dialog');
  let adjUser = null;

  async function loadAdjustments() {
    const box = $('#adj-list');
    try {
      const { adjustments } = await api(`/api/admin/users/${adjUser.id}/adjustments`);
      box.replaceChildren();
      if (!adjustments.length) {
        box.append(h('p', { class: 'hint' }, 'Nenhum ajuste feito ainda.'));
        return;
      }
      box.append(...adjustments.map((a) => h('div', { class: 'house-row' },
        h('span', { class: 'nm' },
          `${a.delta > 0 ? '+' : ''}${a.delta} pts${a.note ? ` · ${a.note}` : ''}`,
          h('small', { class: 'hint' }, fmtDate(a.createdAt))),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => undoAdjustment(a) }, 'Desfazer'))));
    } catch (e) {
      box.replaceChildren(h('p', { class: 'hint' }, e.message));
    }
  }

  let adjSource = 'users'; // de onde o diálogo foi aberto: lista de usuários ou contas da casa
  const reloadAdjustSource = () => (adjSource === 'house' ? loadHouse() : loadUsers());
  const adjustSourceList = () => (adjSource === 'house' ? state.house : state.adminUsers);

  function openAdjust(u, source = 'users') {
    adjUser = u;
    adjSource = source;
    $('#adj-name').textContent = u.login ? `${u.name} (@${u.login})` : u.name;
    $('#adj-current').textContent = `Agora: ${u.points} pts no geral, ${u.weeklyPoints} na semana.`;
    $('#adj-amount').value = '';
    $('#adj-note').value = '';
    $('#adj-error').textContent = '';
    $('#adj-list').replaceChildren();
    adjDialog.showModal();
    loadAdjustments();
  }

  async function applyAdjust(sign) {
    const n = Number($('#adj-amount').value);
    if (!Number.isInteger(n) || n < 1 || n > 100000) {
      $('#adj-error').textContent = 'Digite um número inteiro entre 1 e 100000.';
      return;
    }
    $('#adj-error').textContent = '';
    try {
      await api(`/api/admin/users/${adjUser.id}/points`, { method: 'POST', body: { delta: sign * n, note: $('#adj-note').value } });
      toast(`${sign > 0 ? '+' : '-'}${n} pontos para ${adjUser.name}`);
      adjDialog.close();
      await reloadAdjustSource();
    } catch (e) {
      if (e.status === 401) { adjDialog.close(); handleError(e); } else $('#adj-error').textContent = e.message;
    }
  }
  $('#adj-add').addEventListener('click', () => applyAdjust(1));
  $('#adj-sub').addEventListener('click', () => applyAdjust(-1));
  $('#adj-close').addEventListener('click', () => adjDialog.close());
  adjDialog.addEventListener('click', (e) => { if (e.target === adjDialog) adjDialog.close(); });

  async function undoAdjustment(a) {
    if (!confirm(`Desfazer o ajuste de ${a.delta > 0 ? '+' : ''}${a.delta} pts? Conquistas e prêmios já ganhos com ele continuam com quem ganhou.`)) return;
    try {
      await api(`/api/admin/adjustments/${a.id}`, { method: 'DELETE' });
      toast('Ajuste desfeito');
      await reloadAdjustSource();
      const fresh = adjustSourceList().find((x) => x.id === adjUser.id);
      if (fresh) { adjUser = fresh; $('#adj-current').textContent = `Agora: ${fresh.points} pts no geral, ${fresh.weeklyPoints} na semana.`; }
      await loadAdjustments();
    } catch (e) {
      handleError(e);
    }
  }

  /* ---------- Notificações: chaves gerais e caixa por enquete ---------- */
  function renderNotify() {
    const off = !state.pushEnabled;
    for (const [id, key] of [['notify-global', 'notify'], ['notify-result', 'notifyResult'], ['notify-closing', 'notifyClosing']]) {
      const el = $(`#${id}`);
      el.checked = state[key];
      el.disabled = off;
    }
    $('#notify-global-hint').textContent = off
      ? 'As notificações push não estão configuradas neste servidor (faltam as chaves VAPID).'
      : 'Chave geral: desligada, nenhuma publicação envia notificação, mesmo com a caixa da enquete marcada.';
    const f = $('#f-notify');
    f.disabled = off || !state.notify;
    $('#f-notify-hint').textContent = off || !state.notify
      ? 'Desativado: as notificações de enquete nova estão desligadas na chave geral acima.'
      : 'Desmarque para publicar sem avisar ninguém.';
  }

  // Liga um checkbox a uma chave do servidor (salva na hora, sem botão)
  function bindFlag(selector, field, stateKey, onMsg, offMsg, after) {
    $(selector).addEventListener('change', async (e) => {
      const value = e.target.checked;
      try {
        await api('/api/admin/settings', { method: 'POST', body: { [field]: value } });
        state[stateKey] = value;
        toast(value ? onMsg : offMsg);
      } catch (err) {
        handleError(err);
      } finally {
        after();
      }
    });
  }
  bindFlag('#lock-votes', 'lockVotes', 'lockVotes', 'Trava de voto ligada: não dá mais para trocar o voto', 'Trava de voto desligada', () => {});
  bindFlag('#chat-enabled', 'chatEnabled', 'chatEnabled', 'Chat ligado no site principal', 'Chat desligado no site principal', () => {});
  bindFlag('#chat-images', 'chatImages', 'chatImages', 'Anexos de imagem ligados', 'Anexos de imagem desligados', () => {});
  bindFlag('#chat-videos', 'chatVideos', 'chatVideos', 'Anexos de vídeo ligados', 'Anexos de vídeo desligados', () => {});
  bindFlag('#chat-embed-links', 'chatEmbedLinks', 'chatEmbedLinks', 'Preview de links de imagem ligado', 'Preview de links de imagem desligado', () => {});

  /* ---------- Aba Chat (config + moderação) ---------- */
  const chatAdmin = { mutes: [], messages: [], loaded: false };

  function fmtChatWhen(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderChatMutes() {
    const box = $('#chat-mute-list');
    if (!box) return;
    box.replaceChildren();
    if (!chatAdmin.mutes.length) {
      box.append(h('p', { class: 'hint' }, 'Ninguém silenciado no momento.'));
      return;
    }
    box.append(...chatAdmin.mutes.map((m) => {
      const until = m.permanent
        ? 'Permanente'
        : (m.until ? `Até ${fmtChatWhen(m.until)}` : '');
      const reason = m.reason ? ` · ${m.reason}` : '';
      return h('div', { class: 'house-row' },
        m.avatar
          ? h('img', { class: 'ach-thumb', src: m.avatar, alt: '', referrerpolicy: 'no-referrer' })
          : h('span', { class: 'ach-thumb ph' }, (m.name || '?').slice(0, 1).toUpperCase()),
        h('span', { class: 'nm' },
          `${m.name} (@${m.login})`,
          h('small', { class: 'hint' }, `${until}${reason}`)
        ),
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => unmuteChatUser(m),
        }, 'Tirar silêncio')
      );
    }));
  }

  function renderChatMessages() {
    const box = $('#chat-msg-list');
    if (!box) return;
    box.replaceChildren();
    if (!chatAdmin.messages.length) {
      box.append(h('p', { class: 'hint' }, 'Nenhuma mensagem ainda.'));
      return;
    }
    box.append(...chatAdmin.messages.map((m) => {
      const u = m.user || {};
      const body = m.deleted
        ? h('small', { class: 'hint' }, 'Mensagem removida pela moderação')
        : h('span', {}, m.body || '');
      const mediaEl = (!m.deleted && m.media && m.media.url)
        ? (m.media.type === 'video'
            ? h('video', { class: 'chat-admin-media', src: m.media.url, controls: true, preload: 'metadata' })
            : h('a', { href: m.media.url, target: '_blank', rel: 'noopener noreferrer' },
                h('img', { class: 'chat-admin-media', src: m.media.url, alt: 'anexo' })))
        : null;
      return h('div', { class: 'house-row', style: m.deleted ? 'opacity:0.65' : '' },
        u.avatar
          ? h('img', { class: 'ach-thumb', src: u.avatar, alt: '', referrerpolicy: 'no-referrer' })
          : h('span', { class: 'ach-thumb ph' }, (u.name || '?').slice(0, 1).toUpperCase()),
        h('span', { class: 'nm' },
          `${u.name || 'Alguém'}`,
          h('small', { class: 'hint' }, fmtChatWhen(m.createdAt)),
          h('div', { style: 'font-weight:500;margin-top:0.15rem;word-break:break-word' }, body),
          mediaEl
        ),
        h('div', { style: 'display:flex;flex-direction:column;gap:0.3rem' },
          m.deleted
            ? h('button', {
                class: 'btn danger small', type: 'button',
                onclick: () => purgeChatAdminMsg(m),
              }, 'Remover do banco')
            : h('button', {
                class: 'btn danger small', type: 'button',
                onclick: () => deleteChatAdminMsg(m),
              }, 'Apagar'),
          (!m.deleted && u.id) ? h('button', {
            class: 'btn ghost small', type: 'button',
            onclick: () => muteChatUser(u),
          }, 'Silenciar') : null
        )
      );
    }));
  }

  async function loadChatAdmin() {
    const cb = $('#chat-enabled');
    if (cb) cb.checked = state.chatEnabled !== false;
    const imgCb = $('#chat-images');
    if (imgCb) imgCb.checked = state.chatImages !== false;
    const vidCb = $('#chat-videos');
    if (vidCb) vidCb.checked = state.chatVideos !== false;
    const embCb = $('#chat-embed-links');
    if (embCb) embCb.checked = state.chatEmbedLinks !== false;
    // Config (toggle) pode ser lida por quem tem settings; moderação exige chat
    if (can('chat') || me.owner) {
      try {
        const [mutesRes, msgsRes] = await Promise.all([
          api('/api/admin/chat/mutes'),
          api('/api/admin/chat/messages'),
        ]);
        chatAdmin.mutes = mutesRes.mutes || [];
        chatAdmin.messages = msgsRes.messages || [];
        chatAdmin.loaded = true;
        renderChatMutes();
        renderChatMessages();
      } catch (e) {
        handleError(e);
      }
    } else {
      const muteBox = $('#chat-mute-list');
      const msgBox = $('#chat-msg-list');
      if (muteBox) muteBox.replaceChildren(h('p', { class: 'hint' }, 'Seu nível não permite moderar o chat.'));
      if (msgBox) msgBox.replaceChildren();
    }
  }

  async function deleteChatAdminMsg(m) {
    if (!confirm('Apagar esta mensagem do chat?')) return;
    try {
      await api(`/api/admin/chat/${m.id}`, { method: 'DELETE' });
      toast('Mensagem apagada');
      m.deleted = true;
      renderChatMessages();
    } catch (e) {
      handleError(e);
    }
  }

  async function purgeChatAdminMsg(m) {
    if (!confirm('Remover esta mensagem do banco de forma permanente?')) return;
    try {
      await api(`/api/admin/chat/${m.id}/purge`, { method: 'DELETE' });
      toast('Mensagem removida do banco');
      chatAdmin.messages = chatAdmin.messages.filter((x) => x.id !== m.id);
      renderChatMessages();
    } catch (e) {
      handleError(e);
    }
  }

  async function purgeAllDeletedChat() {
    if (!confirm('Remover do banco TODAS as mensagens já apagadas? Isso não dá para desfazer.')) return;
    try {
      const r = await api('/api/admin/chat/purge-deleted', { method: 'POST' });
      toast(`${r.removed || 0} mensagem(ns) removida(s) do banco`);
      await loadChatAdmin();
    } catch (e) {
      handleError(e);
    }
  }

  async function unmuteChatUser(m) {
    if (!confirm(`Tirar o silêncio de ${m.name}?`)) return;
    try {
      await api(`/api/admin/chat/mute/${m.userId}`, { method: 'DELETE' });
      toast(`${m.name} pode voltar a escrever`);
      chatAdmin.mutes = chatAdmin.mutes.filter((x) => x.userId !== m.userId);
      renderChatMutes();
    } catch (e) {
      handleError(e);
    }
  }

  async function muteChatUser(u) {
    const duration = prompt(
      `Silenciar ${u.name}?\nDigite a duração: 1h, 24h ou permanente`,
      '24h'
    );
    if (duration == null) return;
    const raw = String(duration).trim().toLowerCase();
    let d = 'permanent';
    if (raw === '1h' || raw === '1') d = '1h';
    else if (raw === '24h' || raw === '24') d = '24h';
    else if (raw === 'permanente' || raw === 'permanent' || raw === 'p') d = 'permanent';
    else {
      toast('Duração inválida. Use 1h, 24h ou permanente.', true);
      return;
    }
    const reason = prompt('Motivo (opcional):', '') || '';
    try {
      await api('/api/admin/chat/mute', {
        method: 'POST',
        body: { userId: u.id, duration: d, reason: reason.trim() || undefined },
      });
      toast(`${u.name} silenciado`);
      await loadChatAdmin();
    } catch (e) {
      handleError(e);
    }
  }

  const chatRefreshBtn = $('#chat-refresh');
  if (chatRefreshBtn) chatRefreshBtn.addEventListener('click', () => loadChatAdmin());
  const chatPurgeBtn = $('#chat-purge-deleted');
  if (chatPurgeBtn) chatPurgeBtn.addEventListener('click', () => purgeAllDeletedChat());

  bindFlag('#notify-global', 'notify', 'notify', 'Notificações de enquete nova ligadas', 'Notificações de enquete nova desligadas', renderNotify);
  bindFlag('#notify-result', 'notifyResult', 'notifyResult', 'Aviso de resultado ligado', 'Aviso de resultado desligado', renderNotify);
  bindFlag('#notify-closing', 'notifyClosing', 'notifyClosing', 'Lembrete de enquete fechando ligado', 'Lembrete de enquete fechando desligado', renderNotify);

  /* ---------- Admins e níveis de acesso (só o dono) ---------- */
  const adm = { list: [], catalog: [], editing: null };
  const PRESETS = [
    ['Editor de enquetes', ['polls_create', 'polls_edit', 'polls_visibility', 'topics']],
    ['Moderador', ['polls_resolve', 'polls_visibility', 'users', 'chat']],
    ['Todas as permissões', 'all'],
    ['Nenhuma', []],
  ];

  function setAdmPerms(keys) {
    document.querySelectorAll('#adm-perms input[type=checkbox]').forEach((c) => { c.checked = keys.includes(c.value); });
  }
  const getAdmPerms = () => [...document.querySelectorAll('#adm-perms input[type=checkbox]:checked')].map((c) => c.value);

  function renderAdminForm() {
    const groups = [...new Set(adm.catalog.map((c) => c.group))];
    $('#adm-perms').replaceChildren(...groups.map((g) => h('fieldset', { class: 'modes' },
      h('legend', {}, g),
      adm.catalog.filter((c) => c.group === g).map((c) => h('label', { class: 'aopt' },
        h('input', { type: 'checkbox', value: c.key }), h('span', {}, c.label))))));
    $('#adm-presets').replaceChildren(...PRESETS.map(([label, keys]) => h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: () => setAdmPerms(keys === 'all' ? adm.catalog.map((c) => c.key) : keys),
    }, label)));
  }

  function resetAdminForm() {
    adm.editing = null;
    $('#admin-form').reset();
    $('#admin-form-title').textContent = 'Novo admin';
    $('#adm-pass-label').textContent = 'Senha (mínimo 8 caracteres)';
    $('#adm-pass').required = true;
    $('#adm-save').textContent = 'Criar admin';
    $('#adm-cancel').hidden = true;
    $('#adm-error').textContent = '';
    setAdmPerms([]);
  }

  function renderAdmins() {
    const box = $('#admin-list');
    if (!adm.list.length) { box.replaceChildren(h('p', { class: 'hint' }, 'Nenhum admin além de você ainda.')); return; }
    const label = new Map(adm.catalog.map((c) => [c.key, c.label]));
    box.replaceChildren(...adm.list.map((a) => h('div', { class: 'house-row' },
      h('span', { class: 'nm', title: a.permissions.map((k) => label.get(k) || k).join('\n') },
        h('b', {}, a.name), ` · ${a.permissions.length} de ${adm.catalog.length} permissões`),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => editAdmin(a) }, 'Editar'),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => removeAdmin(a) }, 'Excluir'))));
  }

  function editAdmin(a) {
    adm.editing = a.id;
    $('#adm-name').value = a.name;
    $('#adm-pass').value = '';
    $('#adm-pass').required = false;
    $('#adm-pass-label').textContent = 'Nova senha (deixe em branco para manter a atual)';
    $('#admin-form-title').textContent = `Editar ${a.name}`;
    $('#adm-save').textContent = 'Salvar';
    $('#adm-cancel').hidden = false;
    $('#adm-error').textContent = '';
    setAdmPerms(a.permissions);
    $('#admin-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function removeAdmin(a) {
    if (!confirm(`Excluir o admin "${a.name}"? Ele perde o acesso na hora.`)) return;
    await act(() => api(`/api/admin/admins/${a.id}`, { method: 'DELETE' }), 'Admin excluído');
    if (adm.editing === a.id) resetAdminForm();
    loadAdmins();
  }

  async function loadAdmins() {
    try {
      const data = await api('/api/admin/admins');
      adm.list = data.admins;
      if (!adm.catalog.length) { adm.catalog = data.catalog; renderAdminForm(); resetAdminForm(); }
      renderAdmins();
    } catch (e) {
      handleError(e);
    }
  }

  $('#admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#adm-error').textContent = '';
    const body = { name: $('#adm-name').value, permissions: getAdmPerms() };
    if ($('#adm-pass').value) body.password = $('#adm-pass').value;
    try {
      if (adm.editing) await api(`/api/admin/admins/${adm.editing}`, { method: 'PUT', body });
      else await api('/api/admin/admins', { method: 'POST', body });
      toast(adm.editing ? 'Admin atualizado' : 'Admin criado');
      resetAdminForm();
      loadAdmins();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#adm-error').textContent = err.message;
    }
  });
  $('#adm-cancel').addEventListener('click', resetAdminForm);

  /* ---------- Bot da Twitch ---------- */
  const BOT_EVENTS = [
    ['created', 'Enquete criada'],
    ['result', 'Resultado da enquete'],
    ['prize', 'Prêmio conquistado (marca o ganhador)'],
  ];
  const botState = { data: null };

  function renderBot() {
    const d = botState.data;
    const box = $('#bot-status');
    const rows = [];
    if (!d.twitchConfigured) {
      rows.push(h('p', { class: 'error' }, 'Faltam BOT_TWITCH_CLIENT_ID e BOT_TWITCH_CLIENT_SECRET no servidor.'));
    }
    rows.push(h('div', { class: 'house-row' },
      h('span', { class: 'nm' }, d.connected ? h('span', {}, '✅ Conta do bot conectada: ', h('b', {}, d.botLogin)) : '⚠️ Nenhuma conta de bot conectada'),
      can('bot') && d.twitchConfigured ? h('a', { class: 'btn ghost small', href: '/api/admin/bot/connect' }, d.connected ? 'Trocar conta' : 'Conectar conta do bot') : null,
      can('bot') && d.connected ? h('button', { class: 'btn danger small', type: 'button', onclick: disconnectBot }, 'Desconectar') : null));
    rows.push(h('p', { class: 'hint' }, d.ownApp
      ? '🔑 O bot usa o app da Twitch próprio (BOT_TWITCH_*).'
      : 'O bot usa as mesmas credenciais do login. Para outro app, defina BOT_TWITCH_CLIENT_ID e BOT_TWITCH_CLIENT_SECRET.'));
    // Resultado da última tentativa de conectar (fica na tela, com o motivo)
    const [cr, ...crRest] = String(d.connectResult || '').split('|');
    const crDetail = crRest.join('|');
    const crMsg = {
      'conta-login': `A conta "${crDetail}" já participa do site. Use a conta do bot (janela anônima ou saia da Twitch).`,
      'conta-canal': `A conta "${crDetail}" é a dona do canal. Use uma conta separada.`,
      erro: `Não deu para conectar: ${crDetail || 'erro desconhecido'}. Confira o Client ID/Secret e a URL de redirecionamento do app.`,
      cancelado: 'A autorização foi cancelada.',
    }[cr];
    if (crMsg) rows.push(h('p', { class: 'error' }, `⚠️ Última tentativa de conectar: ${crMsg}`));
    if (d.conflict) {
      rows.push(h('p', { class: 'error' }, d.conflict === 'canal'
        ? '⚠️ A conta do bot é a dona do canal. Use uma conta separada.'
        : '⚠️ A conta do bot também participa do site. Use uma conta separada.'));
    }
    rows.push(h('p', { class: 'hint' }, 'Use uma conta diferente da sua. Para autorizar com ela, abra numa janela anônima (a Twitch usa a conta aberta no navegador). Cadastre esta URL em “OAuth Redirect URLs” do app do bot: ', h('code', {}, d.redirectUri)));
    box.replaceChildren(...rows);

    $('#bot-enabled').checked = d.enabled;
    $('#bot-channel').value = d.channel;
    $('#bot-events').replaceChildren(...BOT_EVENTS.map(([k, label]) => h('fieldset', { class: 'modes' },
      h('legend', {}, label),
      h('label', { class: 'aopt' }, h('input', { type: 'checkbox', id: `bot-on-${k}`, checked: d.on[k] }), h('span', {}, 'Avisar no chat')),
      h('textarea', { id: `bot-tpl-${k}`, rows: 2, maxlength: 300, class: 'bot-tpl' }, d.tpl[k]),
      h('span', { class: 'hint' }, `Variáveis: ${d.placeholders[k].map((v) => `{${v}}`).join(' ')}`),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => { $(`#bot-tpl-${k}`).value = d.defaults[k]; } }, 'Restaurar padrão')))));
    $('#bot-last').textContent = d.lastError
      ? `Último erro: ${d.lastError}`
      : (d.lastSent ? `Última mensagem enviada: ${fmtDate(d.lastSent)}` : '');
  }

  async function loadBot() {
    try {
      botState.data = await api('/api/admin/bot');
      renderBot();
    } catch (e) {
      handleError(e);
    }
  }

  async function disconnectBot() {
    if (!confirm('Desconectar a conta do bot? Ele para de escrever no chat até você conectar de novo.')) return;
    await act(() => api('/api/admin/bot/disconnect', { method: 'POST' }), 'Bot desconectado');
    loadBot();
  }

  $('#bot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#bot-error').textContent = '';
    const body = { enabled: $('#bot-enabled').checked, channel: $('#bot-channel').value, on: {}, tpl: {} };
    BOT_EVENTS.forEach(([k]) => { body.on[k] = $(`#bot-on-${k}`).checked; body.tpl[k] = $(`#bot-tpl-${k}`).value; });
    try {
      await api('/api/admin/bot/config', { method: 'POST', body });
      toast('Configuração do bot salva');
      loadBot();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#bot-error').textContent = err.message;
    }
  });
  $('#bot-test').addEventListener('click', async () => {
    $('#bot-error').textContent = '';
    try {
      await api('/api/admin/bot/test', { method: 'POST' });
      toast('Mensagem de teste enviada');
      loadBot();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#bot-error').textContent = err.message;
    }
  });

  /* ---------- Histórico de ações (só o dono) ---------- */
  const logState = { last: null };

  async function loadLog(reset) {
    if (reset) { logState.last = null; $('#log-list').replaceChildren(); }
    try {
      const qs = new URLSearchParams();
      if ($('#log-filter').value) qs.set('admin', $('#log-filter').value);
      if (logState.last) qs.set('before', logState.last);
      const data = await api(`/api/admin/log?${qs}`);
      const sel = $('#log-filter');
      const current = sel.value;
      sel.replaceChildren(h('option', { value: '' }, 'Todos'), ...data.names.map((n) => h('option', { value: n }, n)));
      sel.value = data.names.includes(current) ? current : '';
      $('#log-list').append(...data.entries.map((e) => h('div', { class: 'house-row' },
        h('span', { class: 'nm' },
          h('b', {}, e.action), e.detail ? ` · ${e.detail}` : '',
          h('br'), h('small', {}, `${e.admin === 'Dono' ? '👑 Dono' : `👤 ${e.admin}`} · ${fmtDate(e.at)}`)))));
      if (!$('#log-list').children.length) $('#log-list').append(h('p', { class: 'hint' }, 'Nenhuma ação registrada ainda.'));
      if (data.entries.length) logState.last = data.entries[data.entries.length - 1].id;
      $('#log-more').hidden = !data.hasMore;
    } catch (e) {
      handleError(e);
    }
  }
  $('#log-filter').addEventListener('change', () => loadLog(true));
  $('#log-more').addEventListener('click', () => loadLog(false));

  /* ---------- Painel de testes ---------- */
  const tests = { users: [] };

  function openPolls() {
    return state.polls.filter((p) => p.status === 'open' && p.visible);
  }

  function fillTestSelects() {
    const polls = openPolls();
    const pollSel = $('#test-poll');
    const keep = pollSel.value;
    pollSel.replaceChildren(...polls.map((p) => h('option', { value: p.id }, `${p.odds ? '🎲 ' : ''}${p.title}`)));
    if (polls.some((p) => p.id === keep)) pollSel.value = keep;
    const p = polls.find((x) => x.id === pollSel.value);
    $('#test-option').replaceChildren(...(p ? p.options.map((o) => h('option', { value: o.id }, o.text)) : []));
    $('#test-stake-field').hidden = !(p && p.odds);
    const accSel = $('#test-account');
    const keepAcc = accSel.value;
    accSel.replaceChildren(...tests.users.map((u) => h('option', { value: u.id }, `${u.name} (${u.points} pts)`)));
    if (tests.users.some((u) => u.id === keepAcc)) accSel.value = keepAcc;
  }

  function renderTests() {
    const box = $('#test-list');
    box.replaceChildren();
    if (!tests.users.length) box.append(h('p', { class: 'hint' }, 'Nenhuma conta de teste ainda.'));
    else {
      box.append(...tests.users.map((u) => h('div', { class: 'house-row' },
        h('span', {}, h('b', {}, u.name), ` · ${u.points} pts${u.locked ? ` (${u.locked} apostados)` : ''}`),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => testAct(() => api(`/api/admin/test-users/${u.id}/points`, { method: 'POST', body: { delta: 100 } }), '+100 pontos') }, '+100'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => testAct(() => api(`/api/admin/test-users/${u.id}/points`, { method: 'POST', body: { delta: -100 } }), '−100 pontos') }, '−100'))));
    }
    fillTestSelects();
  }

  function showTestsLock(configured = true) {
    $('#tests-lock').hidden = false;
    $('#tests-body').hidden = true;
    $('#tests-lock-error').textContent = configured ? '' : 'TESTS_PASSWORD não está configurada no servidor: a aba fica trancada.';
  }

  async function loadTests() {
    try {
      const st = await api('/api/admin/tests/status');
      if (!st.unlocked) { showTestsLock(st.configured); return; }
      $('#tests-lock').hidden = true;
      $('#tests-body').hidden = false;
      const data = await api('/api/admin/test-users');
      tests.users = data.users;
      renderTests();
    } catch (e) {
      if (e.status === 423) showTestsLock();
      else handleError(e);
    }
  }

  $('#tests-lock').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#tests-lock-error').textContent = '';
    try {
      await api('/api/admin/tests/unlock', { method: 'POST', body: { password: $('#tests-pass').value } });
      $('#tests-pass').value = '';
      loadTests();
    } catch (err) {
      if (err.status === 401 && /admin/i.test(err.message)) handleError(err);
      else $('#tests-lock-error').textContent = err.message;
    }
  });
  $('#tests-relock').addEventListener('click', async () => {
    try { await api('/api/admin/tests/lock', { method: 'POST' }); } catch (_) { /* segue */ }
    showTestsLock();
  });

  async function testAct(request, okMessage) {
    $('#test-error').textContent = '';
    try {
      const r = await request();
      toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
      await loadPolls();
      await loadTests();
    } catch (e) {
      if (e.status === 401) handleError(e);
      else if (e.status === 423) showTestsLock();
      else $('#test-error').textContent = e.message;
    }
  }

  $('#test-poll').addEventListener('change', fillTestSelects);
  $('#test-create').addEventListener('click', () => testAct(
    () => api('/api/admin/test-users', { method: 'POST', body: { count: Number($('#test-count').value), startPoints: Number($('#test-start').value) } }),
    'Contas de teste criadas'));
  $('#test-vote').addEventListener('click', () => {
    const id = $('#test-account').value;
    if (!id) { $('#test-error').textContent = 'Crie uma conta de teste primeiro.'; return; }
    testAct(() => api(`/api/admin/test-users/${id}/vote`, {
      method: 'POST',
      body: { pollId: $('#test-poll').value, optionId: $('#test-option').value, stake: Number($('#test-stake').value) },
    }), 'Voto registrado');
  });
  $('#test-random').addEventListener('click', () => testAct(
    () => api('/api/admin/test-users/random-votes', { method: 'POST', body: { pollId: $('#test-poll').value } }),
    (r) => `${r.done} votaram${r.skipped ? `, ${r.skipped} sem saldo` : ''}`));
  $('#test-clear').addEventListener('click', () => {
    if (!confirm('Apagar todas as contas de teste e tudo que elas votaram, apostaram ou ganharam?')) return;
    testAct(() => api('/api/admin/test-users', { method: 'DELETE' }), (r) => `${r.removed} contas apagadas`);
  });

  /* ---------- Hall da fama ---------- */
  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const dayBR = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  async function loadHall() {
    try {
      const data = await api('/api/admin/hall');
      state.hall = data.weeks;
      state.hallVisible = data.visible;
      renderHall();
    } catch (e) {
      handleError(e);
    }
  }

  function renderHall() {
    $('#hall-visible').checked = state.hallVisible;
    const box = $('#hall-list');
    box.replaceChildren();
    if (!state.hall.length) {
      box.append(h('p', { class: 'hint' }, 'Nenhuma semana registrada ainda. O primeiro pódio é gravado quando você zerar o ranking semanal.'));
      return;
    }
    box.append(...state.hall.map((w) => {
      const range = w.startedAt > '1970-01-02' ? `${dayBR(w.startedAt)} a ${dayBR(w.endedAt)}` : `Até ${dayBR(w.endedAt)}`;
      const podium = w.places.map((p) => `${medal[p.place]} ${p.name} (${p.points})`).join(' · ');
      return h('div', { class: 'house-row' },
        h('span', { class: 'nm' }, `${range} — ${podium}`),
        h('button', { class: 'btn danger small', type: 'button', onclick: () => removeHallWeek(w, range) }, 'Excluir'));
    }));
  }

  function removeHallWeek(w, range) {
    if (!confirm(`Excluir a semana ${range} do Hall da fama? Quem ganhou título nela perde a contagem, mas emblemas já desbloqueados continuam com a pessoa (apague o nível em Conquistas para removê-los).`)) return;
    act(() => api(`/api/admin/hall/${w.id}`, { method: 'DELETE' }), 'Semana removida do Hall da fama');
  }

  bindFlag('#hall-visible', 'hallVisible', 'hallVisible', 'Hall da fama visível para os participantes', 'Hall da fama escondido dos participantes', renderHall);

  /* ---------- Modo substituir/acumular e zerar ranking ---------- */
  function renderMode() {
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === state.mode; });
  }

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', async () => {
    try {
      await api('/api/admin/settings', { method: 'POST', body: { mode: r.value } });
      state.mode = r.value;
      toast(r.value === 'replace' ? 'Nova enquete vai substituir a da página' : 'Novas enquetes vão se acumular na página');
    } catch (e) {
      renderMode();
      handleError(e);
    }
  }));

  // Quem seria o campeão se zerasse agora (mesma regra do servidor: sem conta da casa, só quem pontuou)
  async function weeklyPreview() {
    try {
      const wk = await api('/api/ranking/weekly');
      const eligible = wk.ranking.filter((r) => !r.isHouse && r.points > 0);
      if (!eligible.length) return 'Ninguém pontuou nesta semana, então nenhum campeão será registrado no Hall da fama.';
      const best = eligible.filter((r) => r.points === eligible[0].points && r.hits === eligible[0].hits);
      return `Campeão desta semana: ${best.map((r) => r.name).join(' e ')} (${best[0].points} pts). O pódio será gravado no Hall da fama.`;
    } catch (_) {
      return 'O pódio da semana será gravado no Hall da fama.';
    }
  }

  async function resetRanking(path, doneMsg) {
    try {
      const r = await api(path, { method: 'POST' });
      toast(r.podium && r.podium.length ? `${doneMsg} Pódio gravado no Hall da fama.` : `${doneMsg} Ninguém pontuou, então nada foi gravado no hall.`);
      await loadPolls();
    } catch (e) {
      handleError(e);
    }
  }

  $('#reset-weekly').addEventListener('click', async () => {
    const preview = await weeklyPreview();
    if (!confirm(`Zerar o ranking semanal?\n\n${preview}\n\nOs pontos desta semana voltam pra 0, mas o ranking geral continua igual.`)) return;
    resetRanking('/api/admin/ranking/reset-weekly', 'Ranking semanal zerado.');
  });

  $('#reset-general').addEventListener('click', async () => {
    const preview = await weeklyPreview();
    if (!confirm(`Zerar o ranking geral?\n\n${preview}\n\nIsso também zera o semanal junto. Os emblemas já conquistados continuam com quem tem, mas os pontos de todo mundo voltam pra 0. Considere baixar um backup antes.`)) return;
    resetRanking('/api/admin/ranking/reset-general', 'Ranking geral zerado.');
  });

  /* ---------- Bônus de sequência ---------- */
  function renderStreak() {
    $('#s-every').value = state.streak.every;
    $('#s-bonus').value = state.streak.bonus;
  }

  $('#streak-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#streak-error').textContent = '';
    try {
      await api('/api/admin/settings', {
        method: 'POST',
        body: { streakEvery: $('#s-every').value, streakBonus: $('#s-bonus').value },
      });
      const on = Number($('#s-every').value) > 0 && Number($('#s-bonus').value) > 0;
      state.streak = { every: Number($('#s-every').value), bonus: Number($('#s-bonus').value) };
      toast(on ? 'Bônus de sequência salvo' : 'Bônus de sequência desativado');
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#streak-error').textContent = err.message;
    }
  });

  /* ---------- Contas da casa ---------- */
  async function loadHouse() {
    try {
      const { accounts } = await api('/api/admin/house-accounts');
      state.house = accounts;
      renderHouse();
    } catch (e) {
      handleError(e);
    }
  }

  function houseThumb(acc) {
    return acc.avatarUrl
      ? h('img', { class: 'ach-thumb', src: acc.avatarUrl, alt: '' })
      : h('span', { class: 'ach-thumb ph' }, '🏠');
  }

  function renderHouse() {
    const box = $('#house-list');
    box.replaceChildren();
    if (!state.house.length) {
      box.append(h('p', { class: 'hint' }, 'Nenhuma conta da casa ainda.'));
      return;
    }
    box.append(...state.house.map((acc) => h('div', { class: 'house-row' },
      houseThumb(acc),
      h('span', { class: 'nm' }, acc.name,
        h('small', { class: 'hint' },
          `${acc.points} pts no geral · ${acc.weeklyPoints} na semana${acc.adjust ? ` · ajuste ${acc.adjust > 0 ? '+' : ''}${acc.adjust}` : ''}`)),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => openAdjust(acc, 'house') }, '± Pontos'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => startEditHouse(acc) }, 'Editar'),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => removeHouse(acc) }, 'Remover'))));
  }

  function resetHouseForm() {
    state.houseEditing = null;
    $('#house-form').reset();
    $('#house-submit').textContent = 'Adicionar conta';
    $('#house-cancel').hidden = true;
    $('#house-error').textContent = '';
  }

  function startEditHouse(acc) {
    state.houseEditing = acc.id;
    $('#house-name').value = acc.name;
    $('#house-image').value = acc.avatarUrl || '';
    $('#house-submit').textContent = 'Salvar alterações';
    $('#house-cancel').hidden = false;
    $('#house-error').textContent = '';
    $('#house-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#house-name').focus({ preventScroll: true });
  }

  $('#house-cancel').addEventListener('click', resetHouseForm);

  function removeHouse(acc) {
    if (!confirm(`Remover a conta "${acc.name}"? Os pontos dela somem do ranking.`)) return;
    if (state.houseEditing === acc.id) resetHouseForm();
    act(() => api(`/api/admin/house-accounts/${acc.id}`, { method: 'DELETE' }), 'Conta da casa removida').then(loadHouse);
  }

  $('#house-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#house-error').textContent = '';
    const body = { name: $('#house-name').value, avatarUrl: $('#house-image').value };
    const editing = state.houseEditing;
    const submit = $('#house-submit');
    submit.disabled = true;
    try {
      if (editing) {
        await api(`/api/admin/house-accounts/${editing}`, { method: 'PUT', body });
        toast('Conta da casa atualizada');
      } else {
        await api('/api/admin/house-accounts', { method: 'POST', body });
        toast('Conta da casa criada');
      }
      resetHouseForm();
      await loadHouse();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#house-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  /* ---------- Conquistas ---------- */
  async function loadAchievements() {
    try {
      const { achievements } = await api('/api/admin/achievements');
      state.achievements = achievements;
      renderAchievements();
    } catch (e) {
      handleError(e);
    }
  }

  function achIcon(a) {
    return a.imageUrl
      ? h('img', { class: 'ach-thumb', src: a.imageUrl, alt: '' })
      : h('span', { class: 'ach-thumb ph' }, a.emoji);
  }

  function renderAchievements() {
    const box = $('#ach-list');
    box.replaceChildren();
    if (!state.achievements.length) {
      box.append(h('p', { class: 'hint' }, 'Nenhum nível cadastrado ainda.'));
      return;
    }
    const typeLabel = { points: 'pontos', streak: 'acertos seguidos', titles: 'títulos semanais', misses: 'erros', missstreak: 'erros seguidos' };
    box.append(...state.achievements.map((a) => h('div', { class: 'house-row', style: a.active ? '' : 'opacity: 0.55' },
      achIcon(a),
      h('span', { class: 'nm' }, `${a.label} — ${a.threshold} ${typeLabel[a.type]}${a.active ? '' : ' (oculta)'}`),
      h('button', {
        class: 'btn ghost small', type: 'button',
        onclick: () => toggleAch(a),
      }, a.active ? 'Ocultar' : 'Mostrar'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => startEditAch(a) }, 'Editar'),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => removeAch(a) }, 'Remover'))));
  }

  function resetAchForm() {
    state.achEditing = null;
    $('#ach-form').reset();
    $('#ach-threshold').value = 50;
    $('#ach-submit').textContent = 'Adicionar nível';
    $('#ach-cancel').hidden = true;
    $('#ach-error').textContent = '';
  }

  function startEditAch(a) {
    state.achEditing = a.id;
    $('#ach-label').value = a.label;
    $('#ach-type').value = a.type;
    $('#ach-threshold').value = a.threshold;
    $('#ach-emoji').value = a.emoji || '';
    $('#ach-image').value = a.imageUrl || '';
    $('#ach-submit').textContent = 'Salvar alterações';
    $('#ach-cancel').hidden = false;
    $('#ach-error').textContent = '';
    $('#ach-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#ach-label').focus({ preventScroll: true });
  }

  $('#ach-cancel').addEventListener('click', resetAchForm);

  function toggleAch(a) {
    act(
      () => api(`/api/admin/achievements/${a.id}/active`, { method: 'POST', body: { active: !a.active } }),
      a.active ? 'Conquista oculta para os participantes' : 'Conquista visível para os participantes'
    ).then(loadAchievements);
  }

  function removeAch(a) {
    if (!confirm(`Remover o nível "${a.label}"? Quem já tinha esse emblema perde ele.`)) return;
    if (state.achEditing === a.id) resetAchForm();
    act(() => api(`/api/admin/achievements/${a.id}`, { method: 'DELETE' }), 'Nível removido').then(loadAchievements);
  }

  $('#ach-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#ach-error').textContent = '';
    const body = {
      label: $('#ach-label').value,
      type: $('#ach-type').value,
      threshold: $('#ach-threshold').value,
      emoji: $('#ach-emoji').value,
      imageUrl: $('#ach-image').value,
    };
    const editing = state.achEditing;
    const submit = $('#ach-submit');
    submit.disabled = true;
    try {
      if (editing) {
        await api(`/api/admin/achievements/${editing}`, { method: 'PUT', body });
        toast('Nível atualizado');
      } else {
        await api('/api/admin/achievements', { method: 'POST', body });
        toast('Nível criado');
      }
      resetAchForm();
      await loadAchievements();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#ach-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  /* ---------- Backup ---------- */
  $('#backup').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin/backup', { credentials: 'same-origin' });
      if (!res.ok) {
        const err = new Error('Não foi possível gerar o backup.');
        err.status = res.status;
        throw err;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `bolao-backup-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      handleError(e);
    }
  });

  /* ---------- Início ---------- */
  (async function init() {
    try {
      const info = await api('/api/admin/me');
      if (info.admin) {
        showPanel(info);
        const botResult = new URLSearchParams(location.search).get('bot');
        if (botResult) {
          history.replaceState(null, '', location.pathname);
          setAdminTab('bot');
          toast({
            ok: 'Conta do bot conectada',
            cancelado: 'Conexão cancelada',
            'conta-canal': 'Essa é a conta dona do canal. Use uma conta separada para o bot.',
            'conta-login': 'Essa conta já entra no site como participante. Use uma conta separada para o bot.',
          }[botResult] || 'Não foi possível conectar a conta do bot', botResult !== 'ok');
        }
      }
      else showLogin();
    } catch (e) {
      showLogin();
      $('#login-error').textContent = e.message;
    }
  })();
})();
