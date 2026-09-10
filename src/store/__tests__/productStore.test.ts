import {useProductStore, switchProduct} from '@store/productStore';

function reset() {
  useProductStore.setState({activeProduct: null, pendingProduct: null, gateVisible: false, returnProduct: null});
}

describe('productStore (B-91 M0 + B-95 gate reopen)', () => {
  beforeEach(reset);

  it('setActiveProduct sets the product and clears pending + gate', () => {
    useProductStore.setState({pendingProduct: 'vbg', gateVisible: true});
    useProductStore.getState().setActiveProduct('messenger');
    const s = useProductStore.getState();
    expect(s.activeProduct).toBe('messenger');
    expect(s.pendingProduct).toBeNull();
    expect(s.gateVisible).toBe(false);
  });

  it('requestGate shows the gate without touching the active product', () => {
    useProductStore.getState().setActiveProduct('secure');
    useProductStore.getState().requestGate();
    const s = useProductStore.getState();
    expect(s.gateVisible).toBe(true);
    expect(s.activeProduct).toBe('secure');
  });

  it('switchProduct honours a vetoing guard', () => {
    useProductStore.getState().setActiveProduct('messenger');
    expect(switchProduct('vbg', () => false)).toBe(false);
    expect(useProductStore.getState().activeProduct).toBe('messenger');
    expect(switchProduct('vbg')).toBe(true);
    expect(useProductStore.getState().activeProduct).toBe('vbg');
  });

  it('reset clears product, pending and gate', () => {
    useProductStore.setState({activeProduct: 'vbg', pendingProduct: 'secure', gateVisible: true});
    useProductStore.getState().reset();
    const s = useProductStore.getState();
    expect(s.activeProduct).toBeNull();
    expect(s.pendingProduct).toBeNull();
    expect(s.gateVisible).toBe(false);
  });

  it('gateVisible is ephemeral — the persisted payload excludes it', () => {
    // B-95: persisting gateVisible would re-show the gate after a relaunch,
    // violating spec v2's reopen-straight-into-the-product rule.
    // B-352: same for returnProduct — a relaunch must not resurrect a stale
    // cross-product back target.
    const persistOptions = (useProductStore as unknown as {
      persist: {getOptions: () => {partialize?: (s: unknown) => Record<string, unknown>}};
    }).persist.getOptions();
    expect(persistOptions.partialize).toBeDefined();
    const persisted = persistOptions.partialize!({
      activeProduct: 'messenger', pendingProduct: null, gateVisible: true, returnProduct: 'vbg',
    });
    expect(persisted).toEqual({activeProduct: 'messenger', pendingProduct: null});
  });

  describe('B-352 — cross-product entry returns to its origin on back', () => {
    it('switchProduct with returnTo records the origin', () => {
      useProductStore.getState().setActiveProduct('vbg');
      switchProduct('secure', undefined, 'vbg');
      const s = useProductStore.getState();
      expect(s.activeProduct).toBe('secure');
      expect(s.returnProduct).toBe('vbg');
    });

    it('consuming the return (plain switch back) clears it — no back loop', () => {
      switchProduct('secure', undefined, 'vbg');
      switchProduct('vbg');
      expect(useProductStore.getState().returnProduct).toBeNull();
    });

    it('an ordinary product switch never carries a return target', () => {
      switchProduct('secure', undefined, 'vbg');
      switchProduct('messenger');
      expect(useProductStore.getState().returnProduct).toBeNull();
    });

    it('opening the gate abandons the pending return', () => {
      switchProduct('secure', undefined, 'vbg');
      useProductStore.getState().requestGate();
      expect(useProductStore.getState().returnProduct).toBeNull();
    });
  });
});
