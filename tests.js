(function () {
  'use strict';
  const E = window.BankEngine;
  const S = window.BankSamples;
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, message: err.message });
    }
  }

  function eq(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  function near(actual, expected, tolerance, label) {
    if (Math.abs(actual - expected) > tolerance) throw new Error(`${label || 'value'}: expected about ${expected}, got ${actual}`);
  }

  const HEADER = 'Date,Narration,Debit,Credit,Balance\n';

  /* parsing */
  test('money: commas, naira sign, DR suffix, parentheses, blanks, junk', () => {
    eq(E.parseMoney('₦1,234.50'), 123450);
    eq(E.parseMoney('1,000.00 DR'), -100000);
    eq(E.parseMoney('(250.00)'), -25000);
    eq(E.parseMoney('500.00 CR'), 50000);
    eq(E.parseMoney(''), null);
    eq(E.parseMoney('-'), null);
    eq(Number.isNaN(E.parseMoney('abc')), true);
  });

  test('dates: day-first default, month names, ISO, invalid rejected', () => {
    eq(E.parseDate('03/04/2026', 'DMY'), E.toDay(2026, 4, 3));
    eq(E.parseDate('15-Mar-26', 'DMY'), E.toDay(2026, 3, 15));
    eq(E.parseDate('2026-03-15', 'DMY'), E.toDay(2026, 3, 15));
    eq(E.parseDate('31/02/2026', 'DMY'), null);
  });

  test('parser skips bank preamble and reads the opening balance row', () => {
    const csv = 'GTBank Statement\nAccount Name,Test User\n\nTrans Date,Narration,Debits,Credits,Balance\n,Opening Balance,,,"1,000.00"\n01/02/2026,POS/SHOPRITE,100.00,,900.00\n';
    const p = E.parseStatement(csv);
    eq(p.txns.length, 1);
    eq(p.declaredOpening, 100000);
    eq(p.txns[0].debit, 10000);
  });

  test('newest-first statements are put in date order', () => {
    const p = E.parseStatement(HEADER + '03/02/2026,B,,100.00,300.00\n01/02/2026,A,,100.00,200.00\n');
    eq(p.txns[0].desc, 'A');
    eq(E.runForensics(p).status, 'pass');
  });

  test('signed amount column with no debit and credit columns', () => {
    const p = E.parseStatement('Date,Description,Amount,Balance\n01/02/2026,X,-50.00,950.00\n02/02/2026,Y,100.00,1050.00\n');
    eq(p.txns[0].debit, 5000);
    eq(p.txns[1].credit, 10000);
  });

  test('an amount column is used when debit and credit columns exist but are blank', () => {
    const p = E.parseStatement('Date,Narration,Debit,Credit,Amount,Balance\n01/02/2026,X,,,-50.00,950.00\n02/02/2026,Y,,,100.00,1050.00\n');
    eq(p.txns.length, 2);
    eq(p.txns[0].debit, 5000);
    eq(p.txns[1].credit, 10000);
  });

  test('a file with no usable header raises a clear error', () => {
    let message = '';
    try { E.parseStatement('a,b\n1,2\n'); } catch (err) { message = err.message; }
    eq(/header row/.test(message), true);
  });

  /* forensics */
  test('forensics: clean statement passes', () => {
    const p = E.parseStatement(HEADER + ',Opening Balance,,,1000.00\n01/02/2026,A,100.00,,900.00\n02/02/2026,B,,50.00,950.00\n');
    const f = E.runForensics(p);
    eq(f.status, 'pass');
    eq(f.totalsDiff, 0);
    eq(f.openingSource, 'declared');
  });

  test('forensics: an edited amount produces exactly one line break at that row', () => {
    const p = E.parseStatement(HEADER + ',Opening Balance,,,1000.00\n01/02/2026,A,100.00,,900.00\n02/02/2026,EDITED,,999.00,950.00\n03/02/2026,C,50.00,,900.00\n');
    const f = E.runForensics(p);
    eq(f.status, 'fail');
    eq(f.breaks.length, 1);
    eq(f.breaks[0].desc, 'EDITED');
    eq(f.breaks[0].diff, -94900);
  });

  test('forensics: no balance column is unverifiable, never a pass', () => {
    const p = E.parseStatement('Date,Narration,Debit,Credit\n01/02/2026,A,100.00,\n');
    eq(E.runForensics(p).status, 'unverifiable');
  });

  test('forensics: duplicate rows and long gaps ask for review', () => {
    const zeroRow = E.parseStatement(HEADER + ',Opening Balance,,,0\n01/02/2026,A,,100.00,100.00\n01/02/2026,Zero,,,100.00\n');
    eq(zeroRow.txns.length, 1);
    // The repeated row also breaks the running balance, so this is a hard fail with a duplicate warning.
    const dup = E.runForensics(E.parseStatement(HEADER + ',Opening Balance,,,0\n01/02/2026,A,,100.00,100.00\n01/02/2026,A,,100.00,100.00\n'));
    eq(dup.status, 'fail');
    eq(dup.warnings.some((w) => /duplicate/.test(w)), true);
    const gap = E.parseStatement(HEADER + ',Opening Balance,,,0\n01/02/2026,A,,100.00,100.00\n01/05/2026,B,,100.00,200.00\n');
    const f = E.runForensics(gap);
    eq(f.status, 'review');
    eq(/pages may be missing/.test(f.warnings[0]), true);
  });

  /* enrichment */
  test('classification covers Nigerian narrations', () => {
    const cases = [
      ['NIP/SALARY/ACME LTD', true, E.CAT.REVENUE],
      ['IPPIS FGN PAY', true, E.CAT.REVENUE],
      ['PAYSTACK SETTLEMENT 0091', true, E.CAT.REVENUE],
      ['FAIRMONEY LOAN DISBURSEMENT', true, E.CAT.LOAN],
      ['FIRS TAX REFUND', true, E.CAT.TAX],
      ['REVERSAL OF FAILED TRANSFER', true, E.CAT.REVERSAL],
      ['MOBILE TRF FROM OWN ACCOUNT', true, E.CAT.XFER_IN],
      ['NIP/TRF FROM AMINA BELLO', true, E.CAT.UNKNOWN_IN],
      ['REMITA DD/LOAN REPAYMENT', false, E.CAT.DEBT],
      ['GSI RECOVERY', false, E.CAT.DEBT],
      ['IKEDC PREPAID METER', false, E.CAT.UTIL],
      ['USSD AIRTIME MTN', false, E.CAT.UTIL],
      ['STAMP DUTY', false, E.CAT.FEES],
      ['EMTL LEVY', false, E.CAT.FEES],
      ['SCHOOL FEES ST MARYS', false, E.CAT.OPEX],
      ['STAFF SALARY OCT', false, E.CAT.PAYROLL],
      ['BET9JA WALLET', false, E.CAT.DISC],
      ['NIP/TRF TO AMINA BELLO', false, E.CAT.UNKNOWN_OUT],
      ['TRANSACTION CHARGE-Rsvl:web: Transfer', true, E.CAT.REVERSAL],
      ['RTN NEFT/MALA MUHAMMED', true, E.CAT.REVERSAL],
      ['NIP FRM ADEX TRADING LTD-RVSL', true, E.CAT.REVERSAL],
    ];
    cases.forEach(([desc, isCredit, expected]) => eq(E.classify(desc, isCredit), expected, desc));
  });

  test('merchant extraction removes bank noise', () => {
    eq(E.extractMerchant('NIP/TRF FROM ADEBAYO OKON/GTB/0123456789'), 'Adebayo Okon');
    eq(E.extractMerchant('POS PURCHASE/SHOPRITE LEKKI LANG NG'), 'Shoprite');
    eq(E.extractMerchant('USSD AIRTIME MTN 0803XXX1234'), 'MTN');
    eq(E.extractMerchant('123456'), 'Unknown');
  });

  test('FCMB-style transfer narrations give one consistent sender name', () => {
    const same = (descs, expected) => descs.forEach((d) => eq(E.extractMerchant(d), expected, d));
    same([
      'NIP FRM ACME FARMS NIG LTD-pers',
      'COP FRM ACME FARMS NIG. LIMITED',
      'NPS/NPS FRM ACME FARMS NIGERIA LIM',
    ], 'Acme Farms Nig Ltd');
    same([
      'NIP FRM DELTA OIL AND GAS LTD-C',
      'NIP FRM DELTA OIL GAS LTD-NIPT',
    ], 'Delta Oil Gas Ltd');
    same([
      'NIP FRM BRIGHT STAR COMPANY NIG LTD-Bal',
      'NIP FRM BRIGHT STAR COMPANY NIG LTD-Par',
    ], 'Bright Star Company Nig Ltd');
    same([
      'NPS/NPS FRM JOHN ADE OKON- ONB',
      'NIP FRM JOHN ADE OKON- ONB TRF',
    ], 'John Ade Okon');
    eq(E.extractMerchant('NIP FRM ALI MUSA505051-MOBILE TRF TO'), 'Ali Musa');
    eq(E.extractMerchant('KEPLER WORKS LTD|MOB: To FCMB|ACME'), 'Kepler Works Ltd');
  });

  test('a regular sender is recognised across differently written narrations', () => {
    const descs = ['NPS/NPS FRM JOHN ADE OKON- ONB', 'NIP FRM JOHN ADE OKON- ONB TRF', 'NIP FRM JOHN ADE OKON-school'];
    const rows = descs.map((desc, i) => ({ desc, credit: 5000000, debit: 0, date: `2026-0${i + 1}-10`, day: 1 }));
    const out = E.enrich(rows);
    out.forEach((t) => {
      eq(t.category, E.CAT.REVENUE);
      eq(t.inferred, true);
    });
  });

  test('a reversed bank charge is labelled as the bank', () => {
    const out = E.enrich([{ desc: 'TRANSACTION CHARGE-Rsvl:web: Fuelling', credit: 5400, debit: 0, date: '2026-01-01', day: 1 }]);
    eq(out[0].category, E.CAT.REVERSAL);
    eq(out[0].merchant, 'Bank');
  });

  test('a regular transfer sender becomes inferred income; one-off senders do not', () => {
    const rows = ['01/01/2026', '01/02/2026', '01/03/2026'].map((d) => ({ desc: 'TRF FROM MAMA TOBI', credit: 5000000, debit: 0, date: d.split('/').reverse().join('-'), day: 1 }));
    rows.push({ desc: 'TRF FROM UNCLE SEGUN', credit: 5000000, debit: 0, date: '2026-01-05', day: 1 });
    const out = E.enrich(rows);
    eq(out[0].category, E.CAT.REVENUE);
    eq(out[0].inferred, true);
    eq(out[3].category, E.CAT.UNKNOWN_IN);
  });

  test('a regular sender who is mostly paid back is not treated as income', () => {
    const rows = [];
    ['01', '02', '03'].forEach((mm) => {
      rows.push({ desc: 'NIP/TRF TO ACME TRADERS', credit: 0, debit: 40000000, date: `2026-${mm}-01`, day: 1 });
      rows.push({ desc: 'NIP/TRF FROM ACME TRADERS', credit: 39000000, debit: 0, date: `2026-${mm}-03`, day: 3 });
    });
    const out = E.enrich(rows);
    eq(out[1].merchant, out[0].merchant);
    eq(out[1].category, E.CAT.UNKNOWN_IN);
  });

  test('bank fees and non-merchants get sensible merchant labels', () => {
    const out = E.enrich([
      { desc: 'SMS ALERT CHARGE', credit: 0, debit: 400, date: '2026-01-01', day: 1 },
      { desc: 'MOBILE TRF TO OWN ACCOUNT SAVINGS', credit: 0, debit: 400, date: '2026-01-01', day: 1 },
      { desc: 'TRF/RENT/HOUSE AGENT', credit: 0, debit: 400, date: '2026-01-01', day: 1 },
    ]);
    eq(out[0].merchant, 'Bank');
    eq(out[1].merchant, 'Own account');
    eq(out[2].merchant, 'House Agent');
  });

  /* metrics */
  function tx(date, desc, debit, credit, balance) {
    const [y, m, d] = date.split('-').map(Number);
    return { day: E.toDay(y, m, d), date, desc, debit, credit, balance, category: E.classify(desc, credit > 0), merchant: E.extractMerchant(desc), inferred: false };
  }

  test('ADB is hand-checkable: 5 days at 100 and 5 at 200 averages 150', () => {
    const txns = [tx('2026-01-01', 'X', 0, 10000, 10000), tx('2026-01-06', 'X', 0, 10000, 20000)];
    const m = E.computeWindow(txns, E.toDay(2026, 1, 1), E.toDay(2026, 1, 10), 1, 0);
    eq(m.adb, 15000);
    near(m.balanceTrend, 1, 0.0001, 'trend');
  });

  test('FOIR: N40,000 debt on N100,000 income is 40%', () => {
    const txns = [];
    ['01', '02', '03'].forEach((mm, i) => {
      txns.push(tx(`2026-${mm}-05`, 'SALARY ACME', 0, 10000000, 10000000 + i));
      txns.push(tx(`2026-${mm}-06`, 'LOAN REPAYMENT', 4000000, 0, 6000000 + i));
    });
    const m = E.computeWindow(txns, E.toDay(2026, 1, 1), E.toDay(2026, 3, 31), 3, 0);
    near(m.foir, 0.4, 0.0001, 'foir');
    eq(m.monthsWithIncome, 3);
    eq(m.incomeCV, 0);
  });

  test('a returned loan debit is not counted as a paid obligation or income', () => {
    const txns = [
      tx('2026-01-05', 'SALARY ACME', 0, 10000000, 10000000),
      tx('2026-01-06', 'REMITA DD LOAN REPAYMENT', 4000000, 0, 6000000),
      tx('2026-01-06', 'REMITA DD RETURNED REVERSAL', 0, 4000000, 10000000),
    ];
    const m = E.computeWindow(txns, E.toDay(2026, 1, 1), E.toDay(2026, 1, 31), 1, 0);
    eq(m.avgObligations, 0);
    eq(m.avgIncome, 10000000);
    eq(m.burn, 0);
  });

  test('own-account transfers and loan payouts are excluded from net cash flow', () => {
    const txns = [
      tx('2026-01-05', 'SALARY ACME', 0, 10000000, 10000000),
      tx('2026-01-06', 'TRF TO OWN ACCOUNT', 5000000, 0, 5000000),
      tx('2026-01-07', 'FAIRMONEY LOAN DISBURSEMENT', 0, 3000000, 8000000),
    ];
    const m = E.computeWindow(txns, E.toDay(2026, 1, 1), E.toDay(2026, 1, 31), 1, 0);
    eq(m.avgNet, 10000000);
    eq(m.burn, 0);
  });

  /* risk */
  test('risk kinds recognise failed payments and GSI', () => {
    eq(E.riskKind('REMITA DD RETURNED'), 'failedDebit');
    eq(E.riskKind('INSUFFICIENT FUNDS FEE'), 'nsfFee');
    eq(E.riskKind('DD RETURN CHARGE'), 'nsfFee');
    eq(E.riskKind('CHEQUE RETURNED UNPAID'), 'bouncedInstrument');
    eq(E.riskKind('GSI RECOVERY'), 'gsi');
    eq(E.riskKind('REVERSAL OF FAILED TRANSFER'), null);
    eq(E.riskKind('POS PURCHASE'), null);
  });

  /* end-to-end */
  test('stable sample: passes forensics and scores low risk', () => {
    const a = E.analyze(S.build('stable'));
    eq(a.forensics.status, 'pass');
    eq(a.scoring.months, 12);
    eq(a.score.band, 'Low risk');
    eq(a.score.manualReview, false);
    eq(a.score.confidence, 'High');
    eq(a.risk.bounceEvents, 0);
  });

  test('stressed sample: triggers the Nigerian risk flags and scores high risk', () => {
    const a = E.analyze(S.build('stressed'));
    eq(a.forensics.status, 'pass');
    eq(a.score.band, 'High risk');
    eq(a.risk.gsiRecoveries.length, 1);
    eq(a.risk.roundTrips.length >= 2, true, 'round trips');
    eq(a.risk.stacking.length >= 1, true, 'stacking');
    eq(a.risk.lenders.length >= 3, true, 'lenders');
    eq(a.risk.overdraftEpisodes >= 1, true, 'overdrafts');
    eq(a.risk.bounceEvents >= 1, true, 'bounces');
  });

  test('altered sample: same data caught at one line and forced to manual review', () => {
    const a = E.analyze(S.build('altered'));
    eq(a.forensics.status, 'fail');
    eq(a.forensics.breaks.length, 1);
    eq(a.forensics.breaks[0].diff, -50000000);
    eq(a.score.manualReview, true);
    eq(a.score.unverified, true);
    eq(a.score.confidence, 'Low');
  });

  test('stressed sample: round-tripped money does not inflate income', () => {
    const a = E.analyze(S.build('stressed'));
    const zenithIncome = a.txns.filter((t) => /ZENITH TRADERS/.test(t.desc) && t.category === E.CAT.REVENUE);
    eq(zenithIncome.length, 0);
  });

  test('score invariants: pillars add up, range holds, every reason has a code', () => {
    ['stable', 'stressed', 'altered'].forEach((key) => {
      const s = E.analyze(S.build(key)).score;
      const sum = s.pillars.reduce((t, p) => t + p.points, 0);
      eq(s.score, Math.max(0, Math.min(1000, sum)), `${key} sum`);
      eq(s.pillars.slice(0, 3).reduce((t, p) => t + p.max, 0), 1000, `${key} max`);
      s.reasons.forEach((r) => eq(/^[A-Z]{2}\d{2}$/.test(r.code), true, r.code));
    });
  });

  test('a short statement is scored but sent to manual review', () => {
    const a = E.analyze(HEADER + ',Opening Balance,,,1000.00\n01/02/2026,SALARY ACME,,500.00,1500.00\n20/02/2026,LOAN REPAYMENT,100.00,,1400.00\n');
    eq(a.complete, false);
    eq(a.score.manualReview, true);
    eq(a.windows[3], null);
  });

  test('no income: DTI points are zero and review is required, without crashing', () => {
    const rows = ['01/01/2026', '01/04/2026'].map((d, i) => `${d},POS/SHOPRITE,100.00,,${900 - i * 100}.00`).join('\n');
    const a = E.analyze(HEADER + ',Opening Balance,,,1000.00\n' + rows);
    eq(a.score.reasons.find((r) => r.code === 'DL01').points, 0);
    eq(a.score.manualReview, true);
  });

  /* PDF layout, using hand-placed text so these run without a real file */
  function textAt(str, x, y, w) {
    return { str, x0: x, x1: x + (w || str.length * 5), y, h: 10 };
  }

  const PDF_HEADER = (y) => [textAt('Trans Date', 40, y), textAt('Narration', 110, y), textAt('Debit', 340, y, 30), textAt('Credit', 410, y, 30), textAt('Balance', 480, y, 40)];

  test('pdf: columns come from the header, and right-aligned money lands correctly', () => {
    const built = window.BankPdf.buildRows([[
      textAt('Account Statement', 40, 800), textAt('Total Debits 999.00', 40, 780),
      ...PDF_HEADER(700),
      textAt('01/02/2026', 40, 680), textAt('POS/SHOPRITE', 110, 680), textAt('100.00', 340, 680, 30), textAt('900.00', 490, 680, 30),
      textAt('02/02/2026', 40, 660), textAt('SALARY ACME', 110, 660), textAt('500.00', 410, 660, 30), textAt('1,400.00', 480, 660, 40),
    ]]);
    eq(built.rows.length, 3, 'rows, with text above the table ignored');
    eq(built.rows[1][2], '100.00', 'debit');
    eq(built.rows[1][3], '', 'empty credit');
    eq(built.rows[2][3], '500.00', 'credit');
    eq(built.rows[2][6], '1,400.00', 'balance');
  });

  test('pdf: wrapped narrations join, amounts inside narrations stay text, footers are dropped', () => {
    const built = window.BankPdf.buildRows([[
      ...PDF_HEADER(700),
      textAt('01/02/2026', 40, 680), textAt('NIP/TRF TO AMINA', 110, 680), textAt('100.00', 340, 680, 30), textAt('900.00', 490, 680, 30),
      textAt('FOR NGN 100.00 RENT', 110, 668),
      textAt('Page 1 of 2', 280, 40),
    ]]);
    eq(built.rows.length, 2);
    eq(built.rows[1][1], 'NIP/TRF TO AMINA FOR NGN 100.00 RENT');
    eq(built.rows[1][2], '100.00');
  });

  test('pdf: tables spanning pages, with and without repeated headers', () => {
    const row = (d, y) => [textAt(d, 40, y), textAt('POS', 110, y), textAt('100.00', 340, y, 30), textAt('900.00', 490, y, 30)];
    const built = window.BankPdf.buildRows([[...PDF_HEADER(700), ...row('01/02/2026', 680)], [...PDF_HEADER(700), ...row('02/02/2026', 680)], row('03/02/2026', 700)]);
    eq(built.rows.length, 4);
    eq(built.pages[3], 3, 'source page');
  });

  test('pdf: a header split over two lines is recognised', () => {
    const built = window.BankPdf.buildRows([[
      textAt('Transaction', 40, 712), textAt('Withdrawal', 340, 712, 40), textAt('Deposit', 410, 712, 30),
      textAt('Date', 40, 700), textAt('Description', 110, 700), textAt('Amount', 340, 700, 30), textAt('Amount', 410, 700, 30), textAt('Balance', 480, 700, 40),
      textAt('01/02/2026', 40, 680), textAt('POS', 110, 680), textAt('100.00', 340, 680, 30), textAt('900.00', 490, 680, 30),
    ]]);
    eq(built.foundHeader, true);
    eq(built.rows[1][2], '100.00');
  });

  test('pdf: an opening balance row is kept for the balance check', () => {
    const built = window.BankPdf.buildRows([[
      ...PDF_HEADER(700),
      textAt('Opening Balance', 110, 690), textAt('1,000.00', 480, 690, 40),
      textAt('01/02/2026', 40, 680), textAt('POS', 110, 680), textAt('100.00', 340, 680, 30), textAt('900.00', 490, 680, 30),
    ]]);
    const a = E.analyze({ ...built, source: 'pdf' });
    eq(a.forensics.openingSource, 'declared');
    eq(a.forensics.status, 'pass');
  });

  test('pdf: document checks flag editing tools, later changes, and extra revisions', () => {
    const w = window.BankPdf.documentWarnings;
    eq(w({ Producer: 'iText 7' }, 1).length, 0, 'clean');
    eq(/general-purpose/.test(w({ Producer: 'Canva' }, 1)[0]), true, 'tool');
    eq(/saved revisions/.test(w({}, 3)[0]), true, 'revisions');
    eq(w({ IsLinearized: true }, 2).length, 0, 'linearized files normally have two markers');
  });

  test('pdf: document warnings send a clean statement to review', () => {
    const a = E.analyze({ rows: [['Date', 'Narration', 'Debit', 'Credit', 'Balance'], ['', 'Opening Balance', '', '', '1000.00'], ['01/02/2026', 'POS', '100.00', '', '900.00']], pages: [null, 1, 1], source: 'pdf', warnings: ['Edited.'], document: null });
    eq(a.forensics.status, 'review');
  });

  test('pdf: widespread breaks are reported as a likely misread, a few as a mismatch', () => {
    const rows = [['Date', 'Narration', 'Debit', 'Credit', 'Balance'], ['', 'Opening Balance', '', '', '1000.00']];
    for (let i = 1; i <= 5; i++) rows.push([`0${i}/02/2026`, 'POS', '100.00', '', '5.00']);
    const pages = rows.map(() => 1);
    const many = E.analyze({ rows, pages, source: 'pdf' });
    eq(many.forensics.likelyMisread, true);
    eq(/misread/.test(many.score.reviewReasons[0]), true);
    const csv = E.analyze(rows.map((r) => r.join(',')).join('\n'));
    eq(csv.forensics.likelyMisread, false, 'CSV is not subject to layout misreads');
  });

  const failed = results.filter((r) => !r.ok);
  const out = document.getElementById('results');
  out.textContent = `RESULT: ${results.length - failed.length}/${results.length} passed\n` + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.message}`}`).join('\n');
})();
