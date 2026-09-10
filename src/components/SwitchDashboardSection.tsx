/**
 * B-91 M0 — "Switch Dashboard" (spec pp.12/21/26).
 *
 * The ONLY sanctioned cross-product control: lists ALL THREE products with
 * their exact names (the current one is marked, not hidden) —
 * no "Open" prefix. Selecting a DIFFERENT product remounts the client shell on
 * it, which structurally resets the old product's navigation stack. `guard`
 * lets the host veto a switch (M3's unsaved-booking confirm).
 *
 * Selecting the product you are ALREADY in is not a switch and must not be
 * treated as one — it navigates to that product's root instead (B-393).
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {mountedStackHasRoutesAbove} from '@navigation/navigationRef';
import {confirmProductSwitch, minimiseLiveCall} from '@navigation/productSwitch';
import {confirmSwitchDashboard} from '@utils/alert';
import {useSecureProStore} from '@store/secureProStore';
import {secureRootRoute} from '@screens/securepro/secureRoot';
import {
  useProductStore,
  switchProduct,
  PRODUCT_LABELS,
  type BravoProduct,
} from '@store/productStore';

const PRODUCT_ICONS: Record<BravoProduct, React.ComponentProps<typeof Icon>['name']> = {
  messenger: 'message-lock-outline',
  secure: 'shield-check-outline',
  vbg: 'shield-account-outline',
};

const ALL_PRODUCTS: BravoProduct[] = ['messenger', 'secure', 'vbg'];

/**
 * The screen each product's `goToProductRoot` NAVIGATES to, as a literal payload
 * `nestedNavigationInitialFlag.test.ts` can scan and `secureProductLanding.test.ts`
 * can pin against MainNavigator. For secure that is the tier RESOLVER
 * (`SecureLanding`), which then resets to the concrete tier home — see
 * `truncationRootRoute` for the route the same-product truncation guard must ask
 * about instead (the concrete home, not the transient resolver).
 */
const PRODUCT_ROOT_ROUTE: Record<BravoProduct, string> = {
  messenger: 'MessengerHome',
  secure: 'SecureLanding',
  vbg: 'VBGHome',
};

/**
 * The route the same-product truncation guard asks about — "is there unsaved
 * work stacked above this product's home?" (B-393). It differs from the NAVIGATE
 * target only for secure: the navigate lands on the `SecureLanding` resolver,
 * which is transient (it resets and is gone), so keying the guard on it would
 * find nothing and the confirm would never fire. The guard must key on the
 * concrete tier home the resolver lands on — ProDashboard for a PRO client,
 * BookingHome for LITE (PDF-1 #1, via the shared `secureRootRoute`).
 *
 * Reading the tier synchronously is safe here: `goToProductRoot` and this guard
 * only run for the product you are ALREADY in, whose application the Secure
 * screens have already loaded on focus (default BookingHome — the safe LITE home
 * — if somehow not).
 */
const truncationRootRoute = (p: BravoProduct): string =>
  p === 'secure'
    ? secureRootRoute(useSecureProStore.getState().application)
    : PRODUCT_ROOT_ROUTE[p];

/**
 * How long a host's drawer takes to fade out. Navigating while an RN `Modal` is
 * still visible leaves the destination behind a native dialog on Android, so
 * the drawer closes FIRST and the navigate lands after it — the same 220 ms
 * `ProfileDrawerModal`'s own `go()` helper waits. Hosts that are not a modal
 * (ProfileScreen) navigate immediately; a gratuitous delay on a plain list row
 * is exactly the "the tap registers late" feel the founder reports elsewhere.
 */
const DRAWER_FADE_MS = 220;

// vs2 edge A5 — `minimiseLiveCall` moved to `navigation/productSwitch`, next to
// the confirm and the ring-peek it belongs with. The VBG tile shipped with none
// of the three and could not have reused them while they were private here.

