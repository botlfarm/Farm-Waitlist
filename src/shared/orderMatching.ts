import type { OrderItemLine, OrderRecord } from './types';

export function isStandingRecurringOrder(order: OrderRecord): boolean {
  return order.source === 'standing' || order.standingOrderId !== null;
}

function itemsMatchSignature(items: OrderItemLine[]): string {
  return [...items]
    .filter((i) => i.quantity > 0)
    .sort((a, b) => a.trackedItemId - b.trackedItemId)
    .map((i) => `${i.trackedItemId}:${i.quantity}`)
    .join('|');
}

/**
 * Scores how likely two active orders belong to the same customer (excluding recurring standing orders).
 */
export function scoreDuplicateOrder(target: OrderRecord, candidate: OrderRecord): number {
  if (isStandingRecurringOrder(target) || isStandingRecurringOrder(candidate)) {
    return 0;
  }
  let score = 0;

  if (
    target.odooPartnerId &&
    candidate.odooPartnerId &&
    target.odooPartnerId === candidate.odooPartnerId
  ) {
    score += 100;
  }

  const nameA = target.customerName.trim().toLowerCase().replace(/\s+/g, ' ');
  const nameB = candidate.customerName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (nameA && nameB) {
    if (nameA === nameB) {
      score += 90;
    } else if (
      nameA.length >= 4 &&
      nameB.length >= 4 &&
      (nameA.includes(nameB) || nameB.includes(nameA))
    ) {
      score += 40;
    } else {
      const partsA = nameA.split(' ');
      const partsB = nameB.split(' ');
      // Only treat first-name-only match as a likely duplicate when one side has no last name
      if (
        (partsA.length === 1 || partsB.length === 1) &&
        partsA[0].length >= 3 &&
        partsA[0] === partsB[0]
      ) {
        score += 25;
      }
    }
  }

  const emailA = (target.customerEmail || '').trim().toLowerCase();
  const emailB = (candidate.customerEmail || '').trim().toLowerCase();
  if (emailA && emailB && emailA === emailB) {
    score += 85;
  }

  const phoneA = (target.customerPhone || '').replace(/\D/g, '');
  const phoneB = (candidate.customerPhone || '').replace(/\D/g, '');
  if (phoneA.length >= 7 && phoneB.length >= 7 && phoneA === phoneB) {
    score += 80;
  }

  return score;
}

export interface ReplacementCandidate {
  order: OrderRecord;
  customerScore: number;
  rankScore: number;
  reasons: string[];
}

/**
 * Ranks active orders that could replace a cancelled/removed Odoo quotation
 * (e.g., a newly arrived storefront quotation in the waitlist for the same customer).
 */
export function findReplacementCandidates(
  missingOrder: OrderRecord,
  allActiveOrders: OrderRecord[]
): ReplacementCandidate[] {
  const dismissed = new Set(missingOrder.dismissedDuplicateOrderIds ?? []);
  const missingSig = itemsMatchSignature(missingOrder.items);
  const results: ReplacementCandidate[] = [];

  for (const candidate of allActiveOrders) {
    if (candidate.id === missingOrder.id) continue;
    if (candidate.status === 'ignored') continue;
    if (candidate.odooMissingFlagged) continue;
    if (
      dismissed.has(candidate.id) ||
      (candidate.dismissedDuplicateOrderIds ?? []).includes(missingOrder.id)
    ) {
      continue;
    }
    if (isStandingRecurringOrder(candidate)) continue;

    const customerScore = scoreDuplicateOrder(missingOrder, candidate);
    if (customerScore < 25) continue;

    let rankScore = customerScore;
    const reasons: string[] = [];

    if (candidate.source === 'odoo') {
      rankScore += 20;
    }
    if (candidate.status === 'waitlist') {
      rankScore += 18;
      reasons.push('new in waitlist');
    } else if (candidate.status === 'confirmed') {
      rankScore += 10;
      reasons.push('confirmed order');
    }

    const isNewerOdoo =
      candidate.odooQuotationId !== null &&
      missingOrder.odooQuotationId !== null &&
      (candidate.odooQuotationId > missingOrder.odooQuotationId ||
        Boolean(
          candidate.odooCreatedAtLocal &&
            missingOrder.odooCreatedAtLocal &&
            candidate.odooCreatedAtLocal > missingOrder.odooCreatedAtLocal
        ));
    if (isNewerOdoo) {
      rankScore += 15;
      if (!reasons.includes('new in waitlist')) {
        reasons.push('newer Odoo quotation');
      }
    }

    const candSig = itemsMatchSignature(candidate.items);
    if (missingSig && candSig && missingSig === candSig) {
      rankScore += 10;
      reasons.push('same items');
    }

    results.push({
      order: candidate,
      customerScore,
      rankScore,
      reasons,
    });
  }

  results.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    const idA = a.order.odooQuotationId ?? 0;
    const idB = b.order.odooQuotationId ?? 0;
    if (idB !== idA) return idB - idA;
    return b.order.id - a.order.id;
  });

  return results;
}

