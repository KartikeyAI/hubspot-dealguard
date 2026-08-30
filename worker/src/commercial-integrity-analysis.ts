import type {
  CommercialIntegrityData,
  CommercialIntegritySummary,
  CommercialLineItemMetadata,
  CommercialQuoteMetadata,
  CommercialSignal,
} from './commercial-integrity-types.js';

const DAY_MS = 86_400_000;

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysUntil(value: string | null, now: number): number | null {
  const parsed = timestamp(value);
  return parsed === null ? null : Math.ceil((parsed - now) / DAY_MS);
}

function differencePercent(left: number | null, right: number | null): number | null {
  if (left === null || right === null || left === 0) return null;
  return round(Math.abs(right - left) / Math.abs(left) * 100, 1);
}

function lineAmount(item: CommercialLineItemMetadata): number | null {
  if (item.amount !== null) return item.amount;
  if (item.quantity === null || item.unitPrice === null) return null;
  const gross = item.quantity * item.unitPrice;
  const discount = item.discountAmount ?? 0;
  return Math.max(0, gross - discount);
}

function lineDiscountPercent(item: CommercialLineItemMetadata): number | null {
  if (item.discountPercent !== null && item.discountPercent >= 0) return item.discountPercent;
  if (
    item.discountAmount === null
    || item.quantity === null
    || item.unitPrice === null
    || item.quantity * item.unitPrice <= 0
  ) return null;
  return round(item.discountAmount / (item.quantity * item.unitPrice) * 100, 2);
}

function completeLineItem(item: CommercialLineItemMetadata): boolean {
  return Boolean(
    item.name
    && item.quantity !== null
    && item.quantity > 0
    && ((item.unitPrice !== null && item.unitPrice >= 0) || (item.amount !== null && item.amount >= 0)),
  );
}

function effectiveQuoteState(quote: CommercialQuoteMetadata, now: number): CommercialQuoteMetadata['state'] {
  if (quote.state === 'rejected') return 'rejected';
  const expiresAt = timestamp(quote.expirationDate);
  if (quote.state === 'expired' || (expiresAt !== null && expiresAt < now)) return 'expired';
  return quote.state;
}

function signal(
  signals: CommercialSignal[],
  input: Omit<CommercialSignal, 'evidenceCodes'> & { evidenceCodes?: string[] },
): void {
  signals.push({ ...input, evidenceCodes: input.evidenceCodes ?? [input.code] });
}

function mostRecent(quotes: CommercialQuoteMetadata[]): CommercialQuoteMetadata | null {
  return [...quotes].sort((left, right) => {
    const leftTime = timestamp(left.updatedAt) ?? timestamp(left.createdAt) ?? 0;
    const rightTime = timestamp(right.updatedAt) ?? timestamp(right.createdAt) ?? 0;
    return rightTime - leftTime;
  })[0] ?? null;
}

