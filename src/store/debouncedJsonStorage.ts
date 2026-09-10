import AsyncStorage from '@react-native-async-storage/async-storage';
import type {PersistStorage, StorageValue} from 'zustand/middleware';

/**
 * Debounced zustand `PersistStorage` — the B-633 write-path fix, shared.
 *
 * Lifted verbatim from messengerStore (Audit fix #13 + B-633) so other
 * persisted stores stop re-growing the same defect: `createJSONStorage`
 * runs `JSON.stringify(value)` synchronously on the mutator's own stack
 * for EVERY `set()`, and only then calls the adapter — so a debounce on
 * the adapter alone coalesces the AsyncStorage bridge call but NOT the
 * serialize. NAV-14 (2026-08-26 rapid-use audit) found activityStore had
 * exactly that shape: a 200-row stringify per tap on a notification row.
 *
 * As a `PersistStorage` this receives the partialized OBJECT and defers
 * the stringify into the flush along with the write. Holding that object
 * across the debounce window is safe for immer stores (committed
 * snapshots are frozen, never mutated in place) and for stores that
 * replace rows immutably — a later `set()` REPLACES the references, and
 * the pending value keeps pointing at the consistent snapshot it was
 * handed, which the next setItem then supersedes anyway.
 *
 * Trade-off: up to `delayMs` of durability loss on a hard kill. Callers
 * must only persist state that survives that (reconstructable, or merely
 * convenient).
 *
 * Security note (MSG-10 / P0-S3): any at-rest strips belong in the
 * store's own `partialize`, BEFORE anything reaches this adapter — that
 * boundary deliberately does not move here.
 */
export function makeDebouncedJsonStorage<S>(delayMs: number, tag: string): PersistStorage<S> {
  let pendingKey: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // B-304 class — an armed flush must not fire into a torn-down Jest
  // environment. A suite that finishes inside the debounce window leaves this
  // timer live; it then wakes after teardown, reaches AsyncStorage, and the
  // "Cannot log after tests are done" that follows is attributed to whatever
  // unrelated suite is running (same shape as the directoryNames leak, and the
  // same registry drains it — see jest.setup.messenger-crypto.js). The `?.` is
  // load-bearing: the registry only exists under that setup, so this is a
  // no-op in production.
  (globalThis as {__bravoTestCleanups?: Set<() => void>}).__bravoTestCleanups?.add(() => {
    if (timer) {clearTimeout(timer); timer = null;}
    pendingKey = null;
    pendingValue = null;
  });

  const flush = () => {
    timer = null;
    if (pendingKey === null || pendingValue === null) {return;}
    const k = pendingKey;
    const v = pendingValue;
    pendingKey = null;
    pendingValue = null;
    // B-633 — the stringify lives HERE, once per quiet window, instead of once
    // per set(). A serializer throw must not take the mutation down with it.
    let json: string;
    try {
      json = JSON.stringify(v);
    } catch (e) {
      console.warn(`[${tag}] debounced persist serialize failed`, e);
      return;
    }
    void AsyncStorage.setItem(k, json).catch(e => {
      console.warn(`[${tag}] debounced persist failed`, e);
    });
  };

  return {
    // Shape-for-shape what `createJSONStorage` did: parse synchronously when
    // the underlying read is synchronous, and otherwise `promise.then(parse)`
    // — NOT an `async` wrapper. An async function adds microtask ticks before
    // persist's hydration resolves, and that is load-bearing: making this
    // `async` delayed `onRehydrateStorage` by a tick and flipped the initial
    // collapse seed in DepartmentChannelsScreen (departmentDirectoryRender G4
    // went red only under a full-suite run). Read timing must not change here;
    // B-633 is about the WRITE path.
    getItem: (name: string) => {
      const parse = (raw: string | null): StorageValue<S> | null => {
        if (raw === null) {return null;}
        try {
          return JSON.parse(raw) as StorageValue<S>;
        } catch (e) {
          // A truncated/corrupt slice must not brick the boot: persist treats a
          // null read as "nothing stored yet" and hydrates from defaults, which
          // is the same place a first install starts from.
          console.warn(`[${tag}] persisted slice unreadable — ignoring`, e);
          return null;
        }
      };
      const raw = AsyncStorage.getItem(name) ?? null;
      return raw instanceof Promise
        ? raw.then((v: string | null) => parse(v ?? null))
        : parse(raw as string | null);
    },
    setItem: (name: string, value: StorageValue<S>) => {
      pendingKey = name;
      pendingValue = value;
      if (timer) {clearTimeout(timer);}
      timer = setTimeout(flush, delayMs);
    },
    removeItem: async (name: string) => {
      if (pendingKey === name) {
        pendingKey = null;
        pendingValue = null;
        if (timer) {clearTimeout(timer); timer = null;}
      }
      await AsyncStorage.removeItem(name);
    },
  };
}