/**
 * Decides which side's Odoo quotation ID stays active/primary when merging two Odoo-backed orders:
 * 1. Active (non-missing) always beats cancelled/removed (`odooMissingFlagged`).
 * 2. Confirmed always beats unconfirmed.
 * 3. When both are active & unconfirmed (e.g., Waitlist draft + newly arrived replacement draft),
 *    the newer Odoo quotation becomes primary so cancelling the older waitlist draft later
 *    causes zero alerts and future syncs track the live replacement quotation.
 * 4. Otherwise, `target` remains primary.
 */
export function selectPrimaryOdooSide(
  target: Pick<
    OrderRecord,
    'odooQuotationId' | 'odooCreatedAtLocal' | 'status' | 'odooMissingFlagged'
  >,
  source: Pick<
    OrderRecord,
    'odooQuotationId' | 'odooCreatedAtLocal' | 'status' | 'odooMissingFlagged'
  >
): 'target' | 'source' {
  if (!target.odooQuotationId && source.odooQuotationId) return 'source';
  if (target.odooQuotationId && !source.odooQuotationId) return 'target';
  if (!target.odooQuotationId && !source.odooQuotationId) return 'target';

  // 1. Active always beats removed/cancelled in Odoo
  if (target.odooMissingFlagged && !source.odooMissingFlagged) return 'source';
  if (!target.odooMissingFlagged && source.odooMissingFlagged) return 'target';

  // 2. Confirmed always beats unconfirmed
  if (source.status === 'confirmed' && target.status !== 'confirmed') return 'source';
  if (target.status === 'confirmed' && source.status !== 'confirmed') return 'target';

  // 3. Two active unconfirmed quotations: prefer the newer quotation (e.g., new order replacing waitlist form)
  if (target.status !== 'confirmed' && source.status !== 'confirmed') {
    if (
      source.odooCreatedAtLocal &&
      target.odooCreatedAtLocal &&
      source.odooCreatedAtLocal !== target.odooCreatedAtLocal
    ) {
      return source.odooCreatedAtLocal > target.odooCreatedAtLocal ? 'source' : 'target';
    }
    if ((source.odooQuotationId ?? 0) > (target.odooQuotationId ?? 0)) {
      return 'source';
    }
  }

  return 'target';
}

/**
 * Builds the chronological chain of linked Odoo quotation/order references
 * from earliest waitlist quotation(s) to the active live Odoo order.
 */
export function buildOrderOdooChain(
  order: Pick<OrderRecord, 'odooQuotationName' | 'mergedOdooNames'>
): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];

  for (const name of order.mergedOdooNames ?? []) {
    const trimmed = name.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      chain.push(trimmed);
    }
  }

  const active = (order.odooQuotationName || '').trim();
  if (active && !seen.has(active)) {
    seen.add(active);
    chain.push(active);
  }

  return chain;
}

