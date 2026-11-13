/* Statement analysis and scoring engine for Nigerian bank statements (CSV).
   No DOM access. All money is held as integer kobo to avoid float drift. */
(function (root) {
  'use strict';

  const CONFIG = {
    scorecardVersion: 'ng-retail-mini-0.1',
    toleranceKobo: 1,
    misreadMinBreaks: 3,
    misreadBreakShare: 0.1,
    maxGapDays: 45,
    windowGraceDays: 7,
    recurringMinMonths: 3,
    recurringMinKobo: 2000000, // N20,000
    recurringMaxPaidBackShare: 0.5,
    roundTrip: { minKobo: 10000000, maxDays: 3, amountTolerance: 0.02, minPairs: 2 }, // N100,000
    stackingDays: 5,
    bettingShareWarn: 0.1,
    // lin(value, worst, best): value at `worst` earns 0 points, at `best` earns all.
    weights: {
      incomeRegularity: { max: 150, worst: 0.5, best: 1 },
      incomeVariability: { max: 150, worst: 0.6, best: 0.1 },
      foir: { max: 300, worst: 0.7, best: 0.33 },
      bufferDays: { max: 150, worst: 0, best: 60 },
      netVolatility: { max: 100, worst: 1, best: 0.2 },
      netMargin: { max: 100, worst: -0.1, best: 0.2 },
      balanceTrend: { max: 50, worst: -0.5, best: 0 },
    },
    penalties: {
      bounce: { each: 40, cap: 200 },
      overdraft: { each: 15, cap: 75 },
      stacking: { each: 50, cap: 100 },
      roundTrip: { each: 50, cap: 100 },
      gsi: { each: 100, cap: 200 },
      manyLenders: { each: 25, cap: 75, freeCount: 2 },
    },
    bands: [
      { min: 750, label: 'Low risk' },
      { min: 600, label: 'Moderate risk' },
      { min: 400, label: 'Elevated risk' },
      { min: 0, label: 'High risk' },
    ],
  };

  const CAT = {
    REVENUE: 'Inflows: Operating Revenue',
    XFER_IN: 'Inflows: Transfers',
    TAX: 'Inflows: Tax Refunds',
    LOAN: 'Inflows: Loan Payouts',
    REVERSAL: 'Inflows: Reversals',
    UNKNOWN_IN: 'Inflows: Unclassified',
    OPEX: 'Operational Expenses',
    DEBT: 'Debt Service',
    UTIL: 'Utilities',
    PAYROLL: 'Payroll',
    DISC: 'Discretionary Spend',
    FEES: 'Bank Charges & Penalties',
    XFER_OUT: 'Transfers: Own Account',
    UNKNOWN_OUT: 'Outflows: Unclassified',
  };

  const LENDER_RE = /FAIRMONEY|FAIR MONEY|CARBON|PAYLATER|BRANCH (INTL|INTERNATIONAL|LOAN)|PALMCREDIT|PALM CREDIT|OKASH|RENMONEY|QUICKCHECK|AELLA|LENDIGO|SOKOLOAN|XCREDIT|NEWCREDIT|EASEMONI|LCREDIT|KIAKIA|ZEDVANCE|MIGO\b/;
  const OWN_RE = /OWN ACC|SELF TRANSFER|\bSELF\b|SWEEP|BETWEEN MY ACC/;
  const BETTING_RE = /BET9JA|SPORTYBET|BETKING|1XBET|NAIRABET|MSPORT|BETWAY|MERRYBET/;
  const UTILITY_RE = /IKEDC|EKEDC|AEDC|PHED|IBEDC|EEDC|KEDCO|\bJED\b|\bBEDC\b|KAEDCO|YEDC|NEPA|PREPAID METER|ELECTRIC|DSTV|GOTV|STARTIMES|\bMTN\b|AIRTEL|\bGLO\b|9MOBILE|\bT2\b|SPECTRANET|SMILE|AIRTIME|\bDATA\b|WATER|LAWMA/;
  const DISC_RE = /SHOPRITE|JUMIA|KONGA|CHICKEN REPUBLIC|DOMINO|KFC|BOLT|UBER|NETFLIX|SPOTIFY|RESTAURANT|LOUNGE|\bBAR\b|SUPERMARKET|EATERY|\bPOS\b|\bATM\b/;

  const BRANDS = [
    [/\bGSI\b|GLOBAL STANDING/, 'GSI recovery'], [/FAIRMONEY|FAIR MONEY/, 'FairMoney'], [/CARBON|PAYLATER/, 'Carbon'], [/PALMCREDIT|PALM CREDIT/, 'PalmCredit'],
    [/OKASH/, 'OKash'], [/RENMONEY/, 'Renmoney'], [/QUICKCHECK/, 'QuickCheck'], [/BRANCH (INTL|INTERNATIONAL|LOAN)/, 'Branch'],
    [/IKEDC/, 'Ikeja Electric'], [/EKEDC/, 'Eko Electric'], [/AEDC/, 'Abuja Electric'], [/DSTV/, 'DStv'], [/GOTV/, 'GOtv'],
    [/\bMTN\b/, 'MTN'], [/AIRTEL/, 'Airtel'], [/\bGLO\b/, 'Glo'], [/9MOBILE|\bT2\b/, '9mobile'], [/SPECTRANET/, 'Spectranet'],
    [/SHOPRITE/, 'Shoprite'], [/JUMIA/, 'Jumia'], [/KONGA/, 'Konga'], [/CHICKEN REPUBLIC/, 'Chicken Republic'],
    [/\bBOLT\b/, 'Bolt'], [/\bUBER\b/, 'Uber'], [/NETFLIX/, 'Netflix'], [/BET9JA/, 'Bet9ja'], [/SPORTYBET/, 'SportyBet'],
    [/BETKING/, 'BetKing'], [/PAYSTACK/, 'Paystack'], [/FLUTTERWAVE/, 'Flutterwave'], [/MONIEPOINT/, 'Moniepoint'],
  ];
  const BANK_CODE_RE = /^(GTB|GTBANK|UBA|ZENITH|ZENITH BANK|ACCESS|ACCESS BANK|FBN|FIRST BANK|FIRSTBANK|STANBIC|FCMB|FIDELITY|ECOBANK|STERLING|UNION BANK|WEMA|POLARIS|KUDA|OPAY|PALMPAY)$/;
  // RSVL / RVSL / RTN are FCMB-style abbreviations for a reversal or a returned transfer.
  const REVERSAL_RE = /REVERS|RETURN|BOUNCE|UNPAID|REFUND OF|FAILED|\bRSVL\b|\bRVSL\b|\bRTN\b/;
  const BANK_ITEM_RE = /CHARGE|\bFEES?\b|COMMISSION|\bVAT\b|STAMP DUTY|EMTL|\bLEVY\b/;
  // Transfer narrations name the other party after FRM/FROM (or TO), ending at the first / | : or -.
  const SENDER_RE = /\b(?:FRM|FROM)\s+([^\/|:-]+)/;
  const RECIPIENT_RE = /\bTO\s+([^\/|:-]+)/;
  const TRAILING_NOISE_RE = /\s+(NIP|NPS|TRF|TFR|TRANSFER|MOBILE|MOB|REF|ONB|UIP|IFO|PAYMENT|VIA)$/;
  const NOISE_RE = /\b(NIP|NPS|COP|NEFT|FRM|IFO|UIP|ONB|MOB|RTN|RSVL|RVSL|NIBSS|TRF|TFR|TRANSFER|FROM|TO|POS|WEB|PURCHASE|USSD|MOBILE|APP|ATM|WDL|WITHDRAWAL|REF|INWARD|OUTWARD|PAYMENT|PYMT|VIA|FT|CIP|ONLINE|BILLS?|FOR|RENT|DD|REMITA|DIRECT|DEBIT|CREDIT|SALARY|LOAN|REPAYMENT|DISBURSEMENT|LANG|NG|NGA|LAGOS|ABUJA|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g;

  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const MS_PER_DAY = 86400000;
  const DAYS_PER_MONTH = 30.44;

  /* ---------- dates ---------- */

  function toDay(y, m, d) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return date.getTime() / MS_PER_DAY;
  }

  function dayToISO(day) {
    return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
  }

  function addMonths(day, n) {
    const d = new Date(day * MS_PER_DAY);
    const monthIndex = d.getUTCMonth() + n;
    const lastOfTarget = new Date(Date.UTC(d.getUTCFullYear(), monthIndex + 1, 0)).getUTCDate();
    return Date.UTC(d.getUTCFullYear(), monthIndex, Math.min(d.getUTCDate(), lastOfTarget)) / MS_PER_DAY;
  }

  function fullYear(y) {
    return y < 100 ? 2000 + y : y;
  }

  // Nigerian statements are day-first; month-first is only used when the data proves it.
  function detectDateOrder(strings) {
    let firstOver12 = false;
    let secondOver12 = false;
    strings.forEach((s) => {
      const m = /^\s*(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{2,4}/.exec(s || '');
      if (!m) return;
      if (+m[1] > 12) firstOver12 = true;
      if (+m[2] > 12) secondOver12 = true;
    });
    return secondOver12 && !firstOver12 ? 'MDY' : 'DMY';
  }

  function parseDate(str, order) {
    const s = String(str || '').trim();
    let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
    if (m) return toDay(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-\s\/.]([A-Za-z]{3})[A-Za-z]*[-\s\/.,]+(\d{2,4})(?:[T\s].*)?$/.exec(s);
    if (m) {
      const month = MONTHS[m[2].toUpperCase()];
      return month ? toDay(fullYear(+m[3]), month, +m[1]) : null;
    }
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})(?:[T\s].*)?$/.exec(s);
    if (m) {
      return order === 'MDY' ? toDay(fullYear(+m[3]), +m[1], +m[2]) : toDay(fullYear(+m[3]), +m[2], +m[1]);
    }
    return null;
  }

  /* ---------- CSV and money ---------- */

  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
    let best = ',';
    let bestCount = -1;
    [',', ';', '\t'].forEach((d) => {
      const count = sample.split(d).length - 1;
      if (count > bestCount) {
        best = d;
        bestCount = count;
      }
    });
    return best;
  }

  function parseCSV(text) {
    const delimiter = detectDelimiter(text);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') {
          quoted = false;
        } else {
          cell += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === delimiter) {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (c !== '\r') {
        cell += c;
      }
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  // Returns kobo, null for blank, or NaN for text that is not an amount.
  function parseMoney(value) {
    let s = String(value == null ? '' : value).trim().toUpperCase();
    if (s === '' || s === '-' || s === '--') return null;
    let sign = 1;
    if (/\bDR\.?$/.test(s)) sign = -1;
    s = s.replace(/\b(DR|CR)\.?$/, '').replace(/₦|NGN|NAIRA|[,\s]/g, '');
    if (/^\(.*\)$/.test(s)) {
      sign = -sign;
      s = s.slice(1, -1);
    }
    if (s.endsWith('-')) {
      sign = -sign;
      s = s.slice(0, -1);
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return sign * Math.round(parseFloat(s) * 100);
  }

  /* ---------- statement parsing ---------- */

  const HEADERS = {
    date: ['trans date', 'transaction date', 'txn date', 'tran date', 'trans time', 'transaction time', 'date time', 'posted date', 'post date', 'posting date', 'date posted', 'date', 'value date'],
    desc: ['narration', 'description', 'transaction description', 'transaction details', 'transaction remarks', 'details', 'narrative', 'remarks', 'particulars', 'reference'],
    debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'dr'],
    credit: ['credit', 'credits', 'credit amount', 'lodgement', 'lodgements', 'deposit', 'deposits', 'deposit amount', 'money in', 'cr'],
    amount: ['amount', 'transaction amount', 'txn amount'],
    type: ['dr cr', 'cr dr', 'd c', 'type', 'transaction type', 'txn type'],
    balance: ['balance', 'balance after', 'running balance', 'closing balance', 'ledger balance', 'available balance', 'book balance'],
  };

  function normalizeHeader(h) {
    return String(h).toLowerCase().replace(/[^a-z]+/g, ' ').trim().replace(/\s+(ngn|naira)$/, '');
  }

  function mapColumns(cells) {
    const normalized = cells.map(normalizeHeader);
    const map = {};
    Object.keys(HEADERS).forEach((key) => {
      for (const alias of HEADERS[key]) {
        const idx = normalized.indexOf(alias);
        if (idx !== -1) {
          map[key] = idx;
          return;
        }
      }
    });
    const hasAmounts = map.amount !== undefined || (map.debit !== undefined && map.credit !== undefined);
    return map.date !== undefined && map.desc !== undefined && hasAmounts ? map : null;
  }

  function parseStatement(text) {
    return parseRows(parseCSV(String(text).replace(/^﻿/, '')));
  }

  // pageOf is optional and parallel to rows; PDF rows use it to point back to the source page.
  function parseRows(rows, pageOf) {
    let headerIndex = -1;
    let columns = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      columns = mapColumns(rows[i]);
      if (columns) {
        headerIndex = i;
        break;
      }
    }
    if (!columns) {
      throw new Error('Could not find a header row. The file needs date and narration columns, plus debit and credit columns or an amount column.');
    }

    const dataRows = rows.slice(headerIndex + 1);
    const order = detectDateOrder(dataRows.map((r) => r[columns.date]));
    const txns = [];
    const rejected = [];
    let declaredOpening = null;
    let declaredClosing = null;

    dataRows.forEach((cells, offset) => {
      const line = headerIndex + offset + 2;
      const page = pageOf ? pageOf[headerIndex + offset + 1] : null;
      if (cells.every((c) => String(c).trim() === '')) return;
      const joined = cells.join(' ').toUpperCase();
      const balance = columns.balance === undefined ? null : parseMoney(cells[columns.balance]);
      const rawDebit = columns.debit === undefined ? null : parseMoney(cells[columns.debit]);
      const rawCredit = columns.credit === undefined ? null : parseMoney(cells[columns.credit]);
      const rawAmount = columns.amount === undefined ? null : parseMoney(cells[columns.amount]);
      const hasMovement = !!(rawDebit || rawCredit || rawAmount);

      if (!hasMovement && /OPENING BAL|BAL(ANCE)? B\/?F|BROUGHT FORWARD/.test(joined)) {
        if (Number.isFinite(balance)) declaredOpening = balance;
        return;
      }
      if (!hasMovement && /CLOSING BAL|BAL(ANCE)? C\/?F|CARRIED FORWARD/.test(joined)) {
        if (Number.isFinite(balance)) declaredClosing = balance;
        return;
      }
      if (/^\s*(SUB-?\s?)?TOTALS?\b/.test(joined)) return;

      const day = parseDate(cells[columns.date], order);
      if (day === null) {
        if (hasMovement) rejected.push({ line, page, reason: 'Unreadable date' });
        return;
      }
      if ([rawDebit, rawCredit, rawAmount, balance].some(Number.isNaN)) {
        rejected.push({ line, page, reason: 'Unreadable amount' });
        return;
      }

      let debit = rawDebit === null ? 0 : Math.abs(rawDebit);
      let credit = rawCredit === null ? 0 : Math.abs(rawCredit);
      if (rawDebit === null && rawCredit === null && rawAmount !== null) {
        const type = columns.type === undefined ? '' : String(cells[columns.type]).trim().toUpperCase();
        const isDebit = /^D/.test(type) || (!/^C/.test(type) && rawAmount < 0);
        debit = isDebit ? Math.abs(rawAmount) : 0;
        credit = isDebit ? 0 : Math.abs(rawAmount);
      }
      if (debit && credit) {
        rejected.push({ line, page, reason: 'Both debit and credit filled' });
        return;
      }
      if (!debit && !credit) return;

      txns.push({ line, page, day, date: dayToISO(day), desc: String(cells[columns.desc] || '').trim(), debit, credit, balance });
    });

    if (!txns.length) throw new Error('No transactions could be read from this file.');
    if (txns.length > 1 && txns[0].day > txns[txns.length - 1].day) txns.reverse();
    return { txns, rejected, declaredOpening, declaredClosing, dateOrder: order };
  }

  /* ---------- forensics ---------- */

  function runForensics(parsed, context) {
    const { txns, rejected, declaredOpening, declaredClosing } = parsed;
    const { warnings: documentWarnings = [], source = 'csv', document = null } = context || {};
    const tolerance = CONFIG.toleranceKobo;
    const hasBalance = txns.some((t) => t.balance !== null);
    const missingBalanceRows = txns.filter((t) => t.balance === null).length;
    const breaks = [];
    const warnings = [];
    const totalCredits = txns.reduce((s, t) => s + t.credit, 0);
    const totalDebits = txns.reduce((s, t) => s + t.debit, 0);

    rejected.forEach((r) => warnings.push(`${r.page ? `A row on page ${r.page}` : `Line ${r.line}`} could not be read: ${r.reason}.`));
    warnings.push(...documentWarnings);

    let opening = declaredOpening;
    let openingSource = 'declared';
    if (opening === null && txns[0].balance !== null) {
      opening = txns[0].balance - txns[0].credit + txns[0].debit;
      openingSource = 'derived';
    }

    let closing = null;
    let totalsDiff = null;
    if (hasBalance) {
      let running = opening;
      txns.forEach((t) => {
        if (running === null) {
          running = t.balance;
          return;
        }
        const expected = running + t.credit - t.debit;
        if (t.balance !== null && Math.abs(expected - t.balance) > tolerance) {
          breaks.push({ line: t.line, page: t.page, date: t.date, desc: t.desc, expected, actual: t.balance, diff: t.balance - expected });
        }
        running = t.balance === null ? expected : t.balance;
      });
      const lastWithBalance = [...txns].reverse().find((t) => t.balance !== null);
      closing = declaredClosing !== null ? declaredClosing : lastWithBalance.balance;
      totalsDiff = closing - (opening + totalCredits - totalDebits);
      if (declaredClosing !== null && Math.abs(declaredClosing - lastWithBalance.balance) > tolerance) {
        warnings.push('The declared closing balance does not match the last transaction balance.');
      }
    }

    const outOfOrder = txns.filter((t, i) => i > 0 && t.day < txns[i - 1].day).length;
    if (outOfOrder) warnings.push(`${outOfOrder} row(s) are out of date order.`);

    const seen = new Set();
    let duplicates = 0;
    txns.forEach((t) => {
      const key = [t.day, t.desc, t.debit, t.credit, t.balance].join('|');
      if (seen.has(key)) duplicates++;
      seen.add(key);
    });
    if (duplicates) warnings.push(`${duplicates} exact duplicate row(s), including the same balance.`);

    const gaps = [];
    const sortedDays = txns.map((t) => t.day).sort((a, b) => a - b);
    sortedDays.forEach((d, i) => {
      if (i && d - sortedDays[i - 1] > CONFIG.maxGapDays) gaps.push({ from: dayToISO(sortedDays[i - 1]), to: dayToISO(d), days: d - sortedDays[i - 1] });
    });
    gaps.forEach((g) => warnings.push(`No transactions for ${g.days} days (${g.from} to ${g.to}); pages may be missing.`));
    if (hasBalance && missingBalanceRows) warnings.push(`${missingBalanceRows} row(s) have no balance and could not be checked.`);

    const totalsFail = totalsDiff !== null && Math.abs(totalsDiff) > tolerance;
    let status = 'pass';
    if (!hasBalance) status = 'unverifiable';
    else if (breaks.length || totalsFail) status = 'fail';
    else if (warnings.length) status = 'review';

    // Widespread breaks in a PDF point to a misread layout more than to tampering.
    const likelyMisread = source === 'pdf' && breaks.length >= Math.max(CONFIG.misreadMinBreaks, txns.length * CONFIG.misreadBreakShare);

    return { status, source, document, likelyMisread, hasBalance, opening, openingSource, closing, totalCredits, totalDebits, totalsDiff, breaks, warnings, rowsChecked: hasBalance ? txns.length - missingBalanceRows : 0 };
  }

  /* ---------- enrichment ---------- */

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s&'-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }

  // Normalises a transfer counterparty so the same sender always gets the same name:
  // "SEVEN OCEANS OIL AND GAS LTD" and "SEVEN OCEANS OIL GAS LTD", or "NIG. LIMITED" and a
  // truncated "NIG. LIM", come out identical.
  function partyName(upper) {
    const m = SENDER_RE.exec(upper) || RECIPIENT_RE.exec(upper);
    if (!m) return null;
    let name = m[1].replace(/\d+/g, ' ').replace(/[^A-Z' ]/g, ' ').replace(/\bAND\b/g, ' ').replace(/\s+/g, ' ').trim();
    name = name.replace(/\bNIG[A-Z]*\b/g, 'NIG').replace(/\bL(I(M(I(T(E(D)?)?)?)?)?)?$/, 'LTD');
    while (TRAILING_NOISE_RE.test(name)) name = name.replace(TRAILING_NOISE_RE, '');
    if (name.replace(/[^A-Z]/g, '').length < 3 || BANK_CODE_RE.test(name)) return null;
    return titleCase(name);
  }

  function extractMerchant(desc) {
    const upper = String(desc || '').toUpperCase();
    for (const [re, name] of BRANDS) if (re.test(upper)) return name;
    const party = partyName(upper);
    if (party) return party;
    const candidates = upper.split(/[\/|:_*]+|\s-\s/)
      .map((seg) => seg.replace(/\S*\d\S*/g, ' ').replace(NOISE_RE, ' ').replace(/[^A-Z&' -]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((seg) => seg.replace(/[^A-Z]/g, '').length >= 3);
    const pick = candidates.find((c) => !BANK_CODE_RE.test(c)) || candidates[0];
    if (!pick) return 'Unknown';
    return titleCase(pick);
  }

  function classify(desc, isCredit) {
    const u = String(desc || '').toUpperCase();
    if (isCredit) {
      if (REVERSAL_RE.test(u)) return CAT.REVERSAL;
      if (/TAX REFUND|FIRS|LIRS|TAX CREDIT/.test(u)) return CAT.TAX;
      if (/LOAN (DISB|PAYOUT|CREDIT|GRANT)|DISBURS/.test(u) || LENDER_RE.test(u)) return CAT.LOAN;
      if (OWN_RE.test(u)) return CAT.XFER_IN;
      if (/SALAR|PAYROLL|\bSAL\b|WAGES|IPPIS|PENSION|STIPEND|SETTLEMENT|INVOICE|PAYSTACK|FLUTTERWAVE|MONIEPOINT|COMMISSION EARNED/.test(u)) return CAT.REVENUE;
      return CAT.UNKNOWN_IN;
    }
    if (/SCHOOL FEES|TUITION/.test(u)) return CAT.OPEX;
    if (/INSUFFICIENT|\bNSF\b|CHARGE|\bFEES?\b|COMMISSION|\bVAT\b|STAMP DUTY|EMTL|SMS ALERT|MAINTENANCE|\bCOT\b|\bLEVY\b/.test(u)) return CAT.FEES;
    if (/\bLOAN\b|REPAY|INSTAL+MENT|MORTGAGE|\bGSI\b|GLOBAL STANDING|\bEMI\b/.test(u) || LENDER_RE.test(u)) return CAT.DEBT;
    if (/STAFF SALAR|SALARY|PAYROLL|WAGES/.test(u)) return CAT.PAYROLL;
    if (OWN_RE.test(u)) return CAT.XFER_OUT;
    if (UTILITY_RE.test(u)) return CAT.UTIL;
    if (/\bRENT\b|SUPPLIER|INVENTORY|\bSTOCK\b|DIESEL|\bFUEL\b|LOGISTICS|OFFICE|\bPAYE\b/.test(u)) return CAT.OPEX;
    if (BETTING_RE.test(u) || DISC_RE.test(u)) return CAT.DISC;
    return CAT.UNKNOWN_OUT;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Much informal Nigerian income arrives as plain transfers. A sender who pays
  // regularly is treated as income and marked `inferred` so an underwriter can check it.
  function enrich(txns) {
    const enriched = txns.map((t) => ({
      ...t,
      merchant: extractMerchant(t.desc),
      category: classify(t.desc, t.credit > 0),
      inferred: false,
    }));
    enriched.forEach((t) => {
      if (t.category === CAT.FEES) t.merchant = 'Bank';
      if (t.category === CAT.REVERSAL && BANK_ITEM_RE.test(t.desc.toUpperCase())) t.merchant = 'Bank';
      if (t.category === CAT.XFER_IN || t.category === CAT.XFER_OUT) t.merchant = 'Own account';
    });
    const groups = new Map();
    const paidOut = new Map();
    enriched.forEach((t) => {
      if (t.debit) paidOut.set(t.merchant, (paidOut.get(t.merchant) || 0) + t.debit);
      if (t.category !== CAT.UNKNOWN_IN || t.merchant === 'Unknown') return;
      if (!groups.has(t.merchant)) groups.set(t.merchant, []);
      groups.get(t.merchant).push(t);
    });
    groups.forEach((rows, merchant) => {
      const months = new Set(rows.map((t) => t.date.slice(0, 7)));
      const received = rows.reduce((s, t) => s + t.credit, 0);
      // Money that mostly goes back to the same party is circular, not earnings.
      const circular = (paidOut.get(merchant) || 0) >= received * CONFIG.recurringMaxPaidBackShare;
      if (!circular && months.size >= CONFIG.recurringMinMonths && median(rows.map((t) => t.credit)) >= CONFIG.recurringMinKobo) {
        rows.forEach((t) => {
          t.category = CAT.REVENUE;
          t.inferred = true;
        });
      }
    });
    return enriched;
  }

  /* ---------- metrics ---------- */

  function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }

  function stdDev(values) {
    if (!values.length) return 0;
    const m = mean(values);
    return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
  }

  const DEBT_TEXT_RE = /\bLOAN\b|REPAY|\bDD\b|DIRECT DEBIT|REMITA|\bGSI\b/;

  function dailyBalances(txns, start, end, opening) {
    const inScope = txns.filter((t) => t.balance !== null);
    if (!inScope.length) return null;
    let current = opening === null ? inScope[0].balance : opening;
    let i = 0;
    const out = [];
    for (let day = start; day <= end; day++) {
      while (i < inScope.length && inScope[i].day <= day) current = inScope[i++].balance;
      out.push({ day, date: dayToISO(day), balance: current });
    }
    return out;
  }

  function computeWindow(txns, start, end, months, opening) {
    const inWindow = txns.filter((t) => t.day >= start && t.day <= end);
    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
      const bucketEnd = addMonths(end, -i);
      const bucketStart = Math.max(start, addMonths(end, -(i + 1)) + 1);
      const b = { start: dayToISO(bucketStart), end: dayToISO(bucketEnd), income: 0, inflow: 0, outflow: 0, obligations: 0, reversals: 0 };
      inWindow.filter((t) => t.day >= bucketStart && t.day <= bucketEnd).forEach((t) => {
        if (t.credit) {
          if (t.category === CAT.REVENUE) b.income += t.credit;
          if (t.category === CAT.REVERSAL) {
            b.reversals += t.credit;
            if (DEBT_TEXT_RE.test(t.desc.toUpperCase())) b.obligations -= t.credit;
          } else if (t.category !== CAT.LOAN && t.category !== CAT.XFER_IN) {
            b.inflow += t.credit;
          }
        } else {
          if (t.category === CAT.DEBT) b.obligations += t.debit;
          if (t.category !== CAT.XFER_OUT) b.outflow += t.debit;
        }
      });
      // A reversal returns money that left earlier, so it nets against outflow, not income.
      b.outflow = Math.max(0, b.outflow - b.reversals);
      b.obligations = Math.max(0, b.obligations);
      b.net = b.inflow - b.outflow;
      buckets.push(b);
    }

    const incomes = buckets.map((b) => b.income);
    const avgIncome = mean(incomes);
    const avgObligations = mean(buckets.map((b) => b.obligations));
    const avgNet = mean(buckets.map((b) => b.net));
    const burn = mean(buckets.map((b) => b.outflow));
    const daily = dailyBalances(txns, start, end, opening);
    const balances = daily ? daily.map((d) => d.balance) : null;
    const adb = balances ? mean(balances) : null;
    let trend = null;
    if (balances && balances.length >= 2) {
      const half = Math.floor(balances.length / 2);
      const first = mean(balances.slice(0, half));
      trend = first > 0 ? mean(balances.slice(half)) / first - 1 : null;
    }

    return {
      months,
      start: dayToISO(start),
      end: dayToISO(end),
      buckets,
      daily,
      avgIncome,
      avgObligations,
      foir: avgIncome > 0 ? avgObligations / avgIncome : null,
      avgNet,
      netVolatility: avgIncome > 0 ? stdDev(buckets.map((b) => b.net)) / avgIncome : null,
      netMargin: avgIncome > 0 ? avgNet / avgIncome : null,
      burn,
      netBurn: Math.max(0, -avgNet),
      adb,
      balanceCV: adb > 0 ? stdDev(balances) / adb : null,
      balanceTrend: trend,
      bufferDays: adb === null || burn <= 0 ? null : Math.max(0, adb) / (burn / DAYS_PER_MONTH),
      incomeCV: avgIncome > 0 ? stdDev(incomes) / avgIncome : null,
      monthsWithIncome: incomes.filter((v) => v > 0).length,
    };
  }

  function computeWindows(txns, opening) {
    const firstDay = txns[0].day;
    const lastDay = txns[txns.length - 1].day;
    const windows = {};
    [3, 6, 12].forEach((n) => {
      const start = addMonths(lastDay, -n) + 1;
      windows[n] = firstDay <= start + CONFIG.windowGraceDays ? computeWindow(txns, start, lastDay, n, opening) : null;
    });
    const scoringMonths = [12, 6, 3].find((n) => windows[n]);
    if (scoringMonths) return { windows, scoring: windows[scoringMonths], complete: true };
    const months = Math.max(1, Math.round((lastDay - firstDay + 1) / DAYS_PER_MONTH));
    return { windows, scoring: computeWindow(txns, firstDay, lastDay, months, opening), complete: false };
  }

  /* ---------- risk ---------- */

  function riskKind(desc) {
    const u = String(desc || '').toUpperCase();
    const returned = 'RETURN|BOUNCE|DISHONO|UNPAID|REJECT|FAIL';
    if (/\bGSI\b|GLOBAL STANDING/.test(u)) return 'gsi';
    if (/INSUFFICIENT|\bNSF\b|\bDAUD\b/.test(u) || new RegExp(`(${returned})\\w*\\s+(CHARGE|FEE)`).test(u)) return 'nsfFee';
    const instrument = '(CHQ|CHEQUE|CHECK)';
    if (new RegExp(`${instrument}.*(${returned})|(${returned}).*${instrument}`).test(u)) return 'bouncedInstrument';
    const debit = '(\\bDD\\b|DIRECT DEBIT|REMITA|MANDATE|STANDING ORDER)';
    if (new RegExp(`${debit}.*(${returned})|(${returned}).*${debit}`).test(u)) return 'failedDebit';
    return null;
  }

  // One failed payment often produces a reversal and a fee: rows within 2 days are one event.
  function countEvents(rows) {
    let events = 0;
    let last = -Infinity;
    [...rows].sort((a, b) => a.day - b.day).forEach((t) => {
      if (t.day - last > 2) events++;
      last = t.day;
    });
    return events;
  }

  function findRoundTrips(txns) {
    const cfg = CONFIG.roundTrip;
    const eligible = txns.filter((t) => t.merchant !== 'Unknown' && (t.debit || t.credit) >= cfg.minKobo && (t.category === CAT.UNKNOWN_OUT || t.category === CAT.UNKNOWN_IN || t.category === CAT.REVENUE));
    const used = new Set();
    const pairs = [];
    eligible.filter((t) => t.debit).forEach((out) => {
      const back = eligible.find((t) => t.credit && !used.has(t) && t.merchant === out.merchant && t.day >= out.day && t.day - out.day <= cfg.maxDays && Math.abs(t.credit - out.debit) / out.debit <= cfg.amountTolerance);
      if (back) {
        used.add(back);
        pairs.push({ merchant: out.merchant, out, back });
      }
    });
    return pairs.length >= cfg.minPairs ? pairs : [];
  }

  function assessRisk(txns, start, avgIncome, opening) {
    const inScope = txns.filter((t) => t.day >= start);
    const kinds = { nsfFee: [], bouncedInstrument: [], failedDebit: [], gsi: [] };
    inScope.forEach((t) => {
      const kind = riskKind(t.desc);
      if (kind) kinds[kind].push(t);
    });
    const bounceRows = [...kinds.nsfFee, ...kinds.bouncedInstrument, ...kinds.failedDebit];

    let overdraftEpisodes = 0;
    let daysNegative = 0;
    const lastDay = txns[txns.length - 1].day;
    const daily = dailyBalances(txns, start, lastDay, opening);
    if (daily) {
      let wasNegative = false;
      daily.forEach((d) => {
        const negative = d.balance < 0;
        if (negative) daysNegative++;
        if (negative && !wasNegative) overdraftEpisodes++;
        wasNegative = negative;
      });
    }

    const lenderPayouts = inScope.filter((t) => t.credit && t.category === CAT.LOAN && LENDER_RE.test(t.desc.toUpperCase()));
    const debtDebits = inScope.filter((t) => t.debit && t.category === CAT.DEBT);
    const stacking = lenderPayouts
      .map((payout) => ({ payout, debit: debtDebits.find((d) => d.day >= payout.day && d.day - payout.day <= CONFIG.stackingDays) }))
      .filter((p) => p.debit);
    const lenders = [...new Set(inScope.filter((t) => LENDER_RE.test(t.desc.toUpperCase())).map((t) => t.merchant))];
    const roundTrips = findRoundTrips(inScope);
    const betting = inScope.filter((t) => t.debit && BETTING_RE.test(t.desc.toUpperCase()));
    const bettingTotal = betting.reduce((s, t) => s + t.debit, 0);
    const months = Math.max(1, (lastDay - start + 1) / DAYS_PER_MONTH);
    const bettingShare = avgIncome > 0 ? bettingTotal / months / avgIncome : null;

    return {
      nsfFees: kinds.nsfFee,
      bouncedInstruments: kinds.bouncedInstrument,
      failedDebits: kinds.failedDebit,
      gsiRecoveries: kinds.gsi,
      bounceEvents: countEvents(bounceRows),
      overdraftEpisodes,
      daysNegative,
      lenders,
      lenderPayouts,
      stacking,
      roundTrips,
      betting,
      bettingTotal,
      bettingShare,
    };
  }

  /* ---------- scoring ---------- */

  function lin(value, worst, best) {
    const t = (value - worst) / (best - worst);
    return Math.min(1, Math.max(0, t));
  }

  function pct(v) {
    return `${Math.round(v * 100)}%`;
  }

  function naira(kobo) {
    const sign = kobo < 0 ? '-' : '';
    return `${sign}₦${(Math.abs(kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
  }

  function computeScore(m, risk, forensics, complete) {
    const w = CONFIG.weights;
    const p = CONFIG.penalties;
    const reasons = [];
    const add = (pillar, code, points, max, label, detail) => reasons.push({ pillar, code, points: Math.round(points), max, label, detail });
    const scale = (cfg, value) => cfg.max * lin(value, cfg.worst, cfg.best);
    const hasIncome = m.avgIncome > 0;

    add('Income Stability', 'IS01', scale(w.incomeRegularity, m.monthsWithIncome / m.months), w.incomeRegularity.max,
      'Income regularity', `Identified income in ${m.monthsWithIncome} of ${m.months} months.`);
    add('Income Stability', 'IS02', hasIncome ? scale(w.incomeVariability, m.incomeCV) : 0, w.incomeVariability.max,
      'Income variability', hasIncome ? `Monthly income varies by ${pct(m.incomeCV)} around its ${naira(m.avgIncome)} average.` : 'No identifiable income to assess.');
    add('Debt Load', 'DL01', hasIncome ? scale(w.foir, m.foir) : 0, w.foir.max,
      'Fixed obligations to income', hasIncome ? `Debt service of ${naira(m.avgObligations)} a month takes ${pct(m.foir)} of income.` : 'Debt capacity cannot be shown without identifiable income.');

    if (m.bufferDays === null) {
      add('Cash-Flow Health', 'CF01', w.bufferDays.max / 2, w.bufferDays.max, 'Liquidity buffer', 'Not measurable, so half points were given.');
    } else {
      add('Cash-Flow Health', 'CF01', scale(w.bufferDays, m.bufferDays), w.bufferDays.max, 'Liquidity buffer', `Average balance covers ${Math.round(m.bufferDays)} days of spending.`);
    }
    add('Cash-Flow Health', 'CF02', hasIncome ? scale(w.netVolatility, m.netVolatility) : 0, w.netVolatility.max,
      'Net cash-flow volatility', hasIncome ? `Monthly net cash flow swings by ${pct(m.netVolatility)} of income.` : 'No identifiable income to compare against.');
    add('Cash-Flow Health', 'CF03', hasIncome ? scale(w.netMargin, m.netMargin) : 0, w.netMargin.max,
      'Net cash-flow margin', hasIncome ? `Average net cash flow is ${naira(m.avgNet)} a month, or ${pct(m.netMargin)} of income.` : 'No identifiable income to compare against.');
    if (m.balanceTrend === null) {
      add('Cash-Flow Health', 'CF04', m.adb === null ? w.balanceTrend.max / 2 : 0, w.balanceTrend.max, 'Balance trend',
        m.adb === null ? 'Not measurable, so half points were given.' : 'Balance was at or below zero in the first half of the period.');
    } else {
      add('Cash-Flow Health', 'CF04', scale(w.balanceTrend, m.balanceTrend), w.balanceTrend.max, 'Balance trend', `Average balance changed by ${pct(m.balanceTrend)} from the first half of the period to the second.`);
    }

    const penalty = (code, cfg, count, label, detail) => {
      if (count > 0) add('Risk Penalties', code, -Math.min(cfg.cap, cfg.each * count), 0, label, detail);
    };
    penalty('RP01', p.bounce, risk.bounceEvents, 'Failed payments', `${risk.bounceEvents} failed-payment event(s): returned instruments, failed direct debits, or NSF fees.`);
    penalty('RP02', p.overdraft, risk.overdraftEpisodes, 'Overdrawn balance', `${risk.overdraftEpisodes} overdrawn episode(s) over ${risk.daysNegative} day(s).`);
    penalty('RP03', p.stacking, risk.stacking.length, 'Loan cash before repayment', `${risk.stacking.length} digital-loan payout(s) landed within ${CONFIG.stackingDays} days before a debt payment.`);
    penalty('RP04', p.roundTrip, risk.roundTrips.length, 'Circular money movement', `${risk.roundTrips.length} matched send-and-return pair(s) with the same counterparty.`);
    penalty('RP05', p.gsi, risk.gsiRecoveries.length, 'GSI recovery', `${risk.gsiRecoveries.length} Global Standing Instruction recovery debit(s).`);
    penalty('RP06', p.manyLenders, Math.max(0, risk.lenders.length - p.manyLenders.freeCount), 'Many digital lenders', `Activity with ${risk.lenders.length} digital lenders: ${risk.lenders.join(', ')}.`);

    const pillars = ['Income Stability', 'Debt Load', 'Cash-Flow Health', 'Risk Penalties'].map((name) => {
      const rows = reasons.filter((r) => r.pillar === name);
      return { name, points: rows.reduce((s, r) => s + r.points, 0), max: rows.reduce((s, r) => s + r.max, 0) };
    });
    const raw = pillars.reduce((s, x) => s + x.points, 0);
    const score = Math.max(0, Math.min(1000, raw));
    const band = CONFIG.bands.find((b) => score >= b.min).label;

    const reviewReasons = [];
    if (forensics.likelyMisread) reviewReasons.push('Many rows fail the balance check, so the PDF layout may have been misread. Compare the figures with the original before treating this as tampering.');
    else if (forensics.status === 'fail') reviewReasons.push('The statement failed the balance check, so its figures cannot be relied on.');
    if (forensics.status === 'unverifiable') reviewReasons.push('The statement has no balance column, so it could not be checked.');
    if (forensics.status === 'review') reviewReasons.push('The statement has data-quality warnings to check.');
    if (!complete) reviewReasons.push('The statement covers less than 3 months.');
    if (!hasIncome) reviewReasons.push('No income could be identified automatically.');

    const confidence = !complete || forensics.status !== 'pass' ? 'Low' : m.months >= 12 ? 'High' : m.months >= 6 ? 'Medium' : 'Low';
    const ranked = [...reasons].sort((a, b) => (a.points - a.max) - (b.points - b.max));
    return {
      score,
      band,
      version: CONFIG.scorecardVersion,
      pillars,
      reasons: ranked,
      confidence,
      manualReview: reviewReasons.length > 0,
      unverified: forensics.status === 'fail',
      reviewReasons,
      months: m.months,
    };
  }

  /* ---------- entry point ---------- */

  // input is CSV text, or the object returned by BankPdf.read.
  function analyze(input) {
    const isRows = typeof input !== 'string';
    const parsed = isRows ? parseRows(input.rows, input.pages) : parseStatement(input);
    const forensics = runForensics(parsed, isRows ? input : null);
    // File order is checked above; everything after this works in date order.
    const sorted = parsed.txns.map((t, i) => [t, i]).sort((a, b) => a[0].day - b[0].day || a[1] - b[1]).map((x) => x[0]);
    const txns = enrich(sorted);
    const { windows, scoring, complete } = computeWindows(txns, forensics.opening);
    const startDay = Date.parse(`${scoring.start}T00:00:00Z`) / MS_PER_DAY;
    const risk = assessRisk(txns, startDay, scoring.avgIncome, forensics.opening);
    const score = computeScore(scoring, risk, forensics, complete);
    return { txns, rejected: parsed.rejected, forensics, windows, scoring, complete, risk, score };
  }

  root.BankEngine = { CONFIG, CAT, analyze, parseStatement, parseRows, mapColumns, parseCSV, parseMoney, parseDate, runForensics, extractMerchant, classify, enrich, computeWindow, computeScore, riskKind, toDay, addMonths, dayToISO, naira };
})(typeof window !== 'undefined' ? window : globalThis);
