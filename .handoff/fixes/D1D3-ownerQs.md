None of these blocks the build. Items 1–8 must be answered before the monthly charge is switched on. Items 9–21 shape the defaults; the proposed default is shown in brackets.

**For you and your CA (chartered accountant)**

1. **What is charged each month.** The proposal is everything the head office actually spends that month, from its own books, at cost with no markup. That covers salaries (including employer EOBI/SESSI), rent, utilities, software, professional fees and depreciation. Variances, FX gains and losses, and gains or losses on selling assets would be left out. Your CA can add or remove accounts. Do you agree, or should only salaries be charged?
2. **How the percentages add up.** Each head office's % table may total 100% or less, never more. Anything left over stays as the head office's own cost, for example work you do as owner that the companies should not pay for. We recommend exactly 100%, so the head office nets to zero each month. Should 100% be required?
3. **How the head office records the charge.** Two options:
   - **Costs recharged (recommended):** a "Head office costs recharged to companies" account (6990) that reduces its costs. This keeps the All-companies P&L right with no extra work.
   - **Recharge income:** a revenue account. This is the usual presentation for a separate legal company, but the All-companies view would then show the charge as both income and cost until eliminations are built.

   Which does your CA want?
4. **Account names and codes.** servd pre-fills these for the CA to check and rename:
   - head office: "Due from <company>" (1400–1449);
   - companies: "Due to <head office>" (2100–2149) and "Head office charges — <head office>" (6200–6249).

   Should a company under two head offices have one "Head office charges" line per head office (proposed) or a single shared line?
5. **Tax.** Is the monthly charge a taxable service (Sindh or Punjab sales tax on services), or subject to income-tax withholding? If yes, tax lines and a recharge invoice must be added before posting is switched on.
6. **Legal status and current payments.**
   - Is each head office its own company on paper, with its own NTN and its own bank account to pay salaries from? Until it has one, which company pays, and how is it repaid?
   - Has GS x Viva actually been paying GS Foods PKR 500,000 a month? If so, how is that booked today? Do we need opening intercompany balances?
7. **Cutover month.** From which month are head-office staff employed and paid by the head office and charged to the companies?
8. **Moving people.**
   - Do they keep their original joining date (continuity of service, gratuity, leave)?
   - Do their leave balances carry over?
   - Who re-registers EOBI and SESSI?
   - Outstanding loans are settled before the move. Agree?

**Your decisions**

9. **Starting set-up.** One "GS Head Office", with GS Foods at 37.5% and GS x Viva at 62.5%? This reproduces today's 300k / 500k exactly.
10. **Monthly approval.** Should each month's charge wait for your approval in Approvals → Finance (proposed), or post automatically once you switch it on?
11. **What head-office staff can do in the companies they serve.**
    - **Proposed:** they can see everything their modules allow and send changes for approval. Direct changes need you to make them a member of that company.
    - When they move to the head office, should their existing direct memberships of GS Foods and GS x Viva be removed (proposed: yes)? Any exceptions?
12. **Purchase orders and stock transfers.**
    - Purchase orders raised through head office always need approval, even below the company's limit (proposed: yes).
    - Stock transfers requested through head office stay with the company's managers, as today (proposed), or should they come to you?
13. **Company approvers.** Company co-owners and GMs keep approving their own company's staff's recipes, payroll and HR steps. Anything a head-office HOD submits comes only to you or to the HOD you hand that section to (proposed). OK?
14. **Procurement section.** Is Procurement its own approval section, matching the head-office Procurement department (proposed), or part of Operations?
15. **Logins.** Only floor logins (cashier, server, line cook, kitchen, expo) can be handed to the Operations HOD. Every password login (managers and above, owner, finance, HR, marketing, brand manager, procurement, IT) stays yours. Agree?
16. **Website.** Once you hand Marketing over, may the Marketing HOD publish each company's brand pages? The rule would become "nothing goes live without the CEO or the CEO's Marketing delegate". servd.pk's own pages stay yours. This is built but stays switched off until you say yes.
17. **IT.**
    - Should an IT HOD's changes to a company's POS connector settings need your approval (proposed: yes, as change requests)?
    - The WhatsApp gateway is one setting for all companies. Keep it with you and IT directly, as today?
18. **HR sign-off.**
    - Until you hand HR over, the final HR sign-off in each company comes to you, and head-office HR can do the earlier review steps (proposed).
    - Do you want a "Management approval" step added to leave, overtime, attendance corrections or resignations? This is a format setting, not code.
19. **Own payslips.** Nobody but you may approve a payroll that includes their own payslip. This also applies to company GMs today, and it means the head office's own payroll always comes to you. Agree?
20. **Hand-over rules.**
    - A company under two head offices: only one head office's HOD may hold a given section's approvals for that company at a time (proposed). Agree?
    - Default scope of a hand-over: the whole head office, including companies linked later (proposed), or one company at a time?
    - Is the HOD's approval final, or do you want a second sign-off above an amount?
21. **Later steps. Do you want any of these?**
    - Outlet staff reporting to a head-office HOD (a reporting line across companies).
    - Head-office marketing's campaign sends and promos needing approval (this adds a pending state to campaigns).
    - Eliminating intercompany balances in the All-companies balance sheet.

**Duplicates and clean-ups (standing rule)**

22. Two "budgeted labour" calculations exist (lib/labour-budget.ts and projections/labour.ts). Both will use one new head-office helper. OK to merge the two into one?
23. The existing cost-allocation tool splits a cost between brands inside one company. We keep it beside the head-office charge, and companies can use it to spread their head-office charge over their brands. Agree?
24. The 42C commissary and other "contribution" records stay as planning numbers. Should the commissary later become its own shared unit like a head office? Should new "shared services" contributions be refused, since that is now the head office's job?
25. The JV positions at GS x Viva carry notes about the partners' 40/60 internal split. They disappear from screens along with the other cost-share notes. Keep showing them read-only?
26. Creating companies becomes CEO-only (today any login can). Confirm.
27. Dashboards: each company's head-office charge shows as its own line, not inside labour % (proposed). Should the head office's non-salary costs (rent, software) also appear in planning budgets? Version 1 plans salaries only, as today.