export interface MergeDateOptions {
  targetDate: string | null;
  targetDateKind: 'scheduled' | 'requested' | null;
  sourceDate: string | null;
  sourceDateKind: 'scheduled' | 'requested' | null;
  hasDifferentDates: boolean;
  recommendedSide: 'target' | 'source';
  recommendedDate: string | null;
}

/**
 * Resolves the effective dates of two orders being merged/replaced (considering both
 * scheduled `slottedDate` and waitlist `requestedDate`), detects whether both orders
 * have different dates, and recommends the active replacement/confirmed order's date
 * when merging a cancelled/missing pre-order with its actual order.
 */
export function resolveMergeDateOptions(
  target: Pick<
    OrderRecord,
    'slottedDate' | 'requestedDate' | 'status' | 'odooMissingFlagged'
  >,
  source: Pick<
    OrderRecord,
    'slottedDate' | 'requestedDate' | 'status' | 'odooMissingFlagged'
  >
): MergeDateOptions {
  const targetDate = target.slottedDate || target.requestedDate || null;
  const targetDateKind = target.slottedDate
    ? 'scheduled'
    : target.requestedDate
      ? 'requested'
      : null;

  const sourceDate = source.slottedDate || source.requestedDate || null;
  const sourceDateKind = source.slottedDate
    ? 'scheduled'
    : source.requestedDate
      ? 'requested'
      : null;

  const hasDifferentDates = Boolean(targetDate && sourceDate && targetDate !== sourceDate);

  let recommendedSide: 'target' | 'source' = 'target';
  if (target.odooMissingFlagged && !source.odooMissingFlagged && sourceDate) {
    recommendedSide = 'source';
  } else if (!target.odooMissingFlagged && source.odooMissingFlagged && targetDate) {
    recommendedSide = 'target';
  } else if (source.status === 'confirmed' && target.status !== 'confirmed' && sourceDate) {
    recommendedSide = 'source';
  } else if (target.status === 'confirmed' && source.status !== 'confirmed' && targetDate) {
    recommendedSide = 'target';
  } else if (!targetDate && sourceDate) {
    recommendedSide = 'source';
  }

  const recommendedDate =
    recommendedSide === 'source'
      ? (sourceDate ?? targetDate)
      : (targetDate ?? sourceDate);

  return {
    targetDate,
    targetDateKind,
    sourceDate,
    sourceDateKind,
    hasDifferentDates,
    recommendedSide,
    recommendedDate,
  };
}

export interface MergeOutcomePreview {
  nextStatus: OrderRecord['status'];
  nextSlottedDate: string | null;
  nextPickupChannelId: number | null;
  nextFreeTextPickup: string | null;
  mergedItems: OrderItemLine[];
  primaryOdooSide: 'target' | 'source';
  primaryOdooRef: string | null;
  archivedOdooRef: string | null;
  recommendedItemStrategy: 'keep_target' | 'use_source';
  combinedChatterCount: number;
  pickedSourceDate: boolean;
}

/**
 * Computes the exact resulting order fields when merging `source` into `target`
 * so the side-by-side review modal and the server merge endpoint always agree 100%.
 */
