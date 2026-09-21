(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { polls: [], users: 0, editing: null, mode: 'replace' };

  /* ---------- Utilidades ---------- */
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
    $('#admin-pass').focus();
  }

  function showPanel() {
    $('#login').hidden = true;
    $('#panel').hidden = false;
    $('#logout').hidden = false;
    loadPolls();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('#admin-pass').value } });
      $('#admin-pass').value = '';
      showPanel();
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
      state.users = data.users;
      state.mode = data.mode;
      renderMode();
      renderList();
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

  function statusText(p) {
    return { open: 'Aberta', closed: 'Encerrada', resolved: 'Resultado' }[p.status];
  }

  function renderPoll(p) {
    const group = `ans-${p.id}`;
    const correct = p.options.find((o) => o.id === p.correctOptionId);

    const options = p.options.map((o) => h('label', { class: 'aopt' },
      h('input', { type: 'radio', name: group, value: o.id, checked: o.id === p.correctOptionId }),
      h('span', {}, o.text),
      h('span', { class: 'count' }, `${o.voters.length} ${o.voters.length === 1 ? 'voto' : 'votos'}`)));

    const meta = [
      `${p.points} ${p.points === 1 ? 'ponto' : 'pontos'} por acerto`,
      p.closesAt ? `encerra em ${fmtDate(p.closesAt)}` : 'sem prazo',
      `${p.totalVotes} ${p.totalVotes === 1 ? 'voto' : 'votos'}`,
    ].join(', ');

    const article = h('article', { class: 'panel apoll' },
      h('div', { class: 'apoll-head' }, h('h3', {}, p.title),
        h('span', { class: 'pills' },
          p.visible ? null : h('span', { class: 'pill' }, 'Fora da página'),
          h('span', { class: `pill ${p.status}` }, statusText(p)))),
      h('p', { class: 'meta' }, meta),
      p.description ? h('p', { class: 'desc' }, p.description) : null,
      correct
        ? h('p', { class: 'result' }, `Resposta certa: ${correct.text}. ${p.hits} de ${p.totalVotes} acertaram (+${p.points} pts cada).`)
        : null,
      h('fieldset', {}, h('legend', {}, 'Resposta certa'), options),
      h('details', { class: 'voters' },
        h('summary', {}, `Quem votou (${p.totalVotes})`),
        p.options.map((o) => h('p', {}, h('b', {}, `${o.text}: `), o.voters.length ? o.voters.join(', ') : 'ninguém'))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => confirmAnswer(p, article) },
          p.status === 'resolved' ? 'Atualizar resposta' : 'Confirmar resposta certa'),
        p.status === 'open'
          ? h('button', { class: 'btn ghost', type: 'button', onclick: () => act(() => api(`/api/admin/polls/${p.id}/close`, { method: 'POST' }), 'Votação encerrada') }, 'Encerrar votação')
          : h('button', { class: 'btn ghost', type: 'button', onclick: () => reopen(p) }, 'Reabrir votação'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => act(() => api(`/api/admin/polls/${p.id}/visibility`, { method: 'POST', body: { visible: !p.visible } }), p.visible ? 'Enquete ocultada da página' : 'Enquete de volta na página') },
          p.visible ? 'Ocultar da página' : 'Mostrar na página'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => startEdit(p) }, 'Editar'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => remove(p) }, 'Excluir')));
    return article;
  }

  function renderList() {
    const box = $('#poll-list');
    $('#list-title').textContent = `Enquetes (${state.polls.length}) · ${state.users} ${state.users === 1 ? 'participante' : 'participantes'}`;
    box.replaceChildren();
    if (!state.polls.length) {
      box.append(h('div', { class: 'empty' }, h('p', {}, 'Nenhuma enquete publicada. Use o formulário para criar a primeira.')));
      return;
    }
    state.polls.forEach((p) => box.append(renderPoll(p)));
  }

  function confirmAnswer(p, article) {
    const sel = article.querySelector('input[type="radio"]:checked');
    if (!sel) {
      toast('Escolha a resposta certa antes de confirmar.', true);
      return;
    }
    const text = p.options.find((o) => o.id === sel.value).text;
    if (!confirm(`Confirmar "${text}" como resposta certa? Os pontos do ranking serão calculados agora.`)) return;
    act(() => api(`/api/admin/polls/${p.id}/resolve`, { method: 'POST', body: { optionId: sel.value } }), 'Resposta salva e ranking atualizado');
  }

  function reopen(p) {
    const warn = p.status === 'resolved' ? ' A resposta certa será removida e os pontos desta enquete saem do ranking.' : '';
    if (!confirm(`Reabrir a votação de "${p.title}"?${warn}`)) return;
    act(() => api(`/api/admin/polls/${p.id}/reopen`, { method: 'POST' }), 'Votação reaberta');
  }

  function remove(p) {
    const keep = p.status === 'resolved' && p.counted
      ? ' Os pontos já conquistados continuam no ranking.'
      : ' Como não tem resposta definida, ela não gera pontos.';
    if (!confirm(`Excluir "${p.title}" e os votos dela?${keep} Isso não pode ser desfeito.`)) return;
    if (state.editing === p.id) resetForm();
    act(() => api(`/api/admin/polls/${p.id}`, { method: 'DELETE' }), 'Enquete excluída');
  }

  /* ---------- Formulário (criar e editar) ---------- */
  function resetForm() {
    state.editing = null;
    $('#poll-form').reset();
    $('#f-points').value = 10;
    $('#f-options').disabled = false;
    $('#f-options-hint').textContent = 'De 2 a 10 opções, uma por linha.';
    $('#form-title').textContent = 'Nova enquete';
    $('#form-submit').textContent = 'Publicar enquete';
    $('#form-cancel').hidden = true;
    $('#form-error').textContent = '';
  }

  function startEdit(p) {
    state.editing = p.id;
    $('#f-title').value = p.title;
    $('#f-desc').value = p.description || '';
    $('#f-options').value = p.options.map((o) => o.text).join('\n');
    $('#f-options').disabled = true;
    $('#f-options-hint').textContent = 'As opções não podem ser alteradas depois de publicar.';
    $('#f-points').value = p.points;
    $('#f-closes').value = toLocalInput(p.closesAt);
    $('#form-title').textContent = 'Editar enquete';
    $('#form-submit').textContent = 'Salvar alterações';
    $('#form-cancel').hidden = false;
    $('#form-error').textContent = '';
    $('#form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#f-title').focus({ preventScroll: true });
  }

  $('#form-cancel').addEventListener('click', resetForm);

  $('#poll-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#form-error').textContent = '';
    const closes = $('#f-closes').value;
    const body = {
      title: $('#f-title').value,
      description: $('#f-desc').value,
      points: $('#f-points').value,
      closesAt: closes ? new Date(closes).toISOString() : null,
    };
    const editing = state.editing;
    if (!editing) body.options = $('#f-options').value.split('\n');

    const submit = $('#form-submit');
    submit.disabled = true;
    try {
      if (editing) {
        await api(`/api/admin/polls/${editing}`, { method: 'PUT', body });
        toast('Alterações salvas');
      } else {
        await api('/api/admin/polls', { method: 'POST', body });
        toast('Enquete publicada');
      }
      resetForm();
      await loadPolls();
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $('#form-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

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

  $('#reset-ranking').addEventListener('click', () => {
    if (!confirm('Zerar o ranking? Todos os pontos voltam para 0 e isso não pode ser desfeito. Considere baixar um backup antes.')) return;
    act(() => api('/api/admin/ranking/reset', { method: 'POST' }), 'Ranking zerado');
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
      const { admin } = await api('/api/admin/me');
      if (admin) showPanel();
      else showLogin();
    } catch (e) {
      showLogin();
      $('#login-error').textContent = e.message;
    }
  })();
})();
