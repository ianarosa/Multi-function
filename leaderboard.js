/* leaderboard.js – shared leaderboard overlay for all games
 * Each game includes this script with:
 *   <script src="/leaderboard.js" data-game="game-id" data-color="#hexcolor"></script>
 * and dispatches:
 *   window.dispatchEvent(new CustomEvent('lbGameOver', { detail: { score: N } }));
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var gameId = (script && script.getAttribute('data-game')) ||
    window.location.pathname.replace(/^\/|\/$/g, '').split('/')[0] || 'unknown';
  var accent = (script && script.getAttribute('data-color')) || '#00ccff';

  /* ── Inject styles ───────────────────────────────────────── */
  var style = document.createElement('style');
  style.textContent = [
    '#lb-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:99999;',
    'align-items:center;justify-content:center;font-family:Barlow,"Segoe UI",sans-serif;}',
    '#lb-overlay.lb-show{display:flex;}',
    '#lb-panel{background:#0a0a12;border:1px solid ' + accent + '44;border-radius:10px;',
    'padding:28px 32px;width:min(380px,92vw);max-height:90vh;overflow-y:auto;',
    'box-shadow:0 0 40px ' + accent + '22;}',
    '#lb-panel h2{font-family:"Bebas Neue",cursive;font-size:1.9rem;letter-spacing:.12em;',
    'color:' + accent + ';text-align:center;margin-bottom:6px;text-shadow:0 0 16px ' + accent + '88;}',
    '#lb-score-line{text-align:center;color:#fff;font-size:.9rem;margin-bottom:18px;opacity:.75;}',
    '#lb-score-line strong{color:' + accent + ';font-size:1.1rem;}',
    '#lb-name-row{display:flex;gap:8px;margin-bottom:10px;}',
    '#lb-name{flex:1;background:#111;border:1px solid ' + accent + '55;border-radius:5px;',
    'color:#fff;font-size:1rem;padding:8px 10px;outline:none;}',
    '#lb-name:focus{border-color:' + accent + ';}',
    '#lb-submit{background:' + accent + ';color:#000;border:none;border-radius:5px;',
    'font-family:"Bebas Neue",cursive;font-size:1rem;letter-spacing:.08em;',
    'padding:8px 16px;cursor:pointer;white-space:nowrap;}',
    '#lb-submit:hover{opacity:.85;}',
    '#lb-skip{display:block;width:100%;background:transparent;border:1px solid ' + accent + '44;',
    'color:' + accent + ';border-radius:5px;font-size:.8rem;letter-spacing:.05em;',
    'padding:6px;cursor:pointer;margin-bottom:18px;}',
    '#lb-skip:hover{background:' + accent + '22;}',
    '#lb-table-wrap h2{margin-bottom:14px;}',
    '#lb-table{width:100%;border-collapse:collapse;}',
    '#lb-table th{font-size:.7rem;letter-spacing:.1em;color:' + accent + '99;',
    'text-transform:uppercase;border-bottom:1px solid ' + accent + '33;padding:4px 6px;text-align:left;}',
    '#lb-table td{padding:7px 6px;font-size:.88rem;color:#ddd;border-bottom:1px solid #ffffff0a;}',
    '#lb-table tr.lb-me td{color:#fff;font-weight:600;}',
    '#lb-table td.lb-rank{color:' + accent + ';font-weight:700;width:28px;}',
    '#lb-table td.lb-sc{text-align:right;font-variant-numeric:tabular-nums;}',
    '#lb-close{display:block;width:100%;margin-top:18px;background:transparent;',
    'border:1px solid ' + accent + '55;color:' + accent + ';border-radius:5px;',
    'font-family:"Bebas Neue",cursive;font-size:1.1rem;letter-spacing:.1em;',
    'padding:9px;cursor:pointer;}',
    '#lb-close:hover{background:' + accent + '22;}',
    '#lb-trophy{position:fixed;bottom:12px;right:12px;z-index:9998;',
    'background:#0a0a12;border:1px solid ' + accent + '55;border-radius:6px;',
    'color:' + accent + ';font-size:.75rem;font-family:Barlow,sans-serif;font-weight:600;',
    'letter-spacing:.06em;padding:6px 12px;cursor:pointer;',
    'box-shadow:0 0 12px ' + accent + '22;transition:background .15s;}',
    '#lb-trophy:hover{background:' + accent + '22;}',
    '#lb-loading{text-align:center;color:#666;padding:20px 0;font-size:.85rem;}',
    '#lb-err{text-align:center;color:#f66;padding:10px 0;font-size:.82rem;}',
  ].join('');
  document.head.appendChild(style);

  /* ── Markup ──────────────────────────────────────────────── */
  var overlay = document.createElement('div');
  overlay.id = 'lb-overlay';
  overlay.innerHTML = [
    '<div id="lb-panel">',
    '  <div id="lb-submit-wrap">',
    '    <h2>GAME OVER</h2>',
    '    <p id="lb-score-line">Your score: <strong id="lb-score-val">0</strong></p>',
    '    <div id="lb-name-row">',
    '      <input id="lb-name" type="text" maxlength="20" placeholder="Enter your name" autocomplete="off" spellcheck="false"/>',
    '      <button id="lb-submit">SUBMIT</button>',
    '    </div>',
    '    <button id="lb-skip">Skip — just view leaderboard</button>',
    '  </div>',
    '  <div id="lb-table-wrap" style="display:none">',
    '    <h2>LEADERBOARD</h2>',
    '    <div id="lb-table-content"><p id="lb-loading">Loading…</p></div>',
    '    <button id="lb-close">CLOSE</button>',
    '  </div>',
    '</div>',
  ].join('');
  document.body.appendChild(overlay);

  /* ── Floating trophy button (always visible) ─────────────── */
  var trophy = document.createElement('button');
  trophy.id = 'lb-trophy';
  trophy.textContent = '🏆 Leaderboard';
  document.body.appendChild(trophy);

  /* ── DOM refs ────────────────────────────────────────────── */
  var submitWrap = document.getElementById('lb-submit-wrap');
  var tableWrap  = document.getElementById('lb-table-wrap');
  var scoreVal   = document.getElementById('lb-score-val');
  var nameInput  = document.getElementById('lb-name');
  var submitBtn  = document.getElementById('lb-submit');
  var skipBtn    = document.getElementById('lb-skip');
  var tableContent = document.getElementById('lb-table-content');
  var closeBtn   = document.getElementById('lb-close');

  var pendingScore = null;
  var submittedName = '';

  /* ── Open / close overlay ────────────────────────────────── */
  function openOverlay() { overlay.classList.add('lb-show'); }
  function closeOverlay() {
    overlay.classList.remove('lb-show');
    submitWrap.style.display = '';
    tableWrap.style.display  = 'none';
    pendingScore = null;
  }

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeOverlay();
  });
  closeBtn.addEventListener('click', closeOverlay);

  /* ── Show name-entry form ────────────────────────────────── */
  function showSubmitForm(score) {
    pendingScore = score;
    scoreVal.textContent = score.toLocaleString();
    submitWrap.style.display = '';
    tableWrap.style.display  = 'none';
    openOverlay();
    setTimeout(function () { nameInput.focus(); }, 80);
  }

  /* ── Fetch & render leaderboard table ────────────────────── */
  function showLeaderboard(highlightName) {
    submitWrap.style.display = 'none';
    tableWrap.style.display  = '';
    tableContent.innerHTML   = '<p id="lb-loading">Loading…</p>';
    openOverlay();

    fetch('/api/leaderboard?game=' + encodeURIComponent(gameId))
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!rows || !rows.length) {
          tableContent.innerHTML = '<p id="lb-loading">No scores yet — be the first!</p>';
          return;
        }
        var html = '<table id="lb-table"><thead><tr>' +
          '<th>#</th><th>Name</th><th>Score</th></tr></thead><tbody>';
        rows.forEach(function (row, i) {
          var isMe = highlightName && row.player === highlightName;
          html += '<tr' + (isMe ? ' class="lb-me"' : '') + '>' +
            '<td class="lb-rank">' + (i + 1) + '</td>' +
            '<td>' + escHtml(row.player) + '</td>' +
            '<td class="lb-sc">' + Number(row.score).toLocaleString() + '</td>' +
            '</tr>';
        });
        html += '</tbody></table>';
        tableContent.innerHTML = html;
      })
      .catch(function () {
        tableContent.innerHTML = '<p id="lb-err">Could not load scores.</p>';
      });
  }

  /* ── Submit score ────────────────────────────────────────── */
  function doSubmit() {
    var name = nameInput.value.trim() || 'Anonymous';
    submittedName = name;
    submitBtn.disabled = true;
    submitBtn.textContent = '…';

    fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: gameId, player: name, score: pendingScore })
    })
      .then(function () { showLeaderboard(name); })
      .catch(function () { showLeaderboard(name); })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'SUBMIT';
        nameInput.value = '';
      });
  }

  submitBtn.addEventListener('click', doSubmit);
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doSubmit();
  });
  skipBtn.addEventListener('click', function () { showLeaderboard(submittedName); });
  trophy.addEventListener('click', function () {
    if (typeof window.__lbCurrentScore === 'function') {
      showSubmitForm(Math.round(Number(window.__lbCurrentScore())));
    } else {
      showLeaderboard(submittedName);
    }
  });

  /* ── Listen for game-over events ────────────────────────── */
  window.addEventListener('lbGameOver', function (e) {
    var score = (e.detail && e.detail.score != null) ? Math.round(Number(e.detail.score)) : 0;
    if (score < 0) score = 0;
    showSubmitForm(score);
  });

  /* ── Helper ──────────────────────────────────────────────── */
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