export function analyzeCommercialIntegrity(
  data: CommercialIntegrityData,
  now = Date.now(),
): CommercialIntegritySummary {
  const limitations = [...data.limitations];
  const coverageLineItems = data.availability.lineItems
    ? (data.truncated.lineItems ? 40 : 50)
    : 0;
  const coverageQuotes = data.availability.quotes
    ? (data.truncated.quotes ? 40 : 50)
    : 0;
  const coveragePercent = coverageLineItems + coverageQuotes;
  const coverageTruncated = data.truncated.lineItems || data.truncated.quotes;
  const missingSources: Array<'line_items' | 'quotes'> = [];
  if (!data.availability.lineItems) missingSources.push('line_items');
  if (!data.availability.quotes) missingSources.push('quotes');

  const amounts = data.lineItems.map(lineAmount);
  const pricedAmounts = amounts.filter((value): value is number => value !== null);
  const subtotal = pricedAmounts.length > 0
    ? round(pricedAmounts.reduce((sum, value) => sum + value, 0), 2)
    : null;
  const completeCount = data.lineItems.filter(completeLineItem).length;
  const incompleteCount = data.lineItems.length - completeCount;
  const amountCoveragePercent = data.lineItems.length === 0
    ? 0
    : Math.round(pricedAmounts.length / data.lineItems.length * 100);
  const discountPercents = data.lineItems
    .map(lineDiscountPercent)
    .filter((value): value is number => value !== null && value > 0);
  const discountedCount = discountPercents.length;
  const maximumDiscountPercent = discountPercents.length > 0
    ? round(Math.max(...discountPercents), 2)
    : null;
  let weightedDiscountNumerator = 0;
  let weightedDiscountDenominator = 0;
  for (const item of data.lineItems) {
    const percent = lineDiscountPercent(item);
    const gross = item.quantity !== null && item.unitPrice !== null
      ? item.quantity * item.unitPrice
      : null;
    if (percent !== null && gross !== null && gross > 0) {
      weightedDiscountNumerator += gross * percent;
      weightedDiscountDenominator += gross;
    }
  }
  const weightedDiscountPercent = weightedDiscountDenominator > 0
    ? round(weightedDiscountNumerator / weightedDiscountDenominator, 2)
    : null;
  const recurringCount = data.lineItems.filter((item) => Boolean(item.recurringFrequency)).length;

  const quoteStates = data.quotes.map((quote) => ({ quote, state: effectiveQuoteState(quote, now) }));
  const quotesByState = {
    draft: quoteStates.filter((item) => item.state === 'draft'),
    pending: quoteStates.filter((item) => item.state === 'pending'),
    issued: quoteStates.filter((item) => item.state === 'issued'),
    accepted: quoteStates.filter((item) => item.state === 'accepted'),
    expired: quoteStates.filter((item) => item.state === 'expired'),
    rejected: quoteStates.filter((item) => item.state === 'rejected'),
  };
  const currentQuotes = quoteStates
    .filter((item) => !['expired', 'rejected'].includes(item.state))
    .map((item) => item.quote);
  const latestCurrentQuote = mostRecent(currentQuotes);
  const latestQuote = mostRecent(data.quotes);
  const upcomingExpirations = currentQuotes
    .map((quote) => ({ quote, at: timestamp(quote.expirationDate) }))
    .filter((item): item is { quote: CommercialQuoteMetadata; at: number } => item.at !== null && item.at >= now)
    .sort((left, right) => left.at - right.at);
  const nextExpirationAt = upcomingExpirations[0]
    ? new Date(upcomingExpirations[0].at).toISOString()
    : null;
  const nearestExpirationDays = nextExpirationAt ? daysUntil(nextExpirationAt, now) : null;
  const daysToClose = daysUntil(data.deal.closeDate, now);

  const dealLineDifference = data.deal.amount !== null
    ? differencePercent(data.deal.amount, subtotal)
    : null;
  const quoteComparable = Boolean(
    latestCurrentQuote
    && latestCurrentQuote.amount !== null
    && data.deal.amount !== null
    && latestCurrentQuote.currencyCode
    && data.deal.currencyCode
    && latestCurrentQuote.currencyCode === data.deal.currencyCode,
  );
  const dealQuoteDifference = quoteComparable
    ? differencePercent(data.deal.amount, latestCurrentQuote?.amount ?? null)
    : null;

  const signals: CommercialSignal[] = [];
  let deduction = 0;

  if (data.authorization.status === 'required') {
    signal(signals, {
      code: 'commercial_authorization_required',
      label: 'Commercial evidence is not authorized',
      direction: 'neutral',
      severity: 'info',
      detail: 'Optional quote and line-item permissions have not been granted for this HubSpot account.',
      observedAt: data.fetchedAt,
      evidenceCodes: data.authorization.missingScopes,
    });
  } else if (data.authorization.status === 'partial') {
    signal(signals, {
      code: 'commercial_authorization_partial',
      label: 'Commercial evidence is partially authorized',
      direction: 'neutral',
      severity: 'warning',
      detail: `Missing optional permission${data.authorization.missingScopes.length === 1 ? '' : 's'}: ${data.authorization.missingScopes.join(', ')}.`,
      observedAt: data.fetchedAt,
      evidenceCodes: data.authorization.missingScopes,
    });
  }

  if (data.availability.lineItems) {
    if (data.lineItems.length === 0) {
      if (daysToClose !== null && daysToClose <= 30) {
        deduction += 20;
        signal(signals, {
          code: 'line_items_missing_near_close',
          label: 'No line items near close',
          direction: 'negative',
          severity: daysToClose <= 14 ? 'critical' : 'warning',
          detail: `No associated line item is recorded and the close date is ${daysToClose < 0 ? `${Math.abs(daysToClose)} days overdue` : `${daysToClose} days away`}.`,
          observedAt: data.fetchedAt,
        });
      } else {
        signal(signals, {
          code: 'line_items_not_recorded',
          label: 'No line-item evidence',
          direction: 'neutral',
          severity: 'info',
          detail: 'No associated line item is currently recorded for this deal.',
          observedAt: data.fetchedAt,
        });
      }
    } else {
      if (incompleteCount === 0) {
        signal(signals, {
          code: 'line_items_complete',
          label: 'Line-item pricing is complete',
          direction: 'positive',
          severity: 'info',
          detail: `All ${data.lineItems.length} associated line item${data.lineItems.length === 1 ? '' : 's'} contain a name, positive quantity, and price or amount.`,
          observedAt: data.fetchedAt,
        });
      } else {
        const impact = Math.min(30, incompleteCount * 8);
        deduction += impact;
        signal(signals, {
          code: 'line_items_incomplete',
          label: 'Line-item pricing is incomplete',
          direction: 'negative',
          severity: incompleteCount / data.lineItems.length >= .5 ? 'critical' : 'warning',
          detail: `${incompleteCount} of ${data.lineItems.length} associated line items are missing a name, positive quantity, or usable price/amount.`,
          observedAt: data.fetchedAt,
        });
      }

      if (dealLineDifference !== null) {
        if (dealLineDifference <= 5) {
          signal(signals, {
            code: 'deal_line_item_amount_aligned',
            label: 'Deal and line-item amounts align',
            direction: 'positive',
            severity: 'info',
            detail: `The line-item subtotal is within ${dealLineDifference}% of the recorded deal amount.`,
            observedAt: data.fetchedAt,
          });
        } else if (dealLineDifference > 10) {
          const impact = dealLineDifference > 35 ? 30 : dealLineDifference > 20 ? 20 : 10;
          deduction += impact;
          signal(signals, {
            code: 'deal_line_item_amount_mismatch',
            label: 'Deal and line-item amounts differ',
            direction: 'negative',
            severity: dealLineDifference > 35 ? 'critical' : 'warning',
            detail: `The line-item subtotal differs from the recorded deal amount by ${dealLineDifference}%.`,
            observedAt: data.fetchedAt,
          });
        }
      }

      if (discountedCount > 0) {
        signal(signals, {
          code: 'discount_evidence_present',
          label: 'Discount evidence is present',
          direction: 'neutral',
          severity: 'info',
          detail: `${discountedCount} line item${discountedCount === 1 ? '' : 's'} contain discount metadata; the maximum observed discount is ${maximumDiscountPercent ?? 'unknown'}%.`,
          observedAt: data.fetchedAt,
        });
        if ((maximumDiscountPercent ?? 0) >= 20) {
          const impact = (maximumDiscountPercent ?? 0) >= 35 ? 15 : 8;
          deduction += impact;
          signal(signals, {
            code: 'material_discount_review',
            label: 'Material discount requires review',
            direction: 'negative',
            severity: (maximumDiscountPercent ?? 0) >= 35 ? 'critical' : 'warning',
            detail: `The maximum recorded line-item discount is ${maximumDiscountPercent}%. DealGuard reports this as a review threshold, not as evidence that the discount is unauthorized.`,
            observedAt: data.fetchedAt,
          });
        }
      }
    }
  }

  if (data.availability.quotes) {
    if (data.quotes.length === 0) {
      if (daysToClose !== null && daysToClose <= 30) {
        deduction += 15;
        signal(signals, {
          code: 'quote_missing_near_close',
          label: 'No quote near close',
          direction: 'negative',
          severity: daysToClose <= 14 ? 'critical' : 'warning',
          detail: `No associated quote is recorded and the close date is ${daysToClose < 0 ? `${Math.abs(daysToClose)} days overdue` : `${daysToClose} days away`}.`,
          observedAt: data.fetchedAt,
        });
      } else {
        signal(signals, {
          code: 'quote_not_recorded',
          label: 'No quote evidence',
          direction: 'neutral',
          severity: 'info',
          detail: 'No associated quote is currently recorded for this deal.',
          observedAt: data.fetchedAt,
        });
      }
    } else {
      if (quotesByState.accepted.length > 0) {
        signal(signals, {
          code: 'accepted_quote_present',
          label: 'Accepted commercial proposal is recorded',
          direction: 'positive',
          severity: 'info',
          detail: `${quotesByState.accepted.length} associated quote${quotesByState.accepted.length === 1 ? '' : 's'} contain accepted, signed, paid, completed, or approved status evidence.`,
          observedAt: latestQuote?.updatedAt ?? data.fetchedAt,
        });
      } else if (quotesByState.issued.length > 0) {
        signal(signals, {
          code: 'issued_quote_present',
          label: 'Issued commercial proposal is recorded',
          direction: 'positive',
          severity: 'info',
          detail: `${quotesByState.issued.length} associated quote${quotesByState.issued.length === 1 ? '' : 's'} contain published, sent, or open status evidence.`,
          observedAt: latestQuote?.updatedAt ?? data.fetchedAt,
        });
      } else if (
        daysToClose !== null
        && daysToClose <= 30
        && quotesByState.draft.length + quotesByState.pending.length === data.quotes.length
      ) {
        deduction += 15;
        signal(signals, {
          code: 'quote_not_issued_near_close',
          label: 'Quote is not issued near close',
          direction: 'negative',
          severity: daysToClose <= 14 ? 'critical' : 'warning',
          detail: 'All associated quotes remain in draft or pending evidence states while the close date is approaching.',
          observedAt: latestQuote?.updatedAt ?? data.fetchedAt,
        });
      }

      if (quotesByState.expired.length > 0 && currentQuotes.length === 0) {
        deduction += 20;
        signal(signals, {
          code: 'all_quotes_expired',
          label: 'All quote evidence is expired',
          direction: 'negative',
          severity: 'critical',
          detail: `All ${data.quotes.length} associated quote${data.quotes.length === 1 ? ' is' : 's are'} expired or past the recorded expiration date.`,
          observedAt: latestQuote?.updatedAt ?? data.fetchedAt,
        });
      }
      if (quotesByState.rejected.length > 0 && currentQuotes.length === 0) {
        deduction += 20;
        signal(signals, {
          code: 'all_quotes_rejected',
          label: 'All quote evidence is rejected',
          direction: 'negative',
          severity: 'critical',
          detail: `No current quote remains; ${quotesByState.rejected.length} associated quote${quotesByState.rejected.length === 1 ? ' is' : 's are'} rejected or declined.`,
          observedAt: latestQuote?.updatedAt ?? data.fetchedAt,
        });
      }
      if (nearestExpirationDays !== null && nearestExpirationDays <= 7) {
        deduction += 10;
        signal(signals, {
          code: 'quote_expiring_soon',
          label: 'Quote expires soon',
          direction: 'negative',
          severity: nearestExpirationDays <= 2 ? 'critical' : 'warning',
          detail: `The nearest current quote expiration is ${nearestExpirationDays} day${nearestExpirationDays === 1 ? '' : 's'} away.`,
          observedAt: nextExpirationAt,
        });
      }

      if (dealQuoteDifference !== null) {
        if (dealQuoteDifference <= 5) {
          signal(signals, {
            code: 'deal_quote_amount_aligned',
            label: 'Deal and quote amounts align',
            direction: 'positive',
            severity: 'info',
            detail: `The latest current quote amount is within ${dealQuoteDifference}% of the recorded deal amount.`,
            observedAt: latestCurrentQuote?.updatedAt ?? data.fetchedAt,
          });
        } else if (dealQuoteDifference > 10) {
          const impact = dealQuoteDifference > 35 ? 25 : dealQuoteDifference > 20 ? 18 : 10;
          deduction += impact;
          signal(signals, {
            code: 'deal_quote_amount_mismatch',
            label: 'Deal and quote amounts differ',
            direction: 'negative',
            severity: dealQuoteDifference > 35 ? 'critical' : 'warning',
            detail: `The latest current quote amount differs from the recorded deal amount by ${dealQuoteDifference}%.`,
            observedAt: latestCurrentQuote?.updatedAt ?? data.fetchedAt,
          });
        }
      } else if (
        latestCurrentQuote
        && latestCurrentQuote.amount !== null
        && data.deal.amount !== null
        && latestCurrentQuote.currencyCode
        && data.deal.currencyCode
        && latestCurrentQuote.currencyCode !== data.deal.currencyCode
      ) {
        deduction += 10;
        signal(signals, {
          code: 'deal_quote_currency_mismatch',
          label: 'Deal and quote currencies differ',
          direction: 'negative',
          severity: 'warning',
          detail: `The deal is recorded in ${data.deal.currencyCode}, while the latest current quote is recorded in ${latestCurrentQuote.currencyCode}. Amount alignment is suppressed.`,
          observedAt: latestCurrentQuote.updatedAt ?? data.fetchedAt,
        });
      }
    }
  }

  if (coverageTruncated) {
    limitations.push('Commercial evidence is truncated at the bounded on-demand association limit or includes unreadable associated records.');
  }
  limitations.push('Discount thresholds are deterministic review thresholds; they do not establish whether a discount is authorized or commercially appropriate.');
  limitations.push('Commercial integrity uses structured quote and line-item metadata only. It does not inspect quote documents, attachments, terms text, payment details, or contract content.');

  const hasCommercialRecords = data.lineItems.length > 0 || data.quotes.length > 0;
  let score: number | null = hasCommercialRecords || (daysToClose !== null && daysToClose <= 30)
    ? Math.round(clamp(100 - deduction))
    : null;

  if (data.authorization.status === 'required') score = null;

  let status: CommercialIntegritySummary['status'];
  if (data.authorization.status === 'required') status = 'authorization_required';
  else if (!data.availability.lineItems && !data.availability.quotes) status = 'unavailable';
  else if (score === null) status = 'insufficient_data';
  else if (score < 55 || signals.some((item) => item.direction === 'negative' && item.severity === 'critical')) status = 'weak';
  else if (
    score < 80
    || data.authorization.status === 'partial'
    || coverageTruncated
    || signals.some((item) => item.direction === 'negative' && item.severity === 'warning')
  ) status = 'watch';
  else status = 'ready';

  const confidence: CommercialIntegritySummary['confidence'] =
    coveragePercent === 100 && !coverageTruncated && hasCommercialRecords
      ? 'high'
      : coveragePercent >= 50 && (hasCommercialRecords || daysToClose !== null)
        ? 'medium'
        : 'low';

  const summary =
    status === 'authorization_required'
      ? 'Optional quote and line-item permissions are required before DealGuard can evaluate commercial integrity.'
      : status === 'unavailable'
        ? 'Commercial object sources are currently unavailable; the rest of the Deal Brief remains usable.'
        : status === 'insufficient_data'
          ? 'Commercial sources are available, but there is not enough quote or line-item evidence to score this deal.'
          : status === 'weak'
            ? `Commercial integrity is weak. ${signals.find((item) => item.direction === 'negative')?.detail ?? 'Material commercial gaps require intervention.'}`
            : status === 'watch'
              ? `Commercial integrity needs review. ${signals.find((item) => item.direction === 'negative')?.detail ?? 'Evidence is partial, bounded, or approaching a commercial deadline.'}`
              : 'Commercial pricing and proposal metadata are sufficiently complete and aligned across the available evidence.';

  return {
    methodology: 'hubspot_quote_and_line_item_metadata',
    status,
    score,
    confidence,
    summary,
    authorization: data.authorization,
    deal: data.deal,
    coverage: {
      lineItems: data.availability.lineItems,
      quotes: data.availability.quotes,
      percent: coveragePercent,
      truncated: coverageTruncated,
      missingSources,
    },
    lineItems: {
      count: data.lineItems.length,
      completeCount,
      incompleteCount,
      amountCoveragePercent,
      subtotal,
      subtotalCurrencyCode: subtotal !== null ? data.deal.currencyCode : null,
      dealAmountDifferencePercent: dealLineDifference,
      discountedCount,
      maximumDiscountPercent,
      weightedDiscountPercent,
      recurringCount,
    },
    quotes: {
      count: data.quotes.length,
      currentCount: currentQuotes.length,
      draftCount: quotesByState.draft.length,
      pendingCount: quotesByState.pending.length,
      issuedCount: quotesByState.issued.length,
      acceptedCount: quotesByState.accepted.length,
      expiredCount: quotesByState.expired.length,
      rejectedCount: quotesByState.rejected.length,
      latestQuoteAt: latestQuote?.updatedAt ?? latestQuote?.createdAt ?? null,
      nextExpirationAt,
      nearestExpirationDays,
      latestCurrentQuoteAmount: latestCurrentQuote?.amount ?? null,
      latestCurrentQuoteCurrencyCode: latestCurrentQuote?.currencyCode ?? null,
      dealAmountDifferencePercent: dealQuoteDifference,
    },
    daysToClose,
    signals,
    fetchedAt: data.fetchedAt,
    limitations: [...new Set(limitations)].slice(0, 10),
    contentProcessed: false,
    notForecastCategory: true,
    notWinProbability: true,
    notExpectedLoss: true,
  };
}