interface Props {
  /** Called before switching; return false to abort (e.g. unsaved booking). */
  guard?: (next: BravoProduct) => boolean;
  /** Called after a successful switch (hosts close their drawer/modal). */
  onSwitched?: (next: BravoProduct) => void;
  /**
   * An extra row rendered AFTER the three products.
   *
   * vs2 item 18 moves the client drawer's workspace row into this section —
   * it is the same kind of choice as the products above it. Passed in rather
   * than built here because its label, pill and destination all depend on the
   * caller's affiliation, which this component has no business knowing.
   */
  extraRow?: React.ReactNode;
  /**
   * The same extra row supplied as DATA rather than markup, so this component
   * draws it with the product rows' own styling.
   *
   * The drawer keeps passing `extraRow` because its markup is pinned by
   * `drawerItem18`; a host that has no row styling of its own (the Profile
   * screen) passes this instead and gets a row identical to the three above it
   * for free. Exactly one of the two is rendered — data wins if both arrive.
   */
  extraRowData?: {
    icon: React.ComponentProps<typeof Icon>['name'];
    label: string;
    pill?: string;
    dimmed?: boolean;
    go: () => void;
  };
  /**
   * The product whose UI the user is actually LOOKING at, when that differs
   * from the one the store calls active.
   *
   * The list hides the product you are already in. `activeProduct` is the
   * shell, not the screen — open this drawer from a Messenger screen while
   * the shell is still Secure Services and it hid "Secure Services", leaving
   * no way back to it from the surface the user was on. Hosts that are
   * themselves a product's UI pass their own key.
   */
  surface?: BravoProduct;
}

