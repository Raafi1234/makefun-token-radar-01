/* Launch Radar — the board page. Renders window.RADAR (written by main.ts from the sealed
   snapshot): a sortable, filterable board of pre-token protocols ranked by implied launch value,
   a detail view per protocol with the value model's factors and the farm plan, and the live-token
   comparables the model was calibrated on. State lives in the URL hash (#p=slug opens a protocol,
   #cat=, #chain=, #q=, #w=1 filter the board, #view=live shows the comparables), so every view a
   reader can reach is a link — and the entry's screenshots are honest renders of this page. */
(function () {
  'use strict';
  var R = window.RADAR;
  var app = document.getElementById('app');
  var statsEl = document.getElementById('stats');
  var footEl = document.getElementById('foot');
  if (!R || !app) return;

  var state = { view: 'board', q: '', cat: '', chain: '', watch: false, sort: 'rank', dir: 1, slug: null };
  var bySlug = {};
  R.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var catComp = {};
  R.categories.forEach(function (c) { catComp[c.category] = c; });

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function pct(n) { return n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function ageLabel(days) {
    if (days === null) return 'unrecorded';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    var next = { view: 'board', q: '', cat: '', chain: '', watch: false, sort: 'rank', dir: 1, slug: null };
    h.split('&').forEach(function (part) {
      var kv = part.split('=');
      if (kv.length !== 2) return;
      var k = kv[0], v = decodeURIComponent(kv[1]);
      if (k === 'p') next.slug = v;
      else if (k === 'cat') next.cat = v;
      else if (k === 'chain') next.chain = v;
      else if (k === 'q') next.q = v;
      else if (k === 'w') next.watch = v === '1';
      else if (k === 'view') next.view = v === 'live' ? 'live' : 'board';
    });
    var sort = state.sort, dir = state.dir;
    state = next; state.sort = sort; state.dir = dir;
  }
  function writeHash() {
    var parts = [];
    if (state.view === 'live') parts.push('view=live');
    if (state.cat) parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.chain) parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.watch) parts.push('w=1');
    if (state.slug) parts.push('p=' + encodeURIComponent(state.slug));
    var h = '#' + parts.join('&');
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  function stat(label, value) { return '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>'; }
  statsEl.innerHTML =
    stat('protocols scanned', R.scanned) +
    stat('record no token', R.pre_token) +
    stat('watchlist covered', R.watchlist_size + ' / ' + R.watchlist_size) +
    stat('board rows', R.board_size) +
    stat('snapshot date', R.as_of);

  footEl.innerHTML =
    '<p>Data: ' + esc(R.source) + '. The board says a protocol <b>records no token</b> in that snapshot — DefiLlama’s record, not proof that none exists. ' +
    'Implied value is this radar’s own claim, worked out from the snapshot’s figures by the model below; it is not a prediction that a token will be issued. ' +
    'Model ' + esc(R.model_version) + ': implied = TVL × category multiple × growth factor × maturity factor × breadth factor.</p>' +
    '<p>Farm plans are checklists, not financial advice: costs are estimates in USD at the snapshot date, and a position can lose money whether or not a token ever launches.</p>';

  var allCats = [];
  var allChains = [];
  (function () {
    var cs = {}, ch = {};
    R.rows.forEach(function (r) {
      if (r.category) cs[r.category] = 1;
      r.chains.forEach(function (c) { ch[c] = 1; });
    });
    allCats = Object.keys(cs).sort();
    allChains = Object.keys(ch).sort();
  })();

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return R.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }
  var SORTS = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    growth: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    implied: function (r) { return r.implied_value_usd; },
    ratio: function (r) { return r.tvl_usd > 0 ? r.implied_value_usd / r.tvl_usd : 0; },
  };
  function sortedRows(rows) {
    var f = SORTS[state.sort] || SORTS.rank;
    return rows.slice().sort(function (a, b) {
      var x = f(a), y = f(b);
      var d = x < y ? -1 : x > y ? 1 : 0;
      if (d === 0) d = a.rank - b.rank;
      return d * state.dir;
    });
  }

  function methodHtml() {
    return '<section class="method"><h2>How the radar values a launch</h2>' +
      '<p>Every protocol whose token already trades in the snapshot is a comparable: the market pays a median of <code>' +
      R.global_multiple.toFixed(2) + '× TVL</code> across all of them. Each category gets its own multiple — the median market-cap/TVL ' +
      'of its live protocols, shrunk toward that global median when a category has few. A pre-token protocol’s base is its TVL times its ' +
      'category’s multiple; the seven-day TVL change then moves it by −14% to +28%, a longer record with no token raises it by up to 35%, ' +
      'and each extra chain adds 1%. Nothing is ranked by name: change the snapshot and the board re-derives itself.</p>' +
      '<p>The watchlist (TVL ≥ ' + money(R.floor_usd) + ', no token recorded, not a wrapped or staked product) is the floor, never the ceiling: ' +
      'the board also carries the strongest early protocols below the floor that pass the same screen. Protocols whose token already trades ' +
      'are never ranked here — they sit under <b>Comparables</b>, at the market’s own values.</p></section>';
  }

  function controlsHtml(rowsShown) {
    var catOpts = '<option value="">All categories</option>' + allCats.map(function (c) {
      return '<option' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = '<option value="">All chains</option>' + allChains.map(function (c) {
      return '<option' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<span class="tabs"><button id="tab-board" aria-pressed="' + (state.view === 'board') + '">Board</button>' +
      '<button id="tab-live" aria-pressed="' + (state.view === 'live') + '">Comparables</button></span>' +
      '<input type="search" id="q" placeholder="Search protocols…" value="' + esc(state.q) + '" aria-label="Search protocols">' +
      '<select id="cat" aria-label="Filter by category">' + catOpts + '</select>' +
      '<select id="chain" aria-label="Filter by chain">' + chainOpts + '</select>' +
      '<label class="toggle"><input type="checkbox" id="watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + rowsShown + ' shown</span></div>';
  }

  function th(key, label, cls) {
    var mark = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
    return '<th data-sort="' + key + '"' + (state.sort === key ? ' class="sorted"' : '') + (cls ? ' data-cls="' + cls + '"' : '') + '>' + label + mark + '</th>';
  }
  function boardHtml() {
    var rows = sortedRows(filtered());
    var head = '<tr>' + th('rank', '#') + th('name', 'Protocol') + th('tvl', 'TVL') + th('growth', '7d %') +
      '<th class="hide-s">Chains</th>' + th('age', 'Age') + th('implied', 'Implied value') + th('ratio', '× TVL') + '</tr>';
    var body = rows.map(function (r) {
      var ratio = r.tvl_usd > 0 ? (r.implied_value_usd / r.tvl_usd).toFixed(2) + '×' : '—';
      var badge = r.on_watchlist ? '<span class="badge watch">WATCHLIST</span>' : '<span class="badge early">EARLY</span>';
      var ch = r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '');
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.on_watchlist ? ' class="watch"' : '') + '>' +
        '<td>' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + badge + '<span class="pcat">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td>' + money(r.tvl_usd) + '</td>' +
        '<td class="' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="chains hide-s">' + esc(ch) + '</td>' +
        '<td>' + ageLabel(r.age_days) + '</td>' +
        '<td class="value">' + money(r.implied_value_usd) + '</td>' +
        '<td>' + ratio + '</td></tr>';
    }).join('');
    if (rows.length === 0) body = '';
    return methodHtml() + controlsHtml(rows.length) +
      (rows.length ? '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>'
        : '<div class="empty">No protocol on the board matches those filters. Loosen one and the radar sweeps again.</div>');
  }

  function liveHtml() {
    var head = '<tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Market cap</th><th>MCap / TVL</th><th>7d %</th></tr>';
    var body = R.live.map(function (r) {
      return '<tr data-live="1"><td><span class="pname">' + esc(r.name) + '</span><span class="pcat">' + esc(r.symbol || '') + '</span></td>' +
        '<td class="chains">' + esc(r.category || 'Uncategorized') + '</td>' +
        '<td>' + money(r.tvl_usd) + '</td><td>' + money(r.mcap_usd) + '</td>' +
        '<td class="value">' + (r.ratio === null ? '—' : r.ratio.toFixed(2) + '×') + '</td>' +
        '<td class="' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</td></tr>';
    }).join('');
    return methodHtml() + controlsHtml(R.live.length) +
      '<p class="comp">These protocols already trade, so the radar never ranks them: they are the comparables. ' +
      'Each one is an observation of what the market pays per dollar of TVL, and their category medians set the board’s base multiples.</p>' +
      '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function factor(label, display, widthPct, note, isFinal) {
    return '<div class="factor' + (isFinal ? ' final' : '') + '"><div class="row"><span>' + label + '</span><b>' + display + '</b></div>' +
      '<div class="bar"><i style="width:' + Math.max(2, Math.min(100, widthPct)) + '%"></i></div>' +
      (note ? '<p>' + note + '</p>' : '') + '</div>';
  }
  function detailHtml(r) {
    var m = r.model;
    var comp = r.category ? catComp[r.category] : null;
    var base = r.tvl_usd * m.category_multiple;
    var log = function (v) { return Math.log10(Math.max(1, v)); };
    var wBase = 100 * log(base) / Math.max(1, log(r.implied_value_usd * 1.6));
    var examples = comp && comp.examples.length
      ? comp.examples.map(function (e) {
          return '<p class="comp"><b>' + esc(e.name) + (e.symbol ? ' (' + esc(e.symbol) + ')' : '') + '</b> trades at ' + e.ratio.toFixed(2) + '× its TVL.</p>';
        }).join('')
      : '<p class="comp">This category has no live comparables in the snapshot, so the board uses the global median multiple.</p>';
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    return '<div class="detail-scrim" id="scrim"></div><aside class="detail" aria-label="Protocol detail">' +
      '<button class="close" id="close" aria-label="Close detail">×</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' · ' + esc(r.category || 'Uncategorized') + ' · ' +
      (r.on_watchlist ? 'on the snapshot watchlist' : 'early find below the watchlist floor') + ' · records no token in the snapshot</p>' +
      '<div class="facts">' +
      '<div><span>TVL</span><b>' + money(r.tvl_usd) + '</b></div>' +
      '<div><span>Implied launch value</span><b>' + money(r.implied_value_usd) + '</b></div>' +
      '<div><span>TVL change, 7d</span><b>' + pct(r.change_7d) + '</b></div>' +
      '<div><span>Tracked since</span><b>' + (r.listed_at || 'unrecorded') + '</b></div>' +
      '<div><span>Age with no token</span><b>' + (r.age_days === null ? 'unrecorded' : r.age_days + ' days') + '</b></div>' +
      '<div><span>Chains</span><b>' + esc(r.chains.join(', ') || '—') + '</b></div>' +
      '</div>' +
      '<h3>How this value is derived</h3>' +
      factor('Base — TVL × category multiple ' + m.category_multiple.toFixed(2) + '×', money(base), wBase,
        'The ' + esc(r.category || 'Uncategorized') + ' multiple is the median market-cap/TVL of its ' + m.category_comps + ' live comparables, shrunk toward the global median.') +
      factor('Growth ×' + m.growth_f.toFixed(2), pct(m.growth_pct) + ' in 7d', 100 * (m.growth_f - 0.86) / 0.42, 'Seven-day TVL momentum, clamped so one hot week cannot carry a board.') +
      factor('Maturity ×' + m.maturity_f.toFixed(2), ageLabel(r.age_days) + ' tracked', 100 * (m.maturity_f - 0.75) / 0.35, 'Longer running with no token recorded means more record to launch on.') +
      factor('Breadth ×' + m.breadth_f.toFixed(2), r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains'), 100 * (m.breadth_f - 1) / 0.08, '') +
      factor('Implied launch value', money(r.implied_value_usd), 100, '', true) +
      '<h3>Live comparables in this category</h3>' + examples +
      '<h3>Farm plan</h3><ol class="plan">' + steps + '</ol>' +
      '</aside>';
  }

  function render() {
    readHashOnce();
    app.innerHTML = state.view === 'live' ? liveHtml() : boardHtml();
    if (state.slug && bySlug[state.slug]) app.insertAdjacentHTML('beforeend', detailHtml(bySlug[state.slug]));
    app.setAttribute('aria-busy', 'false');
    bind();
  }
  var hashRead = false;
  function readHashOnce() { if (!hashRead) { readHash(); hashRead = true; } }

  function bind() {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; writeHash(); rerenderTable(); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.cat = cat.value; writeHash(); render(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
    var watch = document.getElementById('watch');
    if (watch) watch.addEventListener('change', function () { state.watch = watch.checked; writeHash(); render(); });
    var tb = document.getElementById('tab-board');
    if (tb) tb.addEventListener('click', function () { state.view = 'board'; writeHash(); render(); });
    var tl = document.getElementById('tab-live');
    if (tl) tl.addEventListener('click', function () { state.view = 'live'; writeHash(); render(); });
    Array.prototype.forEach.call(app.querySelectorAll('th[data-sort]'), function (el) {
      el.addEventListener('click', function () {
        var k = el.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
        if (k === 'rank') state.dir = 1;
        render();
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('tr[data-slug]'), function (el) {
      el.addEventListener('click', function () { state.slug = el.getAttribute('data-slug'); writeHash(); render(); });
    });
    var close = document.getElementById('close');
    if (close) close.addEventListener('click', closeDetail);
    var scrim = document.getElementById('scrim');
    if (scrim) scrim.addEventListener('click', closeDetail);
  }
  function closeDetail() { state.slug = null; writeHash(); render(); }
  function rerenderTable() {
    // Typing in search re-renders the board but keeps focus in the box.
    var active = document.activeElement;
    render();
    var q2 = document.getElementById('q');
    if (q2 && active && active.id === 'q') { q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.slug) closeDetail(); });
  window.addEventListener('hashchange', function () { hashRead = false; render(); });
  render();
})();
