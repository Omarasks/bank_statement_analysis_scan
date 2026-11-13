# Statement Underwriter (miniature)

Quick analysis and scoring of Nigerian bank statements. It runs entirely in the browser, with no install, server, or network calls, so statements never leave the machine.

## Run it

- **App:** open `index.html` in Edge or Chrome, then upload the bank's PDF (or a CSV) or pick a sample. Try the synthetic files in `sample-pdfs/`.
- **Tests:** open `tests.html`. The first line shows the pass count.

## Files

| File | Purpose |
|---|---|
| `engine.js` | Parsing, forensics, categorization, metrics, risk flags, and scoring. No DOM access. |
| `pdf-reader.js` | Reads text-based PDFs into rows by finding columns from the header's position, and checks PDF metadata |
| `vendor/pdfjs/` | PDF.js 3.11.174, stored locally so no statement data or requests go over the network |
| `app.js`, `index.html` | The underwriter dashboard |
| `samples.js` | Synthetic statements: stable, stressed, and altered |
| `tests.js`, `tests.html` | Engine tests |

Scorecard weights, thresholds, and penalties are in `CONFIG` at the top of `engine.js`. Narration and lender patterns are the `*_RE` constants below it.

## Scorecard (`ng-retail-mini-0.1`)

| Pillar | Points | Based on |
|---|---|---|
| Income Stability | 300 | Months with income, income variability |
| Debt Load | 300 | FOIR / DTI (full points at 33% or less, none at 70% or more) |
| Cash-Flow Health | 400 | Liquidity buffer, net cash-flow volatility and margin, balance trend |
| Risk Penalties | Deduction | Failed payments, overdrafts, loan cash before repayment, circular transfers, GSI recoveries, many digital lenders |

Bands: 750+ low, 600-749 moderate, 400-599 elevated, under 400 high.

A failed balance check, an uncheckable statement, a statement under 3 months, or no identifiable income sends the result to manual review. Betting spend is shown to the underwriter but not scored.

## Known limits

- **Not tested on real bank statements.** PDF reading, parsing, and categorization have only seen synthetic files. Layouts that may need work include a date centered beside a multi-line narration, which can attach narration text to the wrong row.
- **No scanned PDFs yet.** Scans, photos, and Excel files are refused with a message. Adding scans needs OCR.
- **PDF metadata is a weak signal.** It sends a statement to review but is not proof of tampering. Which tools are normal for each bank still has to be learned from real statements.
- **PDF.js is an older build.** 3.11.174 is the last classic-script release, which lets the app run from a file with no server. It is affected by CVE-2024-4367, so `isEvalSupported: false` (the documented mitigation) is always set. Upgrade when this moves to a server. PDFs are also parsed on the page's thread, so a very large file can freeze the tab briefly.
- **The scorecard is not validated.** Weights and thresholds are expert starting points, not fitted to repayment outcomes.
- **Lender and biller lists need review.** They are starter lists and will go out of date.
- **Income can be misjudged.** Regular transfers count as inferred income, which a family member's support could trigger, and one-off informal income is left out.
- **The balance check is arithmetic only.** A careful forger can keep the numbers consistent.
- **One statement, retail borrowers.** No multi-account view, accounts, tenants, or saved history.
