/* Tema claro/escuro. Roda no <head>, antes da página aparecer, pra não piscar.
   A escolha da pessoa fica salva neste navegador; sem escolha, segue o do aparelho. */
(function () {
  var KEY = 'theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) { return null; }
  }
  function current() { return saved() || (media && media.matches ? 'dark' : 'light'); }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0D1124' : '#14237A');
  }

  apply(current());

  // Sem escolha salva, acompanha o aparelho se ele mudar (ex.: modo noturno automático)
  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (!saved()) { apply(current()); paint(); } });
  }

  var button = null;
  function paint() {
    if (!button) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    button.textContent = dark ? '☀️' : '🌙';
    var label = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
    button.setAttribute('title', label);
    button.setAttribute('aria-label', label);
  }

  document.addEventListener('DOMContentLoaded', function () {
    button = document.getElementById('theme-toggle');
    if (!button) return;
    paint();
    button.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) { /* sem armazenamento: vale só nesta visita */ }
      apply(next);
      paint();
    });
  });
})();