export function SwitchDashboardSection({guard, onSwitched, extraRow, extraRowData, surface}: Props) {
  const activeProduct = useProductStore(s => s.activeProduct);
  // Needed for the SAME-product rows only (see `attempt`). `navigate` bubbles
  // to the tab navigator from every shell that hosts this control — the
  // messenger stack, the booking stack and ProfileTab — which is the same
  // mechanism ProfileDrawerModal's "My Bookings" row already relies on.
  const navigation = useNavigation<{navigate: (name: string, params?: object) => void}>();
  // Show ALL THREE products, including the one you are in.
  //
  // This used to hide the active product. That is defensible on a dashboard,
  // but this drawer is hosted by the MESSENGER shell, so hiding the active
  // product dropped whichever one you had come from and left the menu
  // inconsistent — Messenger present in one state, gone in another. Requested
  // explicitly: keep Messenger, Secure Services, Virtual Bodyguard AND Choose
  // Dashboard, always. Tapping the one you are already in takes you to that
  // product's root (B-393), and `surface` still marks it so it can be styled
  // as current.
  const current = surface ?? activeProduct;
  const options = ALL_PRODUCTS;

  /**
   * Land on a product's ROOT screen.
   *
   * Must agree with MainNavigator's `SecureTab` `initialParams` — the tab bar
   * and this drawer disagreeing about where a product lives is the B-390 class
   * of bug, one layer over. Pinned by
   * `src/navigation/__tests__/secureProductLanding.test.ts`.
   *
   * B-390 also points its `tabPress` listener at the same root, but do not read
   * that as a second live site: `tabPress` is emitted only by the library tab
   * bar, this app replaces it with `CustomTabBar`, and `PRODUCT_TABS` renders
   * `SecureTab` for NO product. The listener cannot fire — which is precisely
   * why this control had to exist: from inside the secure product the drawer is
   * the only route back to the product root.
   *
   * `initial: false` on every branch satisfies R11-1's repo-wide rule, but be
   * honest about what it does HERE: nothing. `useNavigationBuilder` only reads
   * `params.initial` during a child navigator's FIRST state initialisation, and
   * every branch below targets a tab that is already mounted — `MainNavigator`
   * makes `MessengerTab` the initial tab for the messenger product and
   * `SecureTab` for the other two. The flag is written so the scan in
   * `nestedNavigationInitialFlag.test.ts` reads one rule rather than three
   * exceptions, and so the payload stays correct if that ever stops holding.
   * What actually keeps `BookingHome` beneath the secure landing is `SecureTab`'s
   * own `initialParams`, which seed the stack as [BookingHome, SecureLanding].
   */
  const goToProductRoot = (p: BravoProduct) => {
    if (p === 'messenger') {
      navigation.navigate('MessengerTab', {screen: 'MessengerHome', initial: false});
    } else if (p === 'vbg') {
      navigation.navigate('SecureTab', {screen: 'VBGHome', initial: false});
    } else {
      // PDF-1 #1 — the secure product lands on the tier resolver, not the plans
      // chooser: PRO clients get ProDashboard, LITE the Book-Now home. The
      // chooser stays reachable from BookingHome's PLANS & SERVICES row.
      navigation.navigate('SecureTab', {screen: 'SecureLanding', initial: false});
    }
  };

  const attempt = (p: BravoProduct) => {
    if (guard && !guard(p)) {return;}

    // B-393 — the row for the product you are ALREADY in was a silent no-op.
    //
    // `switchProduct` only writes `activeProduct`, and the client shell is
    // KEYED on that value, so re-selecting the same product changes nothing:
    // no remount, so `SecureTab`'s `initialParams` never re-apply and the
    // drawer just closed on the screen the user was already looking at.
    // B-390 fixed where a real SWITCH lands; this is that same landing rule
    // for the non-switch. It is not a Secure-only defect — "Messenger" from
    // ProfileTab inside the messenger product was dead for the same reason.
    //
    // It does NOT run the B-91 M3 R5 unsaved-booking confirm below, because
    // that one asks "leave Secure Services and discard it?" and neither half is
    // true here. It runs its own guard instead — see `truncationRootRoute` —
    // because this landing is not always harmless:
    //
    // for secure it navigates to the `SecureLanding` resolver, which RESETS the
    // stack to the tier's canonical home (PDF-1 #1). That reset drops everything
    // the user had open, and `SecureProApplyScreen` keeps all fifteen of its
    // fields in local `useState` with no store and no `beforeRemove`, so it is
    // unrecoverable. The guard keys on the CONCRETE tier home the resolver lands
    // on (`truncationRootRoute`, not the transient resolver route) so the confirm
    // fires exactly when there is work stacked above that home — and never
    // spuriously for a Pro client already sitting on their own dashboard.
    //
    // The store is left untouched on purpose — `setActiveProduct` would clear
    // B-352's `returnProduct`, silently turning "back at the Secure root
    // returns to VBG" into "back ejects to the product gate".
    if (p === activeProduct) {
      // `onSwitched` is only supplied by hosts that render this inside a
      // modal, so its presence is what says "a drawer has to close first".
      const land = () => {
        if (onSwitched) {
          onSwitched(p);
          setTimeout(() => goToProductRoot(p), DRAWER_FADE_MS);
        } else {
          goToProductRoot(p);
        }
      };
      // Only when something would actually be popped. The founder's primary
      // path (BookingHome → drawer → Secure Services) pushes onto the stack and
      // must stay a single frictionless tap, so this cannot be a blanket
      // "are you sure?" — and it deliberately does not consult
      // `isBookingDraftDirty`, which is true whenever a pickup has ever been
      // set and would fire on exactly that path while still missing the Pro
      // form it is not keyed on.
      if (mountedStackHasRoutesAbove(truncationRootRoute(p))) {
        const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
        Alert.alert(
          'Leave this screen?',
          // "may not be kept", not "is lost": the two things this can close are
          // not equivalent. SecureProApplyScreen's fields are local `useState`
          // and really do go; the Lite wizard's live in `bookingStore`, which
          // nothing clears (`resetDraft` has no callers), so only its position
          // in the flow is popped. One sentence has to be true of both.
          `Going to ${PRODUCT_LABELS[p]} closes the screens you have open here. Anything not yet submitted may not be kept.`,
          [
            {text: 'Stay', style: 'cancel'},
            {text: 'Continue', style: 'destructive', onPress: land},
          ],
        );
        return;
      }
      land();
      return;
    }

    // B-91 M3 R5 — leaving Secure Services with an unfinished booking form
    // must warn first (spec p.26). An in-flight booking switches freely.
    if (activeProduct === 'secure') {
      const {isBookingDraftDirty} =
        require('@store/bookingStore') as typeof import('@store/bookingStore');
      if (isBookingDraftDirty()) {
        const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
        Alert.alert(
          'Booking in progress',
          'You have an unfinished booking. Leave Secure Services and discard it?',
          [
            {text: 'Stay', style: 'cancel'},
            {
              text: 'Leave',
              style: 'destructive',
              // Same remount as the plain path, so the same protection —
              // and this is the ONLY path that can strand a group call.
              onPress: () => { minimiseLiveCall(); if (switchProduct(p, undefined, current ?? undefined)) {onSwitched?.(p);} },
            },
          ],
        );
        return;
      }
    }
    /**
     * vs2 item 18 — the plain cross-product switch now confirms.
     *
     * LAST, so the two existing dialogs still win: the open-screens warning
     * above and the unfinished-booking warning both say something specific and
     * more urgent than this one, and stacking two prompts on one tap is the
     * "no double prompt" the client asked about explicitly.
     *
     * A LIVE CALL is minimised first, never blocked. `switchProduct` is a plain
     * store write and the shell is keyed on it, so the remount is a raw React
     * unmount that never dispatches `beforeRemove` — the minimise that normally
     * happens when a call screen pops does not happen here. `FloatingCallOverlay`
     * is mounted outside the shell, so a minimised call survives the switch and
     * keeps its End button; a full-screen one would be destroyed with no way
     * back to it.
     */
    /**
     * An UNANSWERED group ring is destroyed by the switch, silently.
     *
     * `groupCallRegistry` is first written after Accept, so `hasLiveCall()` is
     * false while the phone is still ringing and `minimiseLiveCall()` no-ops.
     * `IncomingGroupCallScreen` is a stack child under the product key, and the
     * group overlay's only gate is `isMinimized` — so the keyed remount unmounts
     * the ring with nothing to restore and no rescue path. The 1:1 lane is fine:
     * it registers at ring time, so it minimises and the overlay can answer it.
     *
     * Say so rather than swallowing it. Blocking the switch would be worse — a
     * ring the user is deliberately walking away from would trap them — so the
     * confirm states the cost and lets them decide.
     */
    const go = () => {
      /**
       * `current` as `returnTo` ARMS B-352, and item 18 made that mandatory.
       *
       * Back at a product root now returns `false` (backgrounds the app) where
       * it used to re-open the gate. The drawer was the one `switchProduct`
       * caller that never recorded an origin — so switch from Secure Services
       * with a half-filled booking wizard, press Back once, and Android
       * backgrounds the app. `bookingStore` has no persist middleware, so the
       * draft dies with the process.
       *
       * The escape hatch already existed (VBGHomeScreen passes the third
       * argument); the drawer simply never used it. With it, the first Back
       * returns to where you came from and only the second exits.
       */
      if (switchProduct(p, undefined, current ?? undefined)) {onSwitched?.(p);}
    };
    // The ask, the ring warning and the minimise are ONE pre-flight now.
    confirmProductSwitch(PRODUCT_LABELS[p], go);
  };

  return (
    <View style={s.wrap}>
      <Text style={s.header}>SWITCH DASHBOARD</Text>
      {options.map(p => (
        <TouchableOpacity
          key={p}
          style={s.row}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Switch to ${PRODUCT_LABELS[p]}`}
          onPress={() => attempt(p)}>
          <View style={s.rowLeft}>
            <Icon name={PRODUCT_ICONS[p]} size={19} color="#5B8DEF" />
            <Text style={s.rowLabel}>{PRODUCT_LABELS[p]}</Text>
            {p === current && <Text style={s.currentTag}>CURRENT</Text>}
          </View>
          <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
        </TouchableOpacity>
      ))}
      {/* vs2 item 18 — "Choose Dashboard" is GONE. It opened the boot product
          gate again mid-session, which is a second way to do what the three
          rows above already do, with a full-screen takeover instead of a tap.
          The gate itself stays for boot (`!activeProduct`): first login must
          still pick a surface. */}

      {/* …and the workspace row moves HERE, after the three products, because
          it is the same kind of choice: where you want to be. The provider
          drawer keeps its own copy in place — it has no switch section, so this
          is its only workspace door. */}
      {extraRowData ? (
        <TouchableOpacity
          style={[s.row, extraRowData.dimmed && {opacity: 0.45}]}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={extraRowData.pill
            ? `${extraRowData.label}, ${extraRowData.pill}`
            : extraRowData.label}
          // vs2 edge A6 — this row LEAVES the current surface, so it confirms
          // first, the same as the drawer's hand-wired copy.
          onPress={() => confirmSwitchDashboard(extraRowData.label, extraRowData.go)}>
          <View style={s.rowLeft}>
            <Icon name={extraRowData.icon} size={19} color="#5B8DEF" />
            <Text style={s.rowLabel}>{extraRowData.label}</Text>
          </View>
          <View style={s.rowRight}>
            {extraRowData.pill ? (
              <View style={s.rowPill}><Text style={s.rowPillText}>{extraRowData.pill}</Text></View>
            ) : null}
            <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
          </View>
        </TouchableOpacity>
      ) : extraRow}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {marginTop: 8},
  header: {
    fontFamily: 'monospace', fontSize: 10, fontWeight: '700', letterSpacing: 2.5,
    color: 'rgba(180,188,204,0.45)', paddingHorizontal: 4, marginBottom: 6,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rowLeft: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12},
  rowRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  rowPill: {backgroundColor: '#2F5BE0', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2},
  rowPillText: {color: '#FFFFFF', fontSize: 9, fontWeight: '800', letterSpacing: 0.8},
  rowLabel: {flexShrink: 1, minWidth: 0, color: '#F2F4F8', fontSize: 14, fontWeight: '600'},
  currentTag: {
    flexShrink: 0,
    color: 'rgba(180,188,204,0.45)', fontFamily: 'monospace', fontSize: 9,
    fontWeight: '700', letterSpacing: 1.2,
  },
});
