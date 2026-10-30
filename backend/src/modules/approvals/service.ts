// The approvals inbox: run every provider the user may approve, keep only the
// companies in view (plus what a live hand-over covers), group by section and
// count per type. Read-only — see README.md.
//
// Who sees what (spec §7.6; owner, 2026-10-30: each request only in the tab of
// whoever must act on it NOW):
//  • The CEO: every item in their companies at the CEO's step — never one of a
//    type where the CEO is only an override (APPROVAL_RIGHTS.overrideRoles:
//    finance's payroll review / voucher approval, a manager's stock transfer)
//    while someone else may decide it (lib/approvalRights.ts ceoMustSee, the
//    bell's rule). HR steps: /hr/approvals already applies hrStepApprovers. Items a live hand-over covers
//    (and whose delegate did not submit them) are "handed over": collapsed per
//    section, counted in `handedOver`, never in `total`; the CEO can still act
//    on them. `view: 'all'` lists them inline.
//  • A delegate: the items of their handed-over types in the covered companies,
//    whatever the view, labelled by company — only those one of their own live
//    delegations covers by delegationCovers (section never 'ceo', ownership,
//    A13), so the list matches what the approve route accepts; never their own
//    submissions; never a company-less row (CEO only).
//  • Company role approvers: as before, minus items that came through a head
//    office (lib/approvalRights.ts throughHeadOfficeBatch — one batched lookup).
// With no head office and no hand-over this is exactly the inbox it was.

import { prisma } from '../../lib/prisma.js'
import { APPROVAL_PROVIDERS } from './providers.js'
import { testTenantIds } from '../../lib/testCompany.js'
import {
  APPROVAL_RIGHTS, APPROVAL_SECTIONS, APPROVAL_SECTION_TITLES, adminIsOverride, ceoMustSee, delegationCovers, sectionOf, throughHeadOfficeBatch,
} from '../../lib/approvalRights.js'
import { NO_DELEGATIONS, type ApprovalDelegations, type HandOverIndex } from './delegations.js'
import type {
  ApprovalInbox, ApprovalItem, ApprovalProvider, ApprovalSection, ApprovalSectionSummary, ApprovalType, ApprovalTypeSummary, ProviderContext,
} from './types.js'

/**
 * May this user approve this type at all? The module's own approver roles
 * (APPROVAL_RIGHTS) — or a live delegation of the type. Per-item types (HR
 * steps) are always asked: the module decides each row.
 */
export function mayApprove(p: ApprovalProvider, role: string, delegated: ReadonlySet<ApprovalType>): boolean {
  if (p.approverRoles === null) return true
  return (p.approverRoles as readonly string[]).includes(role) || delegated.has(p.type)
}

export interface CollectOptions {
  /** Only this type (the page's filter). Counts still cover every type. */
  only?: ApprovalType
  /** Only this section (the page's filter). Counts still cover every type. */
  section?: ApprovalSection
  /** 'all': the CEO's handed-over items are listed inline (still not in `total`). */
  view?: 'all'
  delegations?: ApprovalDelegations
  providers?: readonly ApprovalProvider[]
}

type Kept = { item: ApprovalItem; byDelegation: boolean }

/**
 * The company an item is checked against for hand-overs: its tenantId, else
 * (a component recipe, A21) the owner of the companies it derives — the same
 * one approvalSubject gives the approve route. Null = CEO only.
 */
function handOverTenant(i: ApprovalItem): string | null {
  if (i.tenantId) return i.tenantId
  const touches = i.touchesTenantIds ?? []
  return touches.length ? (i.ownerTenantId ?? touches[0]!) : null
}

