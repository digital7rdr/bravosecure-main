/**
 * B-710 — how many messages one conversation card holds.
 *
 * Lives in its own module because both sides need it and neither may import the
 * other: `callNotification.ts` owns the card, and `backgroundMessageNotifier.ts`
 * has to know the cap to size a batch. A drifted copy would either starve the
 * card or build a batch the card silently throws away.
 */
export const MSG_CARD_CAP = 7;
