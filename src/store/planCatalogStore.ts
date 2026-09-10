/**
 * Founder 2026-08-26 — the ops-editable package catalog (names, descriptions,
 * live messenger prices) from GET /subscription/catalog.
 *
 * FAIL-OPEN BY DESIGN: every consumer passes its shipped copy as the
 * fallback, so an offline boot, an old server, or an empty table renders
 * exactly what the app renders today. The catalog can rename a card; it can
 * never blank one. (Same posture as the server's getCatalog, which returns
 * an empty catalog on a DB error rather than 500ing the paywall.)
 */
import {create} from 'zustand';
import {subscriptionApi} from '@services/api';

export interface PlanCatalogEntry {
  key: string;
  display_name: string;
  description: string;
  price_bc: number | null;
}

interface PlanCatalogState {
  byKey: Record<string, PlanCatalogEntry>;
  loaded: boolean;
  load: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const usePlanCatalogStore = create<PlanCatalogState>((set) => ({
  byKey: {},
  loaded: false,
  load: async () => {
    // Single-flight: every plan surface calls load() on focus; one fetch
    // serves them all and a re-focus refreshes silently.
    if (inFlight) {return inFlight;}
    inFlight = (async () => {
      try {
        const {data} = await subscriptionApi.catalog();
        const byKey: Record<string, PlanCatalogEntry> = {};
        for (const row of data.catalog ?? []) {
          if (row?.key && row.display_name) {byKey[row.key] = row;}
        }
        set({byKey, loaded: true});
      } catch {
        // Offline / old server — shipped copy stands. Marked loaded so
        // consumers stop waiting; the next focus retries.
        set({loaded: true});
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));

/**
 * Overlay helper: the catalog row's copy when present, the shipped copy
 * otherwise. `name`/`desc` are the compiled defaults the caller already has.
 */
export function planCopy(
  byKey: Record<string, PlanCatalogEntry>,
  key: string,
  name: string,
  desc: string,
): {name: string; desc: string; price_bc: number | null} {
  const row = byKey[key];
  return {
    name: row?.display_name || name,
    desc: row?.description || desc,
    price_bc: row?.price_bc ?? null,
  };
}
