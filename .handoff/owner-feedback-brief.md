# Head office, CEO approvals and the Storefront editor: decisions for you

## 1. What I found

**Head office.** servd has no head office today, only scattered pieces:
- a "head office" tick on departments
- cost-share notes on positions
- the "JV pays GS Foods 500k for head office salaries" record under Workforce → Positions

None of these reach the books. Head office staff are GS Foods employees, so GS Foods' P&L carries the whole cost and the other companies carry none. Someone who works across companies has to be added to each company by hand. Their reporting line also stops at the company edge, so an HOD can't approve leave for someone in another company.

**CEO and F&B manager are mixed together.** Your CEO tools (companies, logins, module access, company rules) sit inside Operations, next to kitchen, menu, stock and the till. You can't hand Operations to an F&B manager without also handing over control of the company.

**Your approvals.** They exist, but they are spread over about seven screens: new logins, website changes, purchase orders, recipes, payroll, tip pools and HR requests. The sidebar shows only two of them, and only when something is waiting. "My approvals" is hidden from you because you have no employee record. No approval can be handed to anyone else, because each one is locked to a role in the code.

**Storefront.** I tested it end to end on a local copy. When everything around it is running, editing, pop-ups, approval and going live all work. It fails today for five reasons, all fixable:
1. The editor only opens while servd.pk is up, because it loads its list of page parts from the live site. The site is down now, so you get a blank error.
2. Submitting or approving a page nobody has edited yet fails with "not found".
3. Every Delete button in the admin fails, not just in Storefront.
4. The marketing team sees empty brand page lists, because they aren't allowed to read the brand list.
5. Image uploads need cloud storage set up on the live server, and nothing warns you when it isn't.

Even with those fixed, it isn't a design tool:
- The middle of the screen is a list of labelled cards, not a picture of the page.
- There are no resize handles, no alignment guides and no free placement.
- Scroll animation is only "fade in once when it appears". Nothing moves with the scroll.

The "Adobe clone" you mentioned is probably ArtCraft (an early test version released this month). It doesn't build websites, so we'd borrow how it feels (layers, guides, a timeline), not the software itself.

## 2. Decisions you need to make

**D1. What is a head office?**
- **(a) Recommended:** each head office is its own unit in servd, with its own payroll and books. HODs are employed there. Each month servd charges every company its share in the books.
  - You create head offices and choose which companies sit under each. Only the CEO can do this.
  - It replaces the JV 500k record, the department tick and the cost-share notes, and those old pieces are removed.
- **(b)** GS Foods keeps paying the salaries and servd charges the other companies back. This is smaller, but HODs stay GS Foods staff.
- **(c)** Only put the existing JV record into the books. This is the smallest change, and you don't get a real head office.

Also tell me:
- How the cost is split: a fixed %, by each company's sales, or a fixed amount.
- Whether one company can sit under two head offices.
- Whether HODs only see their companies, or can also edit and approve in them.

*For Monday:* none of these go live by Monday. Option (a) needs your CA to name the "due to / due from head office" accounts and pick a month to move payroll over.

**D2. Separating CEO from F&B manager**
- **(a) Recommended:** a new "CEO" section holding Approvals, Companies & head offices, Logins & access, and Company rules. Operations goes to the F&B manager role. You still see everything. Company rules (selfie/geofence, tip split, service charge) stay CEO-only.
- **(b)** Keep things as they are and only add a link to your approvals.

Also tell me: should the F&B manager be able to add kitchen stations and sign off recipes without you? Today both need you.

*For Monday:* (a) can be ready.

**D3. One approvals inbox, and handing approvals to HODs**
- **(a) Recommended:** one Approvals page that shows every type of approval.
  - It replaces "My approvals", and the old page sends people to the new one.
  - Then you can hand any approval type to a named head office person, for one company, with an optional end date. You can take it back at any time, and every hand-over is recorded.
  - Each item stays in its own module, so nothing is copied.
- **(b)** The inbox only, with no hand-over.

What I suggest you can hand over: purchase orders, recipes, website publishing, HR final sign-off, payroll, tip pools, bank adjustments and new floor or kitchen logins.

What I suggest stays yours: module access, companies and head offices, logins for managers and above, reopening a closed month, tax go-live, and reversing journals.

Today's rule is "nothing publishes on the website without the CEO". Please confirm that you want to change it.

*For Monday:* the inbox can be ready. Hand-over comes later, because it needs head office to exist so servd knows who the HODs are.

**D4. Storefront editor**
- **(a) Recommended:** upgrade the existing module rather than replace it.
  - The middle of the screen shows the real page. You click to select, drag, resize with handles, line things up with guides, switch between phone and desktop, undo, and drop a file onto an element. Pop-ups show in their real frame.
  - Later we add a "free design box" for heroes, banners and pop-ups, where you place things anywhere, Canva-style.
  - Scroll effects come from a gallery of presets: parallax, fade or grow as you scroll, pin and reveal, sticky stack, sideways pan and text reveal. A slider lets you preview each one. A keyframe timeline comes later.
- **(b)** Drop in a ready-made website builder. It would look good faster, but it creates a second content system. It would break the mobile app, the brand rules and approvals, and the current module would have to be removed. Not recommended.
- **(c)** Fix the bugs only.

Also tell me:
- Should marketing be limited to each brand's own colours and fonts?
- Is it OK if the mobile app shows a simpler version of the fancy scroll effects?
- May we add one small free animation library?
- Is image storage set up on the live server?
- Should the F&B manager have Storefront access?
- Could you resend the screenshot?

*For Monday:* the bug fixes can be live. The visual editor takes weeks.

## 3. What I'd build, in order

**Before Monday**
1. Storefront fixes: the editor opens even when servd.pk is down; untouched pages can be approved; Delete buttons work across the admin; marketing sees the brands; a storage check with a clear message; honest error text. *Small.*
2. Pop-ups tested end to end, plus a "test this pop-up now" button. *Small.*
3. The CEO section, with Operations handed to the F&B manager role. *Small.*
4. One Approvals page in the CEO section. *Medium.*

**After Monday**
5. The real page shown inside the editor, with click to select and a phone/desktop switch. *Medium, about 1 week.*
6. Scroll effect presets with the preview slider. *Medium.*
7. Drag, resize, guides, undo and drop-a-file, plus the brand colour lock and a brand check before submitting. *Large, 2–3 weeks.*
8. Head office: create head offices, link companies, give HODs access, and post monthly charges once the CA names the accounts. The old JV record and head office ticks are removed. *Large.*
9. Handing approvals to HODs. *Medium to large.*
10. The free design box, the keyframe timeline, and designed pages showing in the mobile app. *Extra large.*
