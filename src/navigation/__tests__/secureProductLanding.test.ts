/**
 * PDF-1 #1 (supersedes B-390) — the Secure product lands on the TIER RESOLVER,
 * not the "Secure Plans" chooser.
 *
 * The drawer's SWITCH DASHBOARD rows are a PRODUCT SWITCH (productStore), not a
 * navigate — `SwitchDashboardSection` only calls `switchProduct(p)`. Where each
 * product lands is decided in MainNavigator by `SecureTab`'s `initialParams`
 * plus its `tabPress` listener.
 *
 * B-390 pointed both at the `SecureServices` chooser. The founder change routes
 * by the client's tier instead: a PRO retainer client (ACTIVE application) must
 * land on ProDashboard and a LITE client on the Book-Now home. Because the tier
 * loads lazily, the seeded landing is a small resolver screen, `SecureLanding`,
 * that reads the gate and replaces itself with the right root — so both sites
 * now name `SecureLanding` (NOT `SecureServices`, and NOT `BookingHome`), and
 * must AGREE with each other: the tab bar and the drawer disagreeing about the
 * product root is the same class of bug, one layer over.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const NAV = join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx');
const SWITCH = join(process.cwd(), 'src', 'components', 'SwitchDashboardSection.tsx');

/** Line-based comment strip — the house block-comment regex is documented to
 *  eat real code when it meets a `/*` inside a string. */
