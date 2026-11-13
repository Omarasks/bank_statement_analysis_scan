Build a production-grade, full-stack bank statement analysis and credit scoring web application. 

### Core Tech Stack & Architecture
- Frontend: React / Next.js with Tailwind CSS for a clean, modern, enterprise dashboard UI.
- Backend/API: Python/FastAPI if preferred to handle document processing, parsing, and scoring logic.
- Database: PostgreSQL (or lightweight local SQLite for initial setup) to store tenant data, parsed transactions, analysis histories, and credit score logs.

### Detailed Feature Requirements to Implement:

1. Ingestion & Fraud Forensics Module
- Support multi-format statement ingestion (PDF uploads, scanned files, CSVs).
- Implement a forensic validation check that programmatically verifies math balances line-by-line: Opening Balance + Total Credits - Total Debits = Closing Balance. Flag mathematical anomalies or metadata signs of document editing.

2. NLP Transaction Enrichment Engine
- Build an categorization pipeline that normalizes messy bank transaction description strings (e.g., merchant name extraction).
- Auto-classify rows into a granular taxonomy: Operational Expenses, Debt Service/EMIs, Utilities, Payroll, Discretionary Spend, and Inflows (differentiating true operating revenue from transfers, tax refunds, or loan payouts).

3. Cash-Flow Analytics & Financial Metrics Engine
- Compute core underwriting metrics over 3-, 6-, and 12-month trailing windows:
  - Average Daily Balance (ADB) and balance stability trend.
  - Fixed Obligation to Income Ratio (FOIR) / Debt-to-Income (DTI).
  - Net cash-flow volatility, burn rate, and liquidity buffer days.

4. Risk & Behavioral Anomaly Detection
- Automatically track and flag risk indicators:
  - Bounced instruments, NSF (Non-Sufficient Funds) fees, overdraft counts, and failed direct debits.
  - Circular money-moving / round-tripping patterns for business accounts.
  - Proximity of micro-loan/instant lender cash drops right before debt service dates.

5. Dynamic Scoring & Underwriter Dashboard
- Output a composite risk score (e.g., 0-1000 scale) weighted across Income Stability, Debt Load, Cash-Flow Health, and Risk Penalties.
- Create an interactive underwriter dashboard view that displays summary KPIs, visual cash-flow charts, itemized transaction tables with search/filters, and Explainable AI (XAI) reason codes justifying the assigned score.

Please start by initializing the project structure, setting up the configuration files, and building out the core backend document processing and scoring logic first.
