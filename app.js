/* Dashboard UI. Statement text is untrusted, so it only ever reaches the DOM through textContent. */
(function () {
  'use strict';

  const E = window.BankEngine;
  const S = window.BankSamples;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAGE_SIZE = 25;
  const MAX_PDF_BYTES = 50 * 1024 * 1024;
  let pendingPdf = null;

  const state = { analysis: null, source: '', months: null, query: '', category: '', direction: '', page: 0 };

  /* ---------- helpers ---------- */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  const naira = E.naira;

  function compact(kobo) {
    const n = Math.abs(kobo) / 100;
    const sign = kobo < 0 ? '-' : '';
    if (n >= 1e9) return `${sign}₦${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (n >= 1e6) return `${sign}₦${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${sign}₦${Math.round(n / 1e3)}K`;
    return `${sign}₦${Math.round(n)}`;
  }

  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
  const monthLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const dateLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  const ICONS = {
    good: '<path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    warning: '<path d="M8 2.2l6.5 11.3h-13z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    serious: '<path d="M8 2.2l6.5 11.3h-13z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    critical: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    info: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 7.4v3.4M8 5.1v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };
  const STATUS_VAR = { good: '--good', warning: '--warning', serious: '--serious', critical: '--critical', info: '--muted' };

  function statusIcon(level) {
    const node = svg('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    node.innerHTML = ICONS[level];
    node.style.color = `var(${STATUS_VAR[level]})`;
    return node;
  }

  function status(level, text) {
    return el('span', { class: 'status' }, statusIcon(level), text);
  }

  /* ---------- report sections ---------- */

  function bandLevel(score) {
    if (score.unverified) return 'critical';
    if (score.manualReview) return 'warning';
    return { 'Low risk': 'good', 'Moderate risk': 'warning', 'Elevated risk': 'serious', 'High risk': 'critical' }[score.band];
  }

  function heroCard(a) {
    const s = a.score;
    const m = a.scoring;
    return el('section', { class: 'card', 'aria-label': 'Composite score' },
      el('h2', {}, 'Composite risk score'),
      el('div', {}, el('span', { class: 'hero-value' }, s.score), el('span', { class: 'hero-scale' }, '/ 1000')),
      el('div', { class: 'hero-status' }, status(bandLevel(s), s.unverified ? 'Do not rely on this score' : s.manualReview ? `${s.band} · Manual review` : s.band)),
      s.manualReview && el('ul', { class: 'review-list' }, s.reviewReasons.map((r) => el('li', {}, r))),
      el('p', { class: 'meta' }, `${s.confidence} confidence · ${m.months}-month basis`),
      el('p', { class: 'meta muted' }, `Scorecard ${s.version}`));
  }

  function pillarsCard(a) {
    return el('section', { class: 'card', 'aria-label': 'Score breakdown' },
      el('h2', {}, 'How the score adds up'),
      a.score.pillars.map((p) => {
        if (p.name === 'Risk Penalties') {
          return el('div', { class: 'pillar' },
            el('div', { class: 'pillar-head' }, el('span', {}, p.name), el('span', { class: 'num' }, p.points === 0 ? 'None' : `${p.points} pts`)));
        }
        const fill = el('span', { style: `width:${p.max ? (p.points / p.max) * 100 : 0}%` });
        return el('div', { class: 'pillar' },
          el('div', { class: 'pillar-head' }, el('span', {}, p.name), el('span', { class: 'num' }, `${p.points} / ${p.max}`)),
          el('div', { class: 'meter', role: 'img', 'aria-label': `${p.name}: ${p.points} of ${p.max} points` }, fill));
      }));
  }

  function forensicsCard(a) {
    const f = a.forensics;
    const headline = {
      pass: ['good', 'Balances reconcile'],
      review: ['warning', 'Reconciles, with warnings'],
      fail: ['critical', 'Balance check failed'],
      unverifiable: ['warning', 'Could not be checked'],
    }[f.status];
    const rows = [
      ['Rows checked', `${f.rowsChecked} of ${a.txns.length}`],
      ['Line breaks', f.hasBalance ? f.breaks.length : 'n/a'],
    ];
    if (f.hasBalance) {
      rows.push([`Opening balance (${f.openingSource})`, naira(f.opening)]);
      rows.push(['Credits less debits', naira(f.totalCredits - f.totalDebits)]);
      rows.push(['Closing balance', naira(f.closing)]);
      rows.push(['Unexplained difference', naira(f.totalsDiff)]);
    }
    return el('section', { class: 'card', 'aria-label': 'Statement integrity' },
      el('h2', {}, 'Statement integrity'),
      status(headline[0], headline[1]),
      el('ul', { class: 'check-list' }, rows.map(([k, v]) => el('li', {}, el('span', { class: 'sub' }, k), el('span', { class: 'num' }, v)))),
      f.breaks.slice(0, 3).map((b) => el('p', { class: 'break-row' }, `${b.page ? `Page ${b.page}` : `Line ${b.line}`}, ${dateLabel(b.date)}: "${b.desc}" should leave ${naira(b.expected)}, but shows ${naira(b.actual)}.`)),
      f.breaks.length > 3 && el('p', { class: 'break-row' }, `${f.breaks.length - 3} more line break(s).`),
      f.status === 'fail' && f.source === 'pdf' && !f.likelyMisread && el('p', { class: 'break-row' }, 'Compare these rows with the original PDF to rule out a reading error.'),
      f.document && el('p', { class: 'meta muted' }, `PDF: ${f.document.pages} page(s) · Made with ${[f.document.producer, f.document.creator].filter(Boolean).join(' / ') || 'unknown software'}`),
      f.warnings.length > 0 && el('ul', { class: 'warn-list' }, f.warnings.slice(0, 5).map((w) => el('li', {}, w))),
      (f.status === 'pass' || f.status === 'review') && el('p', { class: 'meta muted' }, 'This shows the arithmetic holds. It does not prove the statement is genuine.'));
  }

  function selectedWindow(a) {
    return a.windows[state.months] || a.scoring;
  }

  function windowControls(a) {
    return el('div', { class: 'section-head' },
      el('h2', {}, 'Cash-flow metrics'),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Trailing window' },
        [3, 6, 12].map((n) => el('button', {
          type: 'button',
          'aria-pressed': state.months === n ? 'true' : 'false',
          disabled: !a.windows[n],
          title: a.windows[n] ? null : 'The statement does not cover this period',
          onclick: () => { state.months = n; render(); },
        }, `${n} mo`))),
      !a.complete && el('span', { class: 'muted small' }, `Showing the ${a.scoring.months}-month period available`));
  }

  function tile(label, value, note) {
    return el('div', { class: 'card' }, el('div', { class: 'tile-label' }, label), el('div', { class: 'tile-value' }, value), el('div', { class: 'tile-note' }, note));
  }

  function kpis(m) {
    const trend = m.balanceTrend === null ? 'Trend not available' : `${m.balanceTrend >= 0 ? '+' : ''}${pct(m.balanceTrend)} across the period`;
    return el('div', { class: 'grid g-kpi' },
      tile('Average daily balance', m.adb === null ? 'n/a' : compact(m.adb), trend),
      tile('Monthly income', compact(m.avgIncome), m.incomeCV === null ? 'None identified' : `Varies ${pct(m.incomeCV)}`),
      tile('FOIR / DTI', pct(m.foir), `${compact(m.avgObligations)} debt service a month`),
      tile('Net cash flow', `${compact(m.avgNet)}`, `Monthly average · swings ${pct(m.netVolatility)} of income`),
      tile('Monthly burn', compact(m.burn), m.netBurn > 0 ? `${compact(m.netBurn)} above inflows` : 'Covered by inflows'),
      tile('Liquidity buffer', m.bufferDays === null ? 'n/a' : `${Math.round(m.bufferDays)} days`, 'Average balance ÷ daily spend'));
  }

  /* ---------- charts ---------- */

  function niceScale(minV, maxV, ticks) {
    const span = maxV - minV || 1;
    const rough = span / ticks;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= rough);
    const min = Math.floor(minV / step) * step;
    const max = Math.ceil(maxV / step) * step;
    const values = [];
    for (let v = min; v <= max + step / 2; v += step) values.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return { min, max, values };
  }

  function axisY(root, scale, y, left, right) {
    scale.values.forEach((v) => {
      root.append(svg('line', { x1: left, x2: right, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
      const label = svg('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--axis-text)', style: 'font-variant-numeric:tabular-nums' });
      label.textContent = compact(v);
      root.append(label);
    });
  }

  function showTooltip(host, tip, x, y, title, rows) {
    tip.replaceChildren(el('b', {}, title), ...rows.map(([color, value, label]) => el('div', {},
      color && el('span', { class: 'tkey', style: `background:var(${color})` }), el('strong', {}, value), ` ${label}`)));
    tip.hidden = false;
    const maxLeft = host.clientWidth - tip.offsetWidth - 4;
    tip.style.left = `${Math.max(4, Math.min(maxLeft, x + 12))}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
  }

  function roundedTop(x, y0, w, y1, r) {
    const up = y1 < y0;
    const radius = Math.min(r, Math.abs(y0 - y1), w / 2);
    if (!radius) return `M${x} ${y0}H${x + w}`;
    const s = up ? 1 : -1;
    return `M${x} ${y0}V${y1 + s * radius}Q${x} ${y1} ${x + radius} ${y1}H${x + w - radius}Q${x + w} ${y1} ${x + w} ${y1 + s * radius}V${y0}Z`;
  }

  function flowChart(m) {
    const host = el('div', { class: 'chart' });
    const tip = el('div', { class: 'tooltip', hidden: true });
    host.append(tip);
    const draw = () => {
      host.querySelector('svg')?.remove();
      const width = Math.max(host.clientWidth, 280);
      const height = 240;
      const left = 52;
      const right = width - 4;
      const top = 8;
      const bottom = height - 24;
      const maxV = Math.max(1, ...m.buckets.flatMap((b) => [b.inflow, b.outflow]));
      const scale = niceScale(0, maxV, 4);
      const y = (v) => bottom - ((v - scale.min) / (scale.max - scale.min)) * (bottom - top);
      const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Monthly inflows and outflows. The table below has every value.' });
      axisY(root, scale, y, left, right);
      const band = (right - left) / m.buckets.length;
      const barW = Math.min(24, Math.max(4, (band - 8) / 2 - 1));
      const skip = band < 34 ? 2 : 1;
      m.buckets.forEach((b, i) => {
        const cx = left + band * i + band / 2;
        const title = `${dateLabel(b.start)} to ${dateLabel(b.end)}`;
        const rows = [['--series-1', naira(b.inflow), 'inflows'], ['--series-2', naira(b.outflow), 'outflows'], [null, naira(b.net), 'net']];
        const hit = svg('rect', { class: 'bar-hit', x: left + band * i, y: top, width: band, height: bottom - top, fill: 'transparent', tabindex: 0, 'aria-label': `${monthLabel(b.end)}: inflows ${naira(b.inflow)}, outflows ${naira(b.outflow)}` });
        const place = () => showTooltip(host, tip, cx, y(Math.max(b.inflow, b.outflow)), title, rows);
        hit.addEventListener('pointermove', place);
        hit.addEventListener('focus', place);
        hit.addEventListener('pointerleave', () => { tip.hidden = true; });
        hit.addEventListener('blur', () => { tip.hidden = true; });
        root.append(hit);
        const group = svg('g', { class: 'bar-mark', 'pointer-events': 'none' });
        group.append(svg('path', { d: roundedTop(cx - barW - 1, bottom, barW, y(b.inflow), 4), fill: 'var(--series-1)' }));
        group.append(svg('path', { d: roundedTop(cx + 1, bottom, barW, y(b.outflow), 4), fill: 'var(--series-2)' }));
        root.append(group);
        if (i % skip === (m.buckets.length - 1) % skip) {
          const label = svg('text', { x: cx, y: height - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--axis-text)' });
          label.textContent = monthLabel(b.end);
          root.append(label);
        }
      });
      host.prepend(root);
    };
    return { host, draw };
  }

  function balanceChart(m) {
    const host = el('div', { class: 'chart' });
    const tip = el('div', { class: 'tooltip', hidden: true });
    host.append(tip);
    const draw = () => {
      host.querySelector('svg')?.remove();
      const width = Math.max(host.clientWidth, 280);
      const height = 240;
      const left = 52;
      const right = width - 62;
      const top = 8;
      const bottom = height - 24;
      const values = m.daily.map((d) => d.balance);
      const scale = niceScale(Math.min(0, ...values), Math.max(1, ...values), 4);
      const y = (v) => bottom - ((v - scale.min) / (scale.max - scale.min)) * (bottom - top);
      const x = (i) => left + (i / Math.max(1, m.daily.length - 1)) * (right - left);
      const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Daily balance over the selected period. The table below has month-end values.' });
      axisY(root, scale, y, left, right);
      const line = m.daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.balance).toFixed(1)}`).join('');
      root.append(svg('path', { d: `${line}L${x(m.daily.length - 1).toFixed(1)} ${y(0)}L${x(0).toFixed(1)} ${y(0)}Z`, fill: 'var(--series-1)', opacity: 0.1 }));
      root.append(svg('path', { d: line, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const lastIndex = m.daily.length - 1;
      root.append(svg('circle', { cx: x(lastIndex), cy: y(values[lastIndex]), r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
      const end = svg('text', { x: x(lastIndex) + 9, y: y(values[lastIndex]) + 4, 'font-size': 12, fill: 'var(--ink)', 'font-weight': 600 });
      end.textContent = compact(values[lastIndex]);
      root.append(end);
      const tickCount = Math.min(m.months, width < 500 ? 3 : 6);
      for (let t = 0; t <= tickCount - 1; t++) {
        const i = Math.round((t / Math.max(1, tickCount - 1)) * lastIndex);
        const label = svg('text', { x: x(i), y: height - 6, 'text-anchor': t === 0 ? 'start' : t === tickCount - 1 ? 'end' : 'middle', 'font-size': 11, fill: 'var(--axis-text)' });
        label.textContent = monthLabel(m.daily[i].date);
        root.append(label);
      }
      const cross = svg('line', { y1: top, y2: bottom, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
      const dot = svg('circle', { r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
      root.append(cross, dot);
      const hit = svg('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: 'transparent' });
      hit.addEventListener('pointermove', (ev) => {
        const box = root.getBoundingClientRect();
        const px = ((ev.clientX - box.left) / box.width) * width;
        const i = Math.max(0, Math.min(lastIndex, Math.round(((px - left) / (right - left)) * lastIndex)));
        cross.setAttribute('x1', x(i));
        cross.setAttribute('x2', x(i));
        cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x(i));
        dot.setAttribute('cy', y(values[i]));
        dot.setAttribute('visibility', 'visible');
        showTooltip(host, tip, x(i), y(values[i]), dateLabel(m.daily[i].date), [['--series-1', naira(values[i]), 'balance']]);
      });
      hit.addEventListener('pointerleave', () => {
        cross.setAttribute('visibility', 'hidden');
        dot.setAttribute('visibility', 'hidden');
        tip.hidden = true;
      });
      root.append(hit);
      host.prepend(root);
    };
    return { host, draw };
  }

  function dataTable(heads, rows) {
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, heads.map((h, i) => el('th', { class: i ? 'num' : null }, h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: i ? 'num' : null }, c)))))));
  }

  const drawers = [];

  function charts(m) {
    const flow = flowChart(m);
    drawers.push(flow.draw);
    const flowCard = el('section', { class: 'card', 'aria-label': 'Monthly cash flow' },
      el('h2', {}, 'Monthly inflows and outflows'),
      el('div', { class: 'legend' },
        el('span', {}, el('i', { style: 'background:var(--series-1)' }), 'Inflows'),
        el('span', {}, el('i', { style: 'background:var(--series-2)' }), 'Outflows')),
      flow.host,
      el('p', { class: 'muted small' }, 'Excludes own-account transfers and loan payouts. Reversals are netted from outflows.'),
      el('details', {}, el('summary', {}, 'View as table'),
        dataTable(['Period end', 'Inflows', 'Outflows', 'Net'], m.buckets.map((b) => [dateLabel(b.end), naira(b.inflow), naira(b.outflow), naira(b.net)]))));

    let balanceCard;
    if (m.daily) {
      const bal = balanceChart(m);
      drawers.push(bal.draw);
      const monthEnds = m.buckets.map((b) => m.daily.find((d) => d.date === b.end)).filter(Boolean);
      balanceCard = el('section', { class: 'card', 'aria-label': 'Daily balance' },
        el('h2', {}, 'Daily closing balance'),
        bal.host,
        el('p', { class: 'muted small' }, 'The last balance carries forward on days with no transactions.'),
        el('details', {}, el('summary', {}, 'View as table'),
          dataTable(['Period end', 'Balance'], monthEnds.map((d) => [dateLabel(d.date), naira(d.balance)]))));
    } else {
      balanceCard = el('section', { class: 'card' }, el('h2', {}, 'Daily closing balance'), el('p', { class: 'sub' }, 'This statement has no balance column.'));
    }
    return el('div', { class: 'grid g-2' }, flowCard, balanceCard);
  }

  /* ---------- reasons and flags ---------- */

  function reasonsCard(a) {
    const rows = a.score.reasons;
    const row = (r) => el('div', { class: 'reason' },
      el('div', {}, el('span', { class: 'code' }, r.code), el('strong', {}, r.label), el('div', { class: 'sub small' }, r.detail)),
      el('div', { class: 'num' }, r.max ? `${r.points} / ${r.max}` : `${r.points}`));
    return el('section', { class: 'card', 'aria-label': 'Reason codes' },
      el('h2', {}, 'Reason codes'),
      el('p', { class: 'muted small' }, 'Sorted by points lost, so the biggest drivers come first.'),
      rows.map(row));
  }

  function buildFlags(a) {
    const r = a.risk;
    const flags = [];
    const add = (level, title, detail) => flags.push({ level, title, detail });
    const dates = (rows) => rows.slice(0, 4).map((t) => dateLabel(t.date)).join(', ') + (rows.length > 4 ? ` and ${rows.length - 4} more` : '');

    if (r.gsiRecoveries.length) add('critical', 'GSI recovery', `${r.gsiRecoveries.length} recovery debit(s): ${dates(r.gsiRecoveries)}.`);
    if (r.bounceEvents) {
      const parts = [];
      if (r.failedDebits.length) parts.push(`${r.failedDebits.length} failed direct debit row(s)`);
      if (r.nsfFees.length) parts.push(`${r.nsfFees.length} NSF or return fee(s)`);
      if (r.bouncedInstruments.length) parts.push(`${r.bouncedInstruments.length} returned cheque(s)`);
      add('critical', `${r.bounceEvents} failed-payment event(s)`, `${parts.join(', ')}.`);
    }
    if (r.stacking.length) {
      const first = r.stacking[0];
      add('serious', 'Loan cash before repayment', `${r.stacking.length} digital-loan payout(s) arrived within ${E.CONFIG.stackingDays} days before a debt payment. For example, ${naira(first.payout.credit)} from ${first.payout.merchant} on ${dateLabel(first.payout.date)}, then ${naira(first.debit.debit)} to ${first.debit.merchant} on ${dateLabel(first.debit.date)}.`);
    }
    if (r.roundTrips.length) {
      const first = r.roundTrips[0];
      add('serious', 'Circular money movement', `${r.roundTrips.length} send-and-return pair(s). For example, ${naira(first.out.debit)} to ${first.merchant} on ${dateLabel(first.out.date)}, with ${naira(first.back.credit)} back on ${dateLabel(first.back.date)}.`);
    }
    if (r.overdraftEpisodes) add('serious', 'Overdrawn balance', `${r.overdraftEpisodes} episode(s), ${r.daysNegative} day(s) below zero.`);
    if (r.lenders.length) add(r.lenders.length > E.CONFIG.penalties.manyLenders.freeCount ? 'serious' : 'info', `${r.lenders.length} digital lender(s)`, r.lenders.join(', '));
    if (r.bettingTotal > 0) {
      const high = r.bettingShare !== null && r.bettingShare >= E.CONFIG.bettingShareWarn;
      const share = r.bettingShare === null ? '' : `, about ${pct(r.bettingShare)} of monthly income`;
      add(high ? 'warning' : 'info', 'Betting spend', `${naira(r.bettingTotal)} across ${r.betting.length} payment(s)${share}. Shown for review and not scored.`);
    }
    const inferred = a.txns.filter((t) => t.inferred);
    if (inferred.length) {
      const names = [...new Set(inferred.map((t) => t.merchant))].slice(0, 3).join(', ');
      add('info', 'Income inferred from regular transfers', `${inferred.length} credit(s) from ${names} count as income because the sender pays regularly. Please confirm.`);
    }
    const unknown = a.txns.filter((t) => t.category === E.CAT.UNKNOWN_IN).reduce((s, t) => s + t.credit, 0);
    if (unknown > 0) add('info', 'Unclassified inflows', `${naira(unknown)} is not counted as income. Add it manually if it can be evidenced.`);
    return flags;
  }

  function flagsCard(a) {
    const flags = buildFlags(a);
    return el('section', { class: 'card', 'aria-label': 'Risk flags' },
      el('h2', {}, 'Risk flags'),
      flags.length === 0 ? status('good', 'No risk indicators found') : flags.map((f) => el('div', { class: 'flag' }, status(f.level, f.title), el('p', {}, f.detail))));
  }

  /* ---------- transactions ---------- */

  function transactionsCard(a) {
    const tbody = el('tbody');
    const countLabel = el('span', { class: 'muted small' });
    const prev = el('button', { type: 'button', onclick: () => { state.page--; fill(); } }, 'Previous');
    const next = el('button', { type: 'button', onclick: () => { state.page++; fill(); } }, 'Next');

    function fill() {
      const q = state.query.trim().toLowerCase();
      const rows = a.txns.filter((t) => (!state.category || t.category === state.category)
        && (!state.direction || (state.direction === 'in' ? t.credit > 0 : t.debit > 0))
        && (!q || t.desc.toLowerCase().includes(q) || t.merchant.toLowerCase().includes(q))).reverse();
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      state.page = Math.max(0, Math.min(state.page, pages - 1));
      const slice = rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
      tbody.replaceChildren(...slice.map((t) => el('tr', {},
        el('td', { style: 'white-space:nowrap' }, dateLabel(t.date)),
        el('td', { class: 'desc-cell' }, t.desc),
        el('td', {}, t.merchant),
        el('td', {}, t.category, t.inferred && el('span', { class: 'tag' }, 'inferred')),
        el('td', { class: 'num' }, t.debit ? naira(t.debit) : ''),
        el('td', { class: 'num' }, t.credit ? naira(t.credit) : ''),
        el('td', { class: 'num' }, t.balance === null ? '' : naira(t.balance)))));
      if (!slice.length) tbody.replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No transactions match these filters.')));
      countLabel.textContent = `${rows.length} transaction(s) · Page ${state.page + 1} of ${pages}`;
      prev.disabled = state.page === 0;
      next.disabled = state.page >= pages - 1;
    }

    const categories = [...new Set(a.txns.map((t) => t.category))].sort();
    const filters = el('div', { class: 'filters' },
      el('input', { type: 'search', placeholder: 'Search narration or merchant', 'aria-label': 'Search transactions', value: state.query, oninput: (e) => { state.query = e.target.value; state.page = 0; fill(); } }),
      el('select', { 'aria-label': 'Filter by category', onchange: (e) => { state.category = e.target.value; state.page = 0; fill(); } },
        el('option', { value: '' }, 'All categories'), categories.map((c) => el('option', { value: c, selected: state.category === c }, c))),
      el('select', { 'aria-label': 'Filter by direction', onchange: (e) => { state.direction = e.target.value; state.page = 0; fill(); } },
        el('option', { value: '' }, 'Money in and out'),
        el('option', { value: 'in', selected: state.direction === 'in' }, 'Money in'),
        el('option', { value: 'out', selected: state.direction === 'out' }, 'Money out')));
    fill();
    return el('section', { class: 'card', 'aria-label': 'Transactions' },
      el('h2', {}, 'Transactions'),
      filters,
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['Date', 'Narration', 'Merchant', 'Category'].map((h) => el('th', {}, h)), ['Debit', 'Credit', 'Balance'].map((h) => el('th', { class: 'num' }, h)))),
        tbody)),
      el('div', { class: 'pager' }, countLabel, el('span', { class: 'intake-actions' }, prev, next)));
  }

  /* ---------- render and input ---------- */

  function render() {
    const a = state.analysis;
    const report = document.getElementById('report');
    drawers.length = 0;
    if (!a) {
      report.hidden = true;
      return;
    }
    const m = selectedWindow(a);
    report.replaceChildren(
      el('p', { class: 'sample-tag sub small' }, `${state.source} · ${a.txns.length} transactions · ${dateLabel(a.txns[0].date)} to ${dateLabel(a.txns[a.txns.length - 1].date)}`),
      el('div', { class: 'grid g-hero' }, heroCard(a), pillarsCard(a), forensicsCard(a)),
      windowControls(a),
      kpis(m),
      charts(m),
      el('div', { class: 'grid g-2' }, reasonsCard(a), flagsCard(a)),
      el('div', { class: 'grid' }, transactionsCard(a)));
    report.hidden = false;
    drawers.forEach((d) => d());
  }

  function load(text, source) {
    const error = document.getElementById('error');
    try {
      const analysis = E.analyze(text);
      state.analysis = analysis;
      state.source = source;
      state.months = analysis.complete ? analysis.scoring.months : null;
      state.query = '';
      state.category = '';
      state.direction = '';
      state.page = 0;
      error.hidden = true;
      render();
    } catch (err) {
      showError(err.message);
    }
  }

  function showError(message) {
    const error = document.getElementById('error');
    state.analysis = null;
    render();
    error.textContent = message;
    error.hidden = false;
  }

  function setBusy(message) {
    const busy = document.getElementById('busy');
    busy.textContent = message || '';
    busy.hidden = !message;
  }

  function askPassword(file, wrong) {
    const form = document.getElementById('pdf-password');
    pendingPdf = file;
    document.getElementById('pdf-password-label').textContent = wrong
      ? `That password did not open ${file.name}. Try again.`
      : `${file.name} is password-protected. Enter its password to open it here.`;
    document.getElementById('pdf-password-input').value = '';
    form.hidden = false;
    document.getElementById('pdf-password-input').focus();
  }

  function closePassword() {
    pendingPdf = null;
    document.getElementById('pdf-password-input').value = '';
    document.getElementById('pdf-password').hidden = true;
  }

  async function loadPdf(file, password) {
    closePassword();
    document.getElementById('error').hidden = true;
    setBusy(`Reading ${file.name}…`);
    try {
      // Yield first so the message paints; PDF.js runs on the page's thread here.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const extracted = await window.BankPdf.read(await file.arrayBuffer(), password);
      load(extracted, file.name);
    } catch (err) {
      if (err.code === 'needs-password' || err.code === 'wrong-password') {
        state.analysis = null;
        render();
        askPassword(file, err.code === 'wrong-password');
      } else {
        showError(err.code ? err.message : `${file.name} could not be read. Check the file and try again.`);
      }
    } finally {
      setBusy('');
    }
  }

  function loadFile(file) {
    if (!file) return;
    closePassword();
    if (/\.pdf$/i.test(file.name)) {
      if (file.size > MAX_PDF_BYTES) {
        showError(`${file.name} is larger than the 50 MB limit.`);
        return;
      }
      loadPdf(file);
      return;
    }
    if (/\.(xlsx?|docx?|png|jpe?g|tiff?)$/i.test(file.name)) {
      showError(`${file.name} can't be read yet. Upload the original PDF from the bank, or a CSV.`);
      return;
    }
    file.text().then((text) => load(text, file.name)).catch(() => showError(`${file.name} could not be read. Check the file and try again.`));
  }

  document.getElementById('pdf-password').addEventListener('submit', (e) => {
    e.preventDefault();
    const password = document.getElementById('pdf-password-input').value;
    if (pendingPdf && password) loadPdf(pendingPdf, password);
  });
  document.getElementById('pdf-password-cancel').addEventListener('click', closePassword);

  function loadSample(sample) {
    closePassword();
    load(S.build(sample.key), `Synthetic sample: ${sample.label}`);
  }

  S.list.forEach((sample) => {
    document.getElementById('samples').append(el('button', { type: 'button', onclick: () => loadSample(sample) }, sample.label));
  });

  const fileInput = document.getElementById('file');
  fileInput.addEventListener('change', () => {
    loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  const intake = document.getElementById('intake');
  ['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (e) => { e.preventDefault(); intake.classList.add('drag'); }));
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) intake.classList.remove('drag'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    intake.classList.remove('drag');
    loadFile(e.dataTransfer.files[0]);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawers.forEach((d) => d()), 120);
  });

  const hashSample = /sample=(\w+)/.exec(location.hash);
  if (hashSample) {
    const sample = S.list.find((s) => s.key === hashSample[1]);
    if (sample) loadSample(sample);
  }
})();
