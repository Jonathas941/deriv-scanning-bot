/**
 * Self-contained dashboard. No build step, no CDN, no browser storage —
 * it polls the read-only API and renders. Colors come from the validated
 * palette (see the project README for the source of these values).
 */
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en" data-palette="#2a78d6,#eb6834,#1baf7a">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deriv Scanning Bot</title>
<link rel="icon" href="data:,">
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    /* Meter track is NEUTRAL, not a step of the fill's ramp. The fill's hue
       here encodes severity (blue/amber/green), so a colored track would read
       as a second data segment rather than as empty space. */
    --meter-track: #e1e0d9;
    --good: #0ca30c;
    --warning: #fab219;
    --serious: #ec835a;
    --critical: #d03b3b;
    --success-text: #006300;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --axis: #383835;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --meter-track: #2c2c2a;
      --success-text: #0ca30c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--page);
    color: var(--text-primary);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 2px; }
  .sub { color: var(--text-secondary); font-size: 13px; margin-bottom: 20px; }

  .banner {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-1);
    margin-bottom: 20px; font-weight: 500;
  }
  .banner .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .banner .ico { font-weight: 700; font-size: 15px; flex: none; }

  .grid {
    display: grid; gap: 12px; margin-bottom: 20px;
    grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
  }
  .tile {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px;
  }
  .tile .label { color: var(--text-secondary); font-size: 12px; margin-bottom: 6px; }
  .tile .value { font-size: 24px; font-weight: 600; }
  .tile .delta { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
  .hero .value { font-size: 48px; font-weight: 600; line-height: 1.1; }
  .hero { grid-column: span 2; }
  .pos { color: var(--success-text); }
  .neg { color: var(--critical); }

  .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px; margin-bottom: 20px;
  }
  .card h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; font-weight: 500; color: var(--muted);
    padding: 6px 10px 6px 0; border-bottom: 1px solid var(--grid);
    font-size: 12px; white-space: nowrap;
  }
  td {
    padding: 9px 10px 9px 0; border-bottom: 1px solid var(--grid);
    font-variant-numeric: tabular-nums; vertical-align: middle;
  }
  tr:last-child td { border-bottom: none; }
  .sym { font-weight: 500; }
  .muted { color: var(--muted); }
  .nowrap { white-space: nowrap; }

  /* Meter: fill carries severity, track is a lighter step of the same ramp. */
  .meter { display: flex; align-items: center; gap: 8px; min-width: 130px; }
  .meter .track {
    flex: 1; height: 6px; border-radius: 3px;
    background: var(--meter-track); overflow: hidden;
  }
  .meter .fill { height: 100%; border-radius: 3px; background: var(--series-1); }
  .meter .num { font-variant-numeric: tabular-nums; width: 34px; text-align: right; }
  td.score-cell { padding-right: 28px; }

  .tag {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; white-space: nowrap;
  }
  .tag .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }

  .empty { color: var(--muted); padding: 18px 0; font-size: 13px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
  .err {
    border-left: 3px solid var(--critical); padding-left: 10px;
    color: var(--text-secondary); font-size: 12px; margin-top: 10px;
  }
  svg .gridline { stroke: var(--grid); stroke-width: 1; }
  svg .sparkline { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  svg .enddot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
  svg text { fill: var(--muted); font-size: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Deriv Scanning Bot</h1>
  <div class="sub" id="sub">connecting&hellip;</div>

  <div class="banner" id="banner">
    <span class="ico" style="color:var(--muted)">&bull;</span>
    <span id="banner-text">Loading status&hellip;</span>
  </div>

  <div class="grid" id="tiles"></div>

  <div class="card">
    <h2>Signal score, last scans</h2>
    <div id="spark"></div>
  </div>

  <div class="card">
    <h2>Recent signals</h2>
    <div id="signals"></div>
  </div>

  <div class="card">
    <h2>Trades</h2>
    <div id="trades"></div>
  </div>

  <footer id="footer"></footer>
</div>

<script>
(function () {
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  var money = function (n, cur) {
    if (n === null || n === undefined) return '--';
    var sign = n < 0 ? '-' : '';
    return sign + (cur ? cur + ' ' : '') + Math.abs(n).toFixed(2);
  };
  // Hero figure: thousands-separated, no currency prefix. The currency lives in
  // the tile's label line so the big number never wraps onto two lines.
  var heroNumber = function (n) {
    if (n === null || n === undefined) return '--';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  };
  var ago = function (iso) {
    if (!iso) return '--';
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  };

  // Severity by score band. Icon + label always accompany the color so the
  // state never rests on hue alone.
  var scoreColor = function (score, threshold) {
    if (score >= threshold) return 'var(--good)';
    if (score >= threshold * 0.8) return 'var(--warning)';
    return 'var(--series-1)';
  };

  function tile(label, value, delta, cls, hero) {
    return '<div class="tile' + (hero ? ' hero' : '') + '">' +
      '<div class="label">' + esc(label) + '</div>' +
      '<div class="value' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
      (delta ? '<div class="delta">' + delta + '</div>' : '') +
      '</div>';
  }

  function meter(score, threshold) {
    var pct = Math.max(0, Math.min(100, score));
    return '<div class="meter">' +
      '<div class="track"><div class="fill" style="width:' + pct + '%;background:' +
        scoreColor(score, threshold) + '"></div></div>' +
      '<span class="num">' + score.toFixed(0) + '</span></div>';
  }

  function directionTag(dir) {
    var up = dir === 'CALL';
    return '<span class="tag"><span class="swatch" style="background:' +
      (up ? 'var(--good)' : 'var(--critical)') + '"></span>' +
      (up ? '&uarr; Rise' : '&darr; Fall') + '</span>';
  }

  function statusTag(status) {
    var map = {
      won: ['var(--good)', '&check; Won'],
      lost: ['var(--critical)', '&times; Lost'],
      open: ['var(--series-1)', '&bull; Open'],
      cancelled: ['var(--muted)', '&ndash; Dry run']
    };
    var m = map[status] || ['var(--muted)', esc(status)];
    return '<span class="tag"><span class="swatch" style="background:' + m[0] +
      '"></span>' + m[1] + '</span>';
  }

  function sparkline(scans, threshold) {
    var pts = scans.slice().reverse()
      .map(function (s) { return s.bestScore; })
      .filter(function (v) { return typeof v === 'number'; });
    if (pts.length < 2) {
      return '<div class="empty">Not enough scans yet to plot a trend.</div>';
    }
    var w = 640, h = 120, padL = 28, padR = 16, padT = 10, padB = 18;
    var iw = w - padL - padR, ih = h - padT - padB;
    var max = 100, min = 0;
    var x = function (i) { return padL + (i / (pts.length - 1)) * iw; };
    var y = function (v) { return padT + ih - ((v - min) / (max - min)) * ih; };

    var d = pts.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    var ticks = [0, 50, 100];
    var grid = ticks.map(function (t) {
      return '<line class="gridline" x1="' + padL + '" y1="' + y(t) + '" x2="' + (w - padR) + '" y2="' + y(t) + '"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y(t) + 3) + '" text-anchor="end">' + t + '</text>';
    }).join('');
    // Threshold rule is labelled at the LEFT edge so it can never collide with
    // the end-dot and its value label, which always sit at the right edge.
    var thr = '<line class="gridline" x1="' + padL + '" y1="' + y(threshold) +
      '" x2="' + (w - padR) + '" y2="' + y(threshold) +
      '" style="stroke:var(--axis)"/>' +
      // Halo the label in the surface color so the plot line can cross behind
      // it without the text becoming unreadable.
      '<text x="' + (padL + 4) + '" y="' + (y(threshold) + 13) + '" text-anchor="start" ' +
      'paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" stroke-linejoin="round">' +
      'threshold ' + threshold + '</text>';
    var lastI = pts.length - 1;
    var dot = '<circle class="enddot" cx="' + x(lastI).toFixed(1) + '" cy="' + y(pts[lastI]).toFixed(1) + '" r="4"/>';
    var lbl = '<text x="' + (x(lastI) - 8).toFixed(1) + '" y="' + (y(pts[lastI]) - 10).toFixed(1) +
      '" text-anchor="end" style="fill:var(--text-secondary);font-size:11px">' +
      pts[lastI].toFixed(0) + '</text>';

    // No fixed height attribute: with both width="100%" and height set, the
    // viewBox letterboxes and the plot floats in the middle of the card.
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" ' +
      'style="width:100%;height:auto;display:block;max-height:200px" ' +
      'role="img" aria-label="Best signal score per scan, most recent at right">' +
      grid + thr + '<path class="sparkline" d="' + d + '"/>' + dot + lbl + '</svg>';
  }

  function renderSignals(signals, threshold) {
    if (!signals.length) return '<div class="empty">No signals scored yet.</div>';
    var rows = signals.slice(0, 15).map(function (s) {
      return '<tr>' +
        '<td class="sym">' + esc(s.displayName || s.symbol) + '<div class="muted">' + esc(s.symbol) + '</div></td>' +
        '<td>' + directionTag(s.direction) + '</td>' +
        '<td class="score-cell">' + meter(s.score, threshold) + '</td>' +
        '<td class="nowrap">' + Number(s.price).toFixed(4) + '</td>' +
        '<td class="nowrap">' + Number(s.rsi).toFixed(1) + '</td>' +
        '<td class="nowrap muted">' + ago(s.evaluatedAt) + '</td>' +
        '</tr>';
    }).join('');
    return '<table><thead><tr><th>Symbol</th><th>Direction</th><th>Score</th>' +
      '<th>Price</th><th>RSI</th><th>Seen</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderTrades(trades, cur) {
    if (!trades.length) return '<div class="empty">No trades recorded yet.</div>';
    var rows = trades.slice(0, 15).map(function (t) {
      var p = t.profit;
      var cls = p === null || p === undefined ? 'muted' : (p >= 0 ? 'pos' : 'neg');
      return '<tr>' +
        '<td class="sym">' + esc(t.displayName || t.symbol) + '</td>' +
        '<td>' + directionTag(t.direction) + '</td>' +
        '<td>' + statusTag(t.status) + '</td>' +
        '<td class="nowrap">' + money(t.stake, cur) + '</td>' +
        '<td class="nowrap ' + cls + '">' + (p === null || p === undefined ? '--' : money(p, cur)) + '</td>' +
        '<td class="nowrap">' + Number(t.score).toFixed(0) + '</td>' +
        '<td class="nowrap muted">' + ago(t.openedAt) + '</td>' +
        '</tr>';
    }).join('');
    return '<table><thead><tr><th>Symbol</th><th>Direction</th><th>Status</th>' +
      '<th>Stake</th><th>P&amp;L</th><th>Score</th><th>Opened</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  // One icon, one label, one accent bar. Never color alone, and never two
  // redundant circles saying the same thing.
  function renderBanner(st) {
    var el = document.getElementById('banner');
    var color, icon, label, text;
    if (st.trading.halted) {
      color = 'var(--critical)'; icon = '&#9888;'; label = 'Halted';
      text = esc(st.trading.haltReason || 'unknown reason') +
        ' &mdash; the bot will not open new positions until it is resumed.';
    } else if (!st.deriv.connected) {
      color = 'var(--warning)'; icon = '&#9888;'; label = 'Disconnected';
      text = 'Lost the Deriv connection &mdash; reconnecting automatically.';
    } else if (st.trading.mode === 'live-real') {
      color = 'var(--critical)'; icon = '&#9888;'; label = 'Live, real money';
      text = 'Placing real orders on funded account ' +
        esc(st.deriv.account ? st.deriv.account.loginId : '') + '.';
    } else if (st.trading.mode === 'live-demo') {
      color = 'var(--warning)'; icon = '&#9679;'; label = 'Live, demo account';
      text = 'Orders are really sent, but no real money is at risk.';
    } else {
      color = 'var(--good)'; icon = '&check;'; label = 'Dry run';
      text = 'Scoring signals only, no orders sent. Set ENABLE_REAL_TRADING=true to arm.';
    }
    el.style.borderLeft = '3px solid ' + color;
    el.innerHTML = '<span class="ico" style="color:' + color + '">' + icon + '</span>' +
      '<span><strong>' + label + '</strong> &mdash; ' + text + '</span>';
  }

  function renderTiles(st) {
    var acc = st.deriv.account;
    var cur = acc ? acc.currency : '';
    var s = st.stats;
    var r = st.risk;
    var html = '';
    html += tile('Balance' + (cur ? ' (' + esc(cur) + ')' : ''),
      acc ? heroNumber(acc.balance) : '--',
      acc ? esc(acc.loginId) + ' &middot; ' + esc(acc.type) : '', '', true);
    html += tile('Net P&L, settled' + (cur ? ' (' + esc(cur) + ')' : ''),
      (s.netProfit > 0 ? '+' : '') + heroNumber(s.netProfit),
      s.won + 'W / ' + s.lost + 'L',
      s.netProfit > 0 ? 'pos' : (s.netProfit < 0 ? 'neg' : ''));
    html += tile('Win rate', s.winRate === null ? '--' : s.winRate + '%',
      (s.won + s.lost) + ' settled');
    html += tile('Open positions', String(s.open),
      'limit ' + r.limits.maxOpenTrades);
    html += tile('Trades today', String(r.tradesToday),
      'limit ' + r.limits.maxTradesPerDay);
    html += tile('Loss streak', String(r.consecutiveLosses),
      'halts at ' + r.limits.maxConsecutiveLosses);
    document.getElementById('tiles').innerHTML = html;
  }

  function load() {
    Promise.all([
      fetch('/api/status').then(function (r) { return r.json(); }),
      fetch('/api/signals?limit=20').then(function (r) { return r.json(); }),
      fetch('/api/trades?limit=20').then(function (r) { return r.json(); }),
      fetch('/api/scans?limit=30').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var st = res[0], sig = res[1], tr = res[2], sc = res[3];
      var cur = st.deriv.account ? st.deriv.account.currency : '';

      document.getElementById('sub').innerHTML =
        esc(st.scanner.symbolCount) + ' symbols &middot; scanning every ' +
        esc(st.scanner.intervalSeconds) + 's &middot; threshold ' +
        esc(st.scanner.minSignalScore) + ' &middot; up ' +
        Math.round(st.uptimeSeconds / 60) + 'm';

      renderBanner(st);
      renderTiles(st);
      document.getElementById('spark').innerHTML =
        sparkline(sc.scans || [], st.scanner.minSignalScore);
      document.getElementById('signals').innerHTML =
        renderSignals(sig.signals || [], st.scanner.minSignalScore);
      document.getElementById('trades').innerHTML =
        renderTrades(tr.trades || [], cur);

      var foot = 'Last scan ' + ago(st.scanner.lastScan ? st.scanner.lastScan.finishedAt : null);
      if (st.lastError) {
        foot += '<div class="err">Last error (' + ago(st.lastError.at) + '): ' +
          esc(st.lastError.message) + '</div>';
      }
      document.getElementById('footer').innerHTML = foot;
    }).catch(function (e) {
      document.getElementById('banner-text').textContent = 'Dashboard cannot reach the API: ' + e.message;
    });
  }

  load();
  setInterval(load, 5000);
})();
</script>
</body>
</html>`;
}