export async function collectApprovals(ctx: ProviderContext, opts: CollectOptions = {}): Promise<ApprovalInbox> {
  const providers = opts.providers ?? APPROVAL_PROVIDERS
  const delegations = opts.delegations ?? NO_DELEGATIONS
  const delegatedTypes = await delegations.typesFor(ctx.user.id, ctx.tenantIds)
  const delegatedTenants = ctx.delegated ?? (delegations.tenantsByType ? await delegations.tenantsByType(ctx.user.id) : new Map())
  const inView = new Set(ctx.tenantIds)
  const member = new Set(ctx.memberTenantIds)
  // Spec §7.6: a type spanning member companies (HR) widens to member ∪ reach ∪ delegated.
  const reach = new Set(ctx.reachTenantIds ?? [])
  const isAdmin = ctx.user.role === 'admin'
  const eligible = providers.filter((p) => mayApprove(p, ctx.user.role, delegatedTypes))
  // Test companies are left out of "All companies" (lib/testCompany.ts), so
  // their queues never count as waiting "elsewhere" either.
  const tests = await testTenantIds()

  const results = await Promise.all(eligible.map(async (p) => {
    try {
      const loaded = await p.load(ctx)
      // The module's queue route refused this user (their role, or the CEO's
      // Module Access switch): not one of their types.
      if (loaded === null) return { p, kept: [] as Kept[], elsewhere: 0, error: false, refused: true }
      // Owner, 2026-10-30: the CEO sees an item of a type where the CEO is only
      // an override (finance's review, a store manager's transfer) once it is at
      // the CEO's end or nobody else may decide it — never at someone else's step.
      let rows = loaded
      if (isAdmin && adminIsOverride(p.type)) {
        const see = await ceoMustSee(p.type, loaded.map((i) => ({
          tenantId: i.tenantId, submittedByIds: i.submittedByIds ?? [], viaHeadOfficeId: i.viaHeadOfficeId ?? null, submittedAt: i.waitingSince,
        })))
        rows = loaded.filter((_, n) => see[n])
      }
      const byRole = p.approverRoles === null || (p.approverRoles as readonly string[]).includes(ctx.user.role)
      const del = delegatedTenants.get(p.type)
      // Counts are per company in view — except a type whose module's queue
      // spans every company the user belongs to (HR steps), which stays
      // bounded by membership. A row with no company is the module's own
      // legacy case (a company-less signup, an orphan supplier, a shared site
      // page) that its queue route already chose to show. A hand-over's
      // companies are kept whatever the view.
      const keepRole = (id: string) => byRole && (p.spansMemberCompanies ? member.has(id) || reach.has(id) || inView.has(id) : inView.has(id))
      const kept: Kept[] = []
      for (const i of rows) {
        // A company-less row is CEO-only by definition (shared servd:* pages,
        // company-less recipes and logins): kept only on the role path.
        // A component recipe (tenantId null, derived companies) may still be
        // a delegate's through its derived company (checked in full below).
        const via = handOverTenant(i)
        if ((i.tenantId === null && byRole) || (i.tenantId !== null && keepRole(i.tenantId))) kept.push({ item: i, byDelegation: false })
        else if (via !== null && del?.has(via)) kept.push({ item: i, byDelegation: true })
      }
      // Other companies of the user's own: counted (never listed) so the page
      // can point at "All companies".
      const elsewhere = rows.filter((i) => i.tenantId !== null && !keepRole(i.tenantId) && !del?.has(i.tenantId)
        && (member.has(i.tenantId) || (p.spansMemberCompanies && reach.has(i.tenantId))) && !tests.has(i.tenantId)).length
      return { p, kept, elsewhere, error: false, refused: false }
    } catch {
      return { p, kept: [] as Kept[], elsewhere: 0, error: true, refused: false }
    }
  }))

  // Every kept item gets its section — before any hand-over check, which
  // depends on it (a password-role login, a reversal, a company-less row → 'ceo').
  for (const r of results) for (const { item } of r.kept) item.section ??= sectionOf(item.type, { tenantId: item.tenantId })

  // Company role approvers (not the CEO): an item that came through a head
  // office is the CEO's or that head office's delegate's (A3) — not theirs.
  // Stock transfers are exempt; per-item types (HR steps, the HOD signature)
  // are decided by their own module's queue. One that their own hand-over may
  // cover becomes a hand-over candidate, checked below like every other.
  const throughOf = new Map<ApprovalItem, string[]>()
  if (!isAdmin) {
    const subject: Kept[] = []
    for (const r of results) {
      const right = APPROVAL_RIGHTS[r.p.type]
      if (right.exemptThroughHeadOffice || right.perItem) continue
      for (const k of r.kept) if (!k.byDelegation && k.item.tenantId) subject.push(k)
    }
    if (subject.length) {
      const through = await throughHeadOfficeBatch(subject.map((k) => ({
        tenantId: k.item.tenantId, submittedByIds: k.item.submittedByIds ?? [], viaHeadOfficeId: k.item.viaHeadOfficeId ?? null,
        submittedAt: k.item.waitingSince,
      })))
      const drop = new Set<Kept>()
      subject.forEach((k, n) => {
        const ids = through[n] ?? []
        throughOf.set(k.item, ids)
        if (ids.length === 0) return
        if (delegatedTenants.get(k.item.type)?.has(k.item.tenantId!)) { k.byDelegation = true; return }
        drop.add(k)
      })
      if (drop.size) for (const r of results) r.kept = r.kept.filter((k) => !drop.has(k))
    }
  }

  // Items kept by a hand-over (spec §7.6, A4, A13): only when one of the
  // viewer's own live delegations covers the item exactly as the approve
  // route's delegationCovering will — section (never 'ceo'), ownership, every
  // touched company, and A13 (an item through another head office is not
  // theirs). Never their own submissions (separation of duties). This runs
  // AFTER the through-head-office block, so items it moved here are checked too.
  const delegatedKept = results.flatMap((r) => r.kept.filter((k) => k.byDelegation))
  if (delegatedKept.length) {
    const own = delegations.asDelegate ? await delegations.asDelegate(ctx.user.id) : null
    const candidates = own && own.delegations.length
      ? delegatedKept.filter((k) => !(k.item.submittedByIds ?? []).includes(ctx.user.id) && k.item.section !== 'ceo' && handOverTenant(k.item))
      : []
    const need = candidates.filter((k) => APPROVAL_RIGHTS[k.item.type].ownership === 'company' && !throughOf.has(k.item))
    if (need.length) {
      const through = await throughHeadOfficeBatch(need.map((k) => ({
        tenantId: handOverTenant(k.item), submittedByIds: k.item.submittedByIds ?? [], viaHeadOfficeId: k.item.viaHeadOfficeId ?? null,
        submittedAt: k.item.waitingSince,
      })))
      need.forEach((k, n) => throughOf.set(k.item, through[n] ?? []))
    }
    const keep = new Set<Kept>()
    for (const k of candidates) {
      const i = k.item
      const tenant = handOverTenant(i)!
      const headOfficeOwned = APPROVAL_RIGHTS[i.type].ownership === 'head_office'
      const owner = headOfficeOwned ? (i.ownerTenantId ?? tenant) : tenant
      const base = i.touchesTenantIds?.length ? i.touchesTenantIds : [tenant]
      const touches = headOfficeOwned ? Array.from(new Set([...base, tenant])) : base
      const item = {
        tenantId: owner, touchesTenantIds: touches, section: i.section,
        throughHeadOfficeIds: headOfficeOwned ? [] : (throughOf.get(i) ?? []),
      }
      if (own!.delegations.some((d) => delegationCovers(d, i.type, item, own!.linked))) keep.add(k)
    }
    for (const r of results) r.kept = r.kept.filter((k) => !k.byDelegation || keep.has(k))
  }

  // The CEO: what a live hand-over covers is "handed over".
  const handOver: HandOverIndex | null = isAdmin && delegations.handedOver
    ? await delegations.handedOver({ id: ctx.user.id, role: ctx.user.role, memberTenantIds: ctx.memberTenantIds })
    : null
  const handedOver = new Set<ApprovalItem>()
  if (handOver && handOver.delegations.length) {
    const candidates = results.flatMap((r) => r.kept.map((k) => k.item))
      .filter((i) => handOverTenant(i) && APPROVAL_RIGHTS[i.type].delegable && i.section !== 'ceo')
    const through = await throughHeadOfficeBatch(candidates.map((i) => ({
      tenantId: handOverTenant(i), submittedByIds: i.submittedByIds ?? [], viaHeadOfficeId: i.viaHeadOfficeId ?? null, submittedAt: i.waitingSince,
    })))
    candidates.forEach((i, n) => {
      const tenant = handOverTenant(i)!
      const touches = i.touchesTenantIds?.length ? i.touchesTenantIds : [tenant]
      const d = handOver.delegations.find((x) => !(i.submittedByIds ?? []).includes(x.delegateUserId)
        && delegationCovers(x, i.type, {
          tenantId: APPROVAL_RIGHTS[i.type].ownership === 'head_office' ? (i.ownerTenantId ?? tenant) : tenant,
          touchesTenantIds: touches, section: i.section, throughHeadOfficeIds: through[n] ?? [],
        }, handOver.linked))
      if (!d) return
      i.handedOverTo = { userId: d.delegateUserId, name: d.delegateName, endsAt: d.endsAt ? d.endsAt.toISOString() : null, delegationId: d.id }
      handedOver.add(i)
    })
  }

  const types: ApprovalTypeSummary[] = []
  const items: ApprovalItem[] = []
  const handedOverItems: ApprovalItem[] = []
  const all: ApprovalItem[] = []
  for (const { p, kept, elsewhere, error, refused } of results) {
    if (refused) continue
    const rows = kept.map((k) => k.item)
    const mine = rows.filter((i) => !handedOver.has(i))
    const over = rows.length - mine.length
    // A per-item type with nothing for this user is not one of their types —
    // unless their role is one that type's steps name.
    const listed = p.approverRoles !== null || rows.length > 0 || elsewhere > 0 || error
      || (p.alwaysListFor ?? []).includes(ctx.user.role)
    if (!listed) continue
    types.push({
      type: p.type, label: p.label, module: p.module, link: p.link, count: mine.length,
      section: APPROVAL_RIGHTS[p.type].section,
      ...(elsewhere > 0 && { elsewhere }), ...(error && { error: true as const }), ...(over > 0 && { handedOver: over }),
    })
    all.push(...rows)
    const wanted = (i: ApprovalItem) => (!opts.only || opts.only === i.type) && (!opts.section || opts.section === i.section)
    for (const i of rows) {
      if (!wanted(i)) continue
      if (handedOver.has(i) && opts.view !== 'all') handedOverItems.push(i)
      else items.push(i)
    }
  }

  // Company names, for "All companies" view and delegated items.
  const ids = Array.from(new Set([...items, ...handedOverItems].map((i) => i.tenantId).filter((x): x is string => !!x)))
  if (ids.length) {
    const names = new Map((await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]))
    for (const i of [...items, ...handedOverItems]) i.companyName = i.tenantId ? (names.get(i.tenantId) ?? null) : null
  }
  // Oldest first within the page: what has waited longest is first.
  const byAge = (a: ApprovalItem, b: ApprovalItem) => (a.waitingSince ?? '').localeCompare(b.waitingSince ?? '')
  items.sort(byAge)
  handedOverItems.sort(byAge)

  // Sections: those with a listed type, an item or a hand-over.
  const sections: ApprovalSectionSummary[] = []
  for (const id of APPROVAL_SECTIONS) {
    const inSection = all.filter((i) => i.section === id)
    const delegates = (handOver?.delegations ?? []).filter((d) => d.section === id).map((d) => ({
      userId: d.delegateUserId, name: d.delegateName, endsAt: d.endsAt ? d.endsAt.toISOString() : null,
      headOfficeId: d.tenantId, companyTenantId: d.companyTenantId,
    }))
    if (inSection.length === 0 && delegates.length === 0 && !types.some((t) => t.section === id)) continue
    const over = inSection.filter((i) => handedOver.has(i)).length
    sections.push({ id, title: APPROVAL_SECTION_TITLES[id], count: inSection.length - over, handedOver: over, delegates })
  }

  return {
    total: types.reduce((n, t) => n + t.count, 0),
    elsewhere: types.reduce((n, t) => n + (t.elsewhere ?? 0), 0),
    types,
    items,
    sections,
    handedOver: handedOver.size,
    ...(handedOverItems.length > 0 && { handedOverItems }),
  }
}