export function previewMergeOutcome(
  target: OrderRecord,
  source: OrderRecord,
  itemStrategy: 'keep_target' | 'use_source' | 'combine',
  explicitKeepDate?: string | null
): MergeOutcomePreview {
  const statusRank: Record<OrderRecord['status'], number> = {
    ignored: -1,
    waitlist: 0,
    slotted: 1,
    pre_approved: 2,
    confirmed: 3,
  };

  let nextStatus: OrderRecord['status'] =
    statusRank[source.status] > statusRank[target.status] ? source.status : target.status;

  const nextSlottedDate =
    explicitKeepDate !== undefined
      ? explicitKeepDate
      : (target.slottedDate ?? source.slottedDate ?? null);

  if (nextSlottedDate && nextStatus === 'waitlist') {
    nextStatus = 'slotted';
  } else if (!nextSlottedDate && nextStatus === 'slotted') {
    nextStatus = 'waitlist';
  }

  const targetEffectiveDate = target.slottedDate || target.requestedDate || null;
  const sourceEffectiveDate = source.slottedDate || source.requestedDate || null;
  const pickedSourceDate = Boolean(
    explicitKeepDate &&
      sourceEffectiveDate &&
      explicitKeepDate === sourceEffectiveDate &&
      sourceEffectiveDate !== targetEffectiveDate
  );

  const isSourceActiveReplacement = Boolean(
    target.odooMissingFlagged && !source.odooMissingFlagged
  );
  const preferSourceChannel =
    pickedSourceDate ||
    (isSourceActiveReplacement &&
      (source.pickupChannelId !== null || Boolean(source.freeTextPickup)));

  const nextPickupChannelId = preferSourceChannel
    ? (source.pickupChannelId ?? target.pickupChannelId ?? null)
    : (target.pickupChannelId ?? source.pickupChannelId ?? null);
  const nextFreeTextPickup = preferSourceChannel
    ? (source.freeTextPickup ?? target.freeTextPickup ?? null)
    : (target.freeTextPickup ?? source.freeTextPickup ?? null);

  let mergedItems: OrderItemLine[] = [];
  if (itemStrategy === 'keep_target') {
    mergedItems = target.items.length > 0 ? target.items : source.items;
  } else if (itemStrategy === 'use_source') {
    mergedItems = source.items.length > 0 ? source.items : target.items;
  } else {
    const qtyByItem = new Map<number, number>();
    for (const line of [...target.items, ...source.items]) {
      const prev = qtyByItem.get(line.trackedItemId) ?? 0;
      qtyByItem.set(line.trackedItemId, Math.round((prev + Number(line.quantity)) * 1000) / 1000);
    }
    mergedItems = Array.from(qtyByItem.entries())
      .filter(([, qty]) => qty > 0)
      .map(([trackedItemId, quantity]) => ({ trackedItemId, quantity }));
  }

  const primaryOdooSide = selectPrimaryOdooSide(target, source);
  let primaryOdooRef: string | null = null;
  let archivedOdooRef: string | null = null;
  if (target.odooQuotationId && source.odooQuotationId) {
    primaryOdooRef =
      primaryOdooSide === 'source'
        ? source.odooQuotationName || `#${source.odooQuotationId}`
        : target.odooQuotationName || `#${target.odooQuotationId}`;
    archivedOdooRef =
      primaryOdooSide === 'source'
        ? target.odooQuotationName || `#${target.odooQuotationId}`
        : source.odooQuotationName || `#${source.odooQuotationId}`;
  } else if (source.odooQuotationId) {
    primaryOdooRef = source.odooQuotationName || `#${source.odooQuotationId}`;
  } else if (target.odooQuotationId) {
    primaryOdooRef = target.odooQuotationName || `#${target.odooQuotationId}`;
  }

  const recommendedItemStrategy: 'keep_target' | 'use_source' =
    isSourceActiveReplacement || (source.status === 'confirmed' && target.status !== 'confirmed')
      ? 'use_source'
      : 'keep_target';

  const chatterIds = new Set<number>();
  for (const m of [...target.chatter, ...source.chatter]) {
    chatterIds.add(m.odooMessageId);
  }

  return {
    nextStatus,
    nextSlottedDate: nextStatus === 'waitlist' ? null : nextSlottedDate,
    nextPickupChannelId,
    nextFreeTextPickup,
    mergedItems,
    primaryOdooSide,
    primaryOdooRef,
    archivedOdooRef,
    recommendedItemStrategy,
    combinedChatterCount: chatterIds.size,
    pickedSourceDate,
  };
}