function codeOnly(file: string = NAV): string {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('PDF-1 #1 — the Secure product lands on the tier resolver', () => {
  it('the scan sees real code (not a vacuous pass)', () => {
    const src = codeOnly();
    expect(src.length).toBeGreaterThan(5_000);
    expect(src).toContain('SecureTab');
    expect(src).not.toContain('\r');
  });

  it('SecureTab initialParams route the secure product to SecureLanding', () => {
    const src = codeOnly();
    const block = src.slice(src.indexOf('name="SecureTab"'), src.indexOf('name="ProfileTab"'));
    expect(block).toMatch(/activeProduct === 'secure'[\s\S]*?screen: 'SecureLanding'/);
    // The chooser is NO LONGER the primary landing at either site — it is a card
    // on BookingHome now. Neither the resolver nor the Book-Now home is it.
    expect(block).not.toMatch(/screen: 'SecureServices'/);
  });

  it('the tabPress listener agrees with initialParams', () => {
    const src = codeOnly();
    const block = src.slice(src.indexOf('name="SecureTab"'), src.indexOf('name="ProfileTab"'));
    const tabPress = block.slice(block.indexOf('tabPress'));
    expect(tabPress).toMatch(/SecureLanding/);
    // Neither the Book-Now home nor the chooser may be the seeded landing —
    // the resolver decides ProDashboard-vs-BookingHome at runtime.
    expect(block).not.toMatch(/screen: 'BookingHome'/);
  });

  it('passes initial:false so BookingHome stays beneath it and back still works', () => {
    const src = codeOnly();
    const block = src.slice(src.indexOf('name="SecureTab"'), src.indexOf('name="ProfileTab"'));
    // Both SecureLanding navigations must carry initial:false — without it the
    // stack ROOTS at SecureLanding with no BookingHome beneath, so the resolver's
    // Lite `pop()` would fall out of the stack and the Pro back target vanishes.
    const hits = block.match(/screen: 'SecureLanding', initial: false/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('VBG is untouched — it still lands on its own dashboard', () => {
    const src = codeOnly();
    const block = src.slice(src.indexOf('name="SecureTab"'), src.indexOf('name="ProfileTab"'));
    expect(block).toMatch(/screen: 'VBGHome'/);
  });
});

/**
 * B-393 — the THIRD site that decides where a product lands.
 *
 * MainNavigator only gets a say when `activeProduct` actually CHANGES, because
 * the client tab tree is keyed on it. Selecting the product you are already in
 * never reaches these `initialParams` at all, so `SwitchDashboardSection` has
 * to name the same roots itself. The behaviour is tested by rendering the
 * control (`src/components/__tests__/switchDashboardProductRoot.test.tsx`);
 * what a render CANNOT see is whether the two files still agree, which is the
 * drift this file was written to catch one layer up.
 */
describe('B-393 — the drawer and the navigator agree on every product root', () => {
  it('the scan sees real code (not a vacuous pass)', () => {
    const src = codeOnly(SWITCH);
    expect(src.length).toBeGreaterThan(1_000);
    expect(src).toContain('SwitchDashboardSection');
    expect(src).not.toContain('\r');
  });

  it('the same-product path navigates instead of relying on a remount', () => {
    const src = codeOnly(SWITCH);
    // The no-op branch itself: without this guard the row writes the product it
    // already holds and nothing moves.
    expect(src).toMatch(/p === activeProduct/);
    expect(src).toMatch(/navigation\.navigate\(/);
  });

  it('secure lands on SecureLanding in BOTH files, with initial:false', () => {
    const drawer = codeOnly(SWITCH);
    const nav = codeOnly();
    const target = /screen: 'SecureLanding', initial: false/;
    expect(drawer).toMatch(target);
    expect(nav).toMatch(target);
    // And the booking hero is the SEEDED landing in NEITHER (the resolver picks
    // BookingHome vs ProDashboard at runtime — it is never named in the seed).
    expect(drawer).not.toMatch(/screen: 'BookingHome'/);
    expect(nav).not.toMatch(/screen: 'BookingHome'/);
  });

  it('messenger and vbg name their own roots, never the secure one', () => {
    const drawer = codeOnly(SWITCH);
    // Pin the FULL payload, not a prefix. `/'SecureTab', \{screen: 'VBGHome'/`
    // matches with OR without the flag, so it would have been blind to exactly
    // the one file-pair disagreement that exists here: MainNavigator writes
    // `{screen: 'VBGHome'}` (listed unflagged in nestedNavigationInitialFlag's
    // KNOWN_PREEXISTING) while this drawer writes `initial: false`.
    expect(drawer).toMatch(/'MessengerTab', \{screen: 'MessengerHome', initial: false\}/);
    expect(drawer).toMatch(/'SecureTab', \{screen: 'VBGHome', initial: false\}/);
  });

  /**
   * The VBG asymmetry above is deliberate, and inert TODAY: `SecureTab` is the
   * initial tab for the vbg product, so `BookingNavigator` is always already
   * mounted and `initial` is only read on first state initialisation. Pinned so
   * that if MainNavigator ever stops mounting it eagerly, this states out loud
   * what would change — BookingHome (a SECURE screen) would sit beneath the VBG
   * dashboard.
   */
  it('records that MainNavigator deliberately omits the flag for VBG', () => {
    const nav = codeOnly();
    const block = nav.slice(nav.indexOf('name="SecureTab"'), nav.indexOf('name="ProfileTab"'));
    expect(block).toMatch(/screen: 'VBGHome'\}/);
    expect(block).not.toMatch(/screen: 'VBGHome', initial: false/);
  });

  /**
   * `PRODUCT_ROOT_ROUTE` exists only because the truncation guard needs the
   * root's NAME while `nestedNavigationInitialFlag`'s scan needs a literal
   * `screen: 'X'` in the navigate. Two spellings of one fact — so pin that they
   * cannot drift, or the guard silently starts asking about the wrong screen
   * and the dialog stops appearing exactly when it is needed.
   */
  it('PRODUCT_ROOT_ROUTE names the same screens the navigates do', () => {
    const src = codeOnly(SWITCH);
    const map = src.slice(src.indexOf('PRODUCT_ROOT_ROUTE'), src.indexOf('interface Props'));
    for (const root of ['MessengerHome', 'SecureLanding', 'VBGHome']) {
      expect(map).toContain(`'${root}'`);
      expect(src).toMatch(new RegExp(`screen: '${root}', initial: false`));
    }
  });

  it('guards the landing on the truncation predicate, not on the booking draft', () => {
    const src = codeOnly(SWITCH);
    // `isBookingDraftDirty` is true whenever a pickup has ever been set, so
    // keying the guard on it would fire on the founder's one-tap path AND
    // still miss SecureProApplyScreen's local-state form.
    //
    // PDF-1 #1 — the guard keys on `truncationRootRoute(p)`, NOT the raw navigate
    // target. For secure the navigate lands on the transient `SecureLanding`
    // resolver, so the guard must ask about the concrete tier home the resolver
    // resets to (ProDashboard/BookingHome) — keying on the resolver would find
    // nothing and the confirm would never fire.
    expect(src).toMatch(/mountedStackHasRoutesAbove\(truncationRootRoute\(p\)\)/);
    const sameProduct = src.indexOf('p === activeProduct');
    const guardCall = src.indexOf('mountedStackHasRoutesAbove(truncationRootRoute(p))');
    const discard = src.indexOf('isBookingDraftDirty');
    expect(sameProduct).toBeLessThan(guardCall);
    expect(guardCall).toBeLessThan(discard);
  });

  it('the truncation guard resolves the SECURE root by tier, via the shared helper', () => {
    const src = codeOnly(SWITCH);
    // The resolver and the guard must not drift about where a Pro vs Lite client
    // lands — both route through `secureRootRoute`. Pinning the import keeps the
    // guard reading the same tier decision the resolver seeds.
    expect(src).toMatch(/truncationRootRoute\s*=\s*\(p: BravoProduct\)/);
    expect(src).toMatch(/secureRootRoute\(useSecureProStore\.getState\(\)\.application\)/);
    // The resolver screen owns that helper and uses it too — the single tier
    // decision, imported by both landing paths.
    const resolver = readFileSync(
      join(process.cwd(), 'src', 'screens', 'securepro', 'SecureLandingScreen.tsx'), 'utf8');
    expect(resolver).toMatch(/secureRootRoute\(application\)/);
  });

  it('a same-product tap does not run the leave-and-discard confirm', () => {
    const src = codeOnly(SWITCH);
    // The early return must come BEFORE the unsaved-booking branch: you are not
    // leaving Secure Services, and the draft survives a push to the plan chooser.
    const sameProduct = src.indexOf('p === activeProduct');
    const discard = src.indexOf('isBookingDraftDirty');
    expect(sameProduct).toBeGreaterThan(-1);
    expect(discard).toBeGreaterThan(-1);
    expect(sameProduct).toBeLessThan(discard);
  });

  it('the same-product tap does not touch the product store', () => {
    const src = codeOnly(SWITCH);
    const body = src.slice(src.indexOf('p === activeProduct'), src.indexOf('isBookingDraftDirty'));
    // `setActiveProduct` would clear B-352's returnProduct, turning "back at the
    // Secure root returns to VBG" into "back ejects to the product gate".
    expect(body).not.toMatch(/switchProduct\(|setActiveProduct\(/);
  });
});
