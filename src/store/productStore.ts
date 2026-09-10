import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * productStore (B-91 M0) — which of the three standalone Bravo products the
 * client is currently living in: Messenger, Secure Services or Virtual
 * Bodyguard. Spec v2.0: the active product persists across launches and the
 * app reopens straight into it; switching products is a deliberate act
 * (Profile → Switch Dashboard) that remounts the product shell, which resets
 * the previous product's navigation stack structurally.
 *
 * `pendingProduct` carries the card the user tapped on the pre-auth product
 * selector through the signup flow; the client shell adopts it on first
 * mount after auth. Only CLIENT accounts consult this store — agent/CPO/
 * agency shells are chosen by `resolveAuthedRoute` before it is read.
 */
export type BravoProduct = 'messenger' | 'secure' | 'vbg';

export const PRODUCT_LABELS: Record<BravoProduct, string> = {
  messenger: 'Messenger',
  secure: 'Secure Services',
  vbg: 'Virtual Bodyguard',
};

interface ProductState {
  activeProduct: BravoProduct | null;
  pendingProduct: BravoProduct | null;
  /**
   * B-95 — true while the product gate is re-shown OVER an already-chosen
   * product (drawer "Choose dashboard" / hardware back at a product root).
   * Ephemeral by design: never persisted, so a relaunch still opens straight
   * into the active product per spec v2.
   */
  gateVisible: boolean;
  /**
   * B-352 — product to RETURN to on back at the current product's root.
   * Set only by cross-product entry points (VBG dashboard → "Secure
   * Services"); back then restores the origin product instead of ejecting to
   * the gate. Ephemeral like gateVisible: never persisted, cleared by any
   * ordinary switch, gate open, or sign-out reset.
   */
  returnProduct: BravoProduct | null;
  setActiveProduct: (p: BravoProduct, returnTo?: BravoProduct | null) => void;
  setPendingProduct: (p: BravoProduct | null) => void;
  /** Re-open the post-login "where would you like to start?" gate. */
  requestGate: () => void;
  /** First client mount after auth: promote the selector choice, if any. */
  adoptPendingProduct: () => void;
  reset: () => void;
}

export const useProductStore = create<ProductState>()(
  persist(
    (set, get) => ({
      activeProduct: null,
      pendingProduct: null,
      gateVisible: false,
      returnProduct: null,

      setActiveProduct: (p, returnTo) =>
        set({activeProduct: p, pendingProduct: null, gateVisible: false, returnProduct: returnTo ?? null}),
      setPendingProduct: p => set({pendingProduct: p}),

      requestGate: () => set({gateVisible: true, returnProduct: null}),

      adoptPendingProduct: () => {
        const {activeProduct, pendingProduct} = get();
        if (!activeProduct && pendingProduct) {
          set({activeProduct: pendingProduct, pendingProduct: null});
        }
      },

      reset: () => set({activeProduct: null, pendingProduct: null, gateVisible: false, returnProduct: null}),
    }),
    {
      name: 'bravo:product',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: s => ({activeProduct: s.activeProduct, pendingProduct: s.pendingProduct}),
    },
  ),
);

/**
 * Switch to another product. The client shell keys its subtree on
 * `activeProduct`, so this remount clears the old product's back-stack —
 * the spec's reset-on-switch rule with no reset() bookkeeping. M3 layers the
 * unsaved-booking confirm on top via `guard` (return false to abort).
 *
 * B-352 — `returnTo` marks a CROSS-PRODUCT entry (e.g. VBG dashboard →
 * "Secure Services"): back at the destination product's root then returns
 * to `returnTo` instead of ejecting to the product gate.
 */
export function switchProduct(next: BravoProduct, guard?: () => boolean, returnTo?: BravoProduct): boolean {
  if (guard && !guard()) {return false;}
  useProductStore.getState().setActiveProduct(next, returnTo ?? null);
  return true;
}
