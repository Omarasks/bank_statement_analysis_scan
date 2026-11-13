/* Synthetic Nigerian statements for demos and tests. All names and figures are invented. */
(function (root) {
  'use strict';

  const { toDay, addMonths, dayToISO } = root.BankEngine;

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildRows(openingNaira, events) {
    const ordered = events.map((e, i) => [e, i]).sort((a, b) => a[0].day - b[0].day || a[1] - b[1]).map((x) => x[0]);
    let balance = openingNaira * 100;
    return ordered.map((e) => {
      balance += (e.credit || 0) * 100 - (e.debit || 0) * 100;
      return { date: dayToISO(e.day), desc: e.desc, debit: e.debit || 0, credit: e.credit || 0, balance: balance / 100 };
    });
  }

  function toCSV(openingNaira, rows) {
    const fmt = (n) => (n ? n.toFixed(2) : '');
    const lines = ['Trans Date,Narration,Debit,Credit,Balance', `,Opening Balance,,,${openingNaira.toFixed(2)}`];
    rows.forEach((r) => {
      const [y, m, d] = r.date.split('-');
      lines.push(`${d}/${m}/${y},"${r.desc}",${fmt(r.debit)},${fmt(r.credit)},${r.balance.toFixed(2)}`);
    });
    return lines.join('\n');
  }

  function monthDay(monthStart, dayOfMonth) {
    return addMonths(monthStart, 0) + dayOfMonth - 1;
  }

  const FIRST_MONTH = toDay(2025, 11, 1);
  const monthsBack = (n) => Array.from({ length: n }, (_, i) => addMonths(FIRST_MONTH, i + 12 - n));

  function stableEvents() {
    const r = rng(11);
    const events = [];
    monthsBack(12).forEach((m, i) => {
      const pay = 850000 + (i % 6 === 1 ? 90000 : 0);
      events.push({ day: monthDay(m, 25), desc: 'NIP/SALARY/ACME LOGISTICS LTD', credit: pay });
      events.push({ day: monthDay(m, 25), desc: 'STAMP DUTY ON INFLOW', debit: 50 });
      events.push({ day: monthDay(m, 27), desc: 'REMITA DD/LOAN REPAYMENT/STANBIC', debit: 300000 });
      if (i % 4 === 2) events.push({ day: monthDay(m, 10), desc: 'NIP/TRF/SCHOOL FEES/ST MARYS', debit: 350000 });
      events.push({ day: monthDay(m, 3), desc: 'WEB PURCHASE/IKEDC PREPAID METER 04512', debit: 22000 + Math.round(r() * 8000) });
      events.push({ day: monthDay(m, 5), desc: 'USSD AIRTIME MTN 0803XXX1234', debit: 15000 });
      events.push({ day: monthDay(m, 6), desc: 'POS/DSTV SUBSCRIPTION', debit: 29500 });
      events.push({ day: monthDay(m, 2), desc: 'TRF/RENT/HOUSE AGENT', debit: 200000 });
      events.push({ day: monthDay(m, 28), desc: 'SMS ALERT CHARGE', debit: 200 });
      for (let i = 0; i < 6; i++) {
        const shop = ['POS PURCHASE/SHOPRITE LEKKI LANG NG', 'WEB/JUMIA ONLINE', 'POS/CHICKEN REPUBLIC IKEJA', 'BOLT RIDE'][Math.floor(r() * 4)];
        events.push({ day: monthDay(m, 7 + i * 3), desc: shop, debit: 9000 + Math.round(r() * 35000) });
      }
      events.push({ day: monthDay(m, 26), desc: 'MOBILE TRF TO OWN ACCOUNT SAVINGS', debit: 20000 });
    });
    return events;
  }

  function stressedEvents() {
    const r = rng(29);
    const events = [];
    monthsBack(12).forEach((m, i) => {
      if (i % 6 !== 5) {
        const amount = 230000 + Math.round(r() * 170000);
        events.push({ day: monthDay(m, 4 + Math.floor(r() * 18)), desc: 'NIP/TRF FROM MAMA TOBI STORES/GTB', credit: amount });
      }
      events.push({ day: monthDay(m, 1), desc: 'TRF/RENT/LANDLORD', debit: 60000 });
      events.push({ day: monthDay(m, 12), desc: 'REMITA DD/LOAN REPAYMENT/FAIRMONEY', debit: 75000 });
      events.push({ day: monthDay(m, 20), desc: 'CARBON LOAN REPAYMENT', debit: 55000 });
      events.push({ day: monthDay(m, 6), desc: 'USSD AIRTIME AIRTEL 0802XXX5678', debit: 8000 });
      events.push({ day: monthDay(m, 9), desc: 'BET9JA WALLET FUNDING', debit: 15000 + Math.round(r() * 20000) });
      events.push({ day: monthDay(m, 15), desc: 'POS PURCHASE/SUPERMARKET SURULERE', debit: 25000 + Math.round(r() * 25000) });
      if (i === 9) events.push({ day: monthDay(m, 8), desc: 'NIP/PALMCREDIT LOAN DISBURSEMENT', credit: 60000 });
      if (i % 6 === 5) events.push({ day: monthDay(m, 13), desc: 'DD RETURN CHARGE', debit: 2500 });
    });
    const late = monthsBack(4);
    late.slice(0, 3).forEach((m) => {
      events.push({ day: monthDay(m, 21), desc: 'NIP/TRF TO ZENITH TRADERS VENTURES', debit: 400000 });
      events.push({ day: monthDay(m, 23), desc: 'NIP/TRF FROM ZENITH TRADERS VENTURES', credit: 395000 });
    });
    events.push({ day: monthDay(late[3], 24), desc: 'GSI RECOVERY/CBN GLOBAL STANDING INSTRUCTION', debit: 45000 });
    return events.filter((e) => e.debit || e.credit);
  }

  function buildSample(key) {
    if (key === 'stressed') {
      return toCSV(150000, buildRows(150000, stressedEvents()));
    }
    const rows = buildRows(1200000, stableEvents());
    if (key === 'altered') {
      // Inflates one salary credit but leaves printed balances alone, as a careless edit would.
      const target = rows.filter((row) => /SALARY/.test(row.desc))[8];
      target.credit += 500000;
    }
    return toCSV(1200000, rows);
  }

  root.BankSamples = {
    list: [
      { key: 'stable', label: 'Stable salary earner' },
      { key: 'stressed', label: 'Stressed borrower' },
      { key: 'altered', label: 'Altered statement' },
    ],
    build: buildSample,
  };
})(typeof window !== 'undefined' ? window : globalThis);
