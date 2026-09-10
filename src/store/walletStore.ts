import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {walletApi, type WalletTransactionDto} from '@services/api';
import type {WalletBalance, Transaction, CreditBatch} from '@appTypes/index';

interface WalletState {
  balance: WalletBalance | null;
  creditBatches: CreditBatch[];
  transactions: Transaction[];
  vaultUsedMb: number;
  vaultTotalMb: number;
  isLoading: boolean;
  error: string | null;
}

interface WalletActions {
  loadBalance: () => Promise<void>;
  loadCreditBatches: () => Promise<void>;
  loadTransactions: () => Promise<void>;
  loadVaultStorage: () => Promise<void>;
  purchaseVaultStorage: (incrementMb: number) => Promise<void>;
  clearError: () => void;
  /** Wipe all balances/transactions back to the empty default — called on sign-out. */
  reset: () => void;
}

export const useWalletStore = create<WalletState & WalletActions>()(
  immer((set) => ({
    balance: null,
    creditBatches: [],
    transactions: [],
    vaultUsedMb: 0,
    // B-91 M1 R7 — spec v2.0 sets the free cloud-vault allocation to 100 MB
    // (was 500; INDEX Q7 flags the change for the boss). Server quota
    // enforcement is still pending — /vault/storage remains a placeholder.
    vaultTotalMb: 100,
    isLoading: false,
    error: null,

    loadBalance: async () => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await walletApi.getBalance();
        // Backend returns {bravo_credits, currency, stripe_customer_id}.
        // Map onto the app's WalletBalance shape which only needs credits + currency.
        const next: WalletBalance = {
          bravo_credits: data.bravo_credits,
          currency: data.currency,
        };
        set(s => {s.balance = next;});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load balance';});
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    loadCreditBatches: async () => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await walletApi.getCreditBatches();
        set(s => {s.creditBatches = data as CreditBatch[];});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load credit batches';});
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    loadTransactions: async () => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await walletApi.getTransactions();
        // Normalise wire shape → UI shape. Wire amounts are signed BC deltas;
        // the UI Transaction.type already distinguishes topup vs payment so
        // we pass them through and let the screen decide the sign formatting.
        const transactions: Transaction[] = (data.transactions ?? []).map((t: WalletTransactionDto) => ({
          id: t.id,
          user_id: t.user_id,
          type: t.type,
          amount: Math.abs(t.amount),
          currency: t.currency,
          description: t.description,
          booking_id: t.booking_id,
          created_at: t.created_at,
        }));
        set(s => {s.transactions = transactions;});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load transactions';});
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    loadVaultStorage: async () => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await walletApi.getVaultStorage();
        set(s => {
          s.vaultUsedMb = data.used_mb;
          s.vaultTotalMb = data.total_mb;
        });
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load vault storage';});
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    purchaseVaultStorage: async (incrementMb: number) => {
      set(s => {s.isLoading = true;});
      try {
        await walletApi.purchaseVaultStorage(incrementMb);
        set(s => {s.vaultTotalMb += incrementMb;});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Purchase failed';});
        throw e;
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    clearError: () => set(s => {s.error = null;}),

    reset: () => set(s => {
      s.balance = null;
      s.creditBatches = [];
      s.transactions = [];
      s.vaultUsedMb = 0;
      s.vaultTotalMb = 100;
      s.isLoading = false;
      s.error = null;
    }),
  })),
);
