import React, {useMemo, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import type {AuthScreenProps} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {pendingProvider} from '@store/pendingProvider';
import {pendingTier} from '@store/pendingTier';
import {plansForProduct} from '@screens/pro/tierMatrix';
import {useProductStore, type BravoProduct} from '@store/productStore';
import {goBackOnce} from '@navigation/tapGuard';

type Props = AuthScreenProps<'RoleSelection'>;
/** M1A — three individual tiers + the Operator Partner (service-provider) funnel. */
type Choice = 'lite' | 'pro' | 'enterprise' | 'provider';

// ── Design tokens (Bravo handoff — obsidian / platinum-cobalt) ──────────
// Why: ported verbatim from the Claude Design bundle (src/tokens.jsx) so
// this screen matches the refined "Select Your Role" mock exactly, rather
// than the older Command-Navy palette still in @/theme/bravo.
const T = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  signal:     '#4ADE80',
} as const;

// ── Icons (exact paths from the design's vbg-role.jsx) ──────────────────
function IcPerson({c}: {c: string}) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={3.6} stroke={c} strokeWidth={1.6} />
      <Path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
function IcBuilding({c}: {c: string}) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={3} width={11} height={18} rx={1.6} stroke={c} strokeWidth={1.6} />
      <Path d="M15 8h4.4a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H15" stroke={c} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d="M7.4 7h4M7.4 10.5h4M7.4 14h4M17.4 12h1M17.4 15.5h1" stroke={c} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}
function IcCheck({s = 13, c}: {s?: number; c: string}) {
  return (
    <Svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <Path d="M2.5 8.5l3.5 3.5 7.5-8" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcArrow({c}: {c: string}) {
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
      <Path d="M4 12h15M13 6l6 6-6 6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcBack({c}: {c: string}) {
  return (
    <Svg width={9} height={15} viewBox="0 0 9 15" fill="none">
      <Path d="M8 1L1.5 7.5 8 14" stroke={c} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcLock({c}: {c: string}) {
  return (
    <Svg width={12} height={13} viewBox="0 0 14 14" fill="none">
      <Rect x={2.5} y={6} width={9} height={6} rx={1.3} stroke={c} strokeWidth={1.3} />
      <Path d="M4.5 6V4a2.5 2.5 0 0 1 5 0v2" stroke={c} strokeWidth={1.3} strokeLinecap="round" />
    </Svg>
  );
}

// ── Radio mark ──────────────────────────────────────────────────────────
function Radio({on}: {on: boolean}) {
  return (
    <View
      style={[
        styles.radio,
        on
          ? {borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1}
          : {borderColor: T.hair2, borderWidth: 1.5},
      ]}>
      {on && (
        <LinearGradient
          colors={['#6E9BF5', T.accent, T.accentDeep]}
          start={{x: 0.2, y: 0.1}}
          end={{x: 0.9, y: 1}}
          style={styles.radioFill}>
          <View style={styles.radioDot} />
        </LinearGradient>
      )}
    </View>
  );
}

// ── Tier / corporate-kind sub-card ─────────────────────────────────────
function SubCard({
  name,
  desc,
  on,
  soon,
  onPress,
}: {
  name: string;
  desc: string;
  on: boolean;
  soon?: boolean;
  onPress: () => void;
}) {
  const Body = (
    <>
      <View style={styles.subTop}>
        <Text style={[styles.subName, on && !soon && {color: '#A9C5FF'}]}>{name}</Text>
        <View
          style={[
            styles.subCheck,
            on && !soon
              ? {backgroundColor: T.accent, borderWidth: 0}
              : {borderColor: T.hair2, borderWidth: 1.5},
          ]}>
          {on && !soon && <IcCheck s={10} c="#fff" />}
        </View>
      </View>
      {soon && (
        <View style={styles.soonBadge}>
          <Text style={styles.soonText}>COMING SOON</Text>
        </View>
      )}
      <Text style={styles.subDesc}>{desc}</Text>
    </>
  );

  return (
    <TouchableOpacity
      activeOpacity={soon ? 1 : 0.85}
      onPress={onPress}
      style={styles.subCardWrap}>
      {on && !soon ? (
        <LinearGradient
          colors={['rgba(91,141,239,0.18)', 'rgba(47,91,224,0.05)']}
          start={{x: 0.2, y: 0}}
          end={{x: 0.9, y: 1}}
          style={[styles.subCard, styles.subCardActive]}>
          {Body}
        </LinearGradient>
      ) : (
        <View style={[styles.subCard, soon && styles.subCardSoon]}>{Body}</View>
      )}
    </TouchableOpacity>
  );
}

interface RoleCard {
  id: Choice;
  Icon: (p: {c: string}) => React.ReactElement;
  eyebrow: string;
  title: string;
  desc: string;
  features: string[] | null;
}

// D-5 — the provider funnel keeps its own card on every path: it is how a
// security company signs up, not a plan the client is choosing between.
const PROVIDER_CARD: RoleCard = {
  id: 'provider',
  Icon: IcBuilding,
  eyebrow: 'Operator Partner',
  title: 'Operator Partner',
  desc: 'Security company onboarding a roster of officers under one master licence.',
  features: null,
};

/**
 * Issue 22 — the plan cards for the product the user actually tapped on
 * Onboarding, which stores it as `pendingProduct` before navigating here.
 *
 * This screen used to render ONE global list built from the messenger tier
 * matrix, so a user entering through Secure Services was offered "Group Chats"
 * and "Voice and Video Calls (up to 10 people)" and never saw booking at all.
 */
export function cardsForProduct(product: BravoProduct | null): RoleCard[] {
  const plans = plansForProduct(product).map<RoleCard>(plan => ({
    id: plan.tier,
    Icon: plan.tier === 'enterprise' ? IcBuilding : IcPerson,
    eyebrow: plan.eyebrow,
    title: plan.title,
    desc: plan.desc,
    features: plan.features,
  }));
  // Founder 2026-08-08 — Virtual Bodyguard is a PERSONAL safety product. There
  // is no roster of officers to onboard under a master licence on that path, so
  // the Operator Partner funnel is not offered there AT ALL. Dropping the card
  // removes its "WHAT YOU GET" sub-card too, because that block is rendered
  // from `card.id === 'provider'` — one deletion, not two.
  //
  // Scoped to vbg only: D-5 still holds everywhere else, where the provider
  // funnel is how a security company signs up rather than a plan the client
  // chooses between.
  if (product === 'vbg') {return plans;}
  return [...plans, PROVIDER_CARD];
}

export default function RoleSelectionScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  // Issue 22 — the product card tapped on Onboarding decides which plans show.
  const pendingProduct = useProductStore(st => st.pendingProduct);
  const cards = useMemo(() => cardsForProduct(pendingProduct), [pendingProduct]);
  const [selected, setSelected] = useState<Choice>('lite');

  const handleConfirm = () => {
    if (selected === 'provider') {
      // Operator Partner = a SERVICE PROVIDER (agency). Individual-CPO
      // self-registration was removed — CPOs only exist as managed sub-accounts
      // their provider creates. Registration always creates an 'individual' user
      // (backend refuses self-selected roles); we persist a flag so that AFTER
      // auth the app routes into the agent flow, where POST /agents {company}
      // flips the role to 'service_provider'.
      void pendingTier.clear();
      void pendingProvider.set();
      navigation.navigate('Register', {role: 'agent', tier: 'lite'});
      return;
    }
    // All tiers sign up identically (founder rule 5). Only a MESSENGER paid
    // pick rides pendingTier to the post-auth subscription paywall — that
    // paywall sells the messenger ladder (Bravo Messenger Pro / Enterprise).
    // "Bravo Secure Pro" on the Secure path is request-and-approval: it cannot
    // be bought at signup, so the account starts Lite and the user applies
    // from Home → Bravo Secure Service once inside.
    void pendingProvider.clear();
    if (selected === 'lite' || pendingProduct !== 'messenger') { void pendingTier.clear(); }
    else { void pendingTier.set(selected); }
    navigation.navigate('Register', {role: 'individual', tier: selected});
  };

  const continueDisabled = false;

  return (
    <View style={styles.root}>
      {/* Ambient obsidian + cobalt glow */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <LinearGradient
          colors={['rgba(91,141,239,0.10)', 'rgba(91,141,239,0)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={styles.topGlow}
        />
        <LinearGradient
          colors={['rgba(47,91,224,0.06)', 'rgba(47,91,224,0)']}
          start={{x: 0.5, y: 1}}
          end={{x: 0.5, y: 0}}
          style={styles.bottomGlow}
        />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {paddingTop: insets.top + 12, paddingBottom: insets.bottom + 132},
        ]}
        showsVerticalScrollIndicator={false}>

        {/* Top bar — back only (step bar removed) */}
        <View style={styles.topRow}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}>
            <IcBack c={T.text} />
          </TouchableOpacity>
        </View>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Choose Your Plan</Text>
          <Text style={styles.title}>How will you{'\n'}use Bravo?</Text>
          <Text style={styles.subtitle}>
            Every plan signs up the same way. Paid plans ask for the
            subscription at the end — you can start on Lite and upgrade any time.
          </Text>
        </View>

        {/* Cards — 3 tiers (full M1A feature columns) + Operator Partner */}
        <View style={styles.cards}>
          {cards.map(card => {
            const active = selected === card.id;
            const iconColor = active ? '#A9C5FF' : T.textDim;
            return (
              <TouchableOpacity
                key={card.id}
                activeOpacity={0.9}
                onPress={() => setSelected(card.id)}
                style={styles.cardWrap}>
                <LinearGradient
                  colors={
                    active
                      ? ['rgba(20,32,56,0.92)', 'rgba(13,18,28,0.9)']
                      : ['rgba(22,27,37,0.7)', 'rgba(17,21,29,0.66)']
                  }
                  start={{x: 0.5, y: 0}}
                  end={{x: 0.5, y: 1}}
                  style={[styles.card, active ? styles.cardActive : styles.cardIdle]}>

                  {/* top edge light */}
                  <LinearGradient
                    colors={[
                      'transparent',
                      active ? 'rgba(120,160,255,0.35)' : 'rgba(255,255,255,0.12)',
                      'transparent',
                    ]}
                    start={{x: 0, y: 0}}
                    end={{x: 1, y: 0}}
                    style={styles.edgeLight}
                  />

                  <View style={styles.cardTop}>
                    <View
                      style={[
                        styles.cardIcon,
                        active
                          ? {borderColor: 'rgba(91,141,239,0.4)'}
                          : {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: T.hair2},
                      ]}>
                      {active && (
                        <LinearGradient
                          colors={['rgba(91,141,239,0.28)', 'rgba(47,91,224,0.08)']}
                          start={{x: 0.2, y: 0}}
                          end={{x: 0.9, y: 1}}
                          style={StyleSheet.absoluteFill}
                        />
                      )}
                      <card.Icon c={iconColor} />
                    </View>

                    <View style={styles.cardInfo}>
                      <Text
                        style={[
                          styles.cardEyebrow,
                          {color: active ? '#A9C5FF' : T.textMute},
                        ]}>
                        {card.eyebrow.toUpperCase()}
                      </Text>
                      <Text style={styles.cardTitle}>{card.title}</Text>
                      <Text style={styles.cardDesc}>{card.desc}</Text>
                    </View>

                    <Radio on={active} />
                  </View>

                  {/* Full feature column — always listed, never shorthand (M1A §2). */}
                  {card.features && (
                    <>
                      <View style={styles.divider} />
                      <View style={styles.features}>
                        {card.features.map(f => (
                          <View key={f} style={styles.featureRow}>
                            <View style={styles.featureCheck}>
                              <IcCheck s={11} c={T.signal} />
                            </View>
                            <Text style={styles.featureText}>{f}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}

                  {/* Service-provider onboarding. Individual-CPO self-signup
                      was removed — officers join via the provider's roster. */}
                  {card.id === 'provider' && (
                    <>
                      <View style={styles.divider} />
                      <Text style={styles.tierLabel}>WHAT YOU GET</Text>
                      <View style={styles.subRow}>
                        <SubCard
                          name="Operator Partner"
                          desc="Team roster · master licence · create & manage your officers · consolidated payouts"
                          on={active}
                          onPress={() => setSelected('provider')}
                        />
                      </View>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* Fixed footer CTA */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        start={{x: 0.5, y: 0}}
        end={{x: 0.5, y: 0.55}}
        style={[styles.footer, {paddingBottom: insets.bottom + 24}]}>
        <View style={styles.reassure}>
          <IcLock c={T.textMute} />
          <Text style={styles.reassureText}>
            Encrypted onboarding · you can change this later
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={handleConfirm}
          disabled={continueDisabled}
          style={continueDisabled && {opacity: 0.5}}>
          <LinearGradient
            colors={['#6E9BF5', T.accent, T.accentDeep]}
            start={{x: 0.5, y: 0}}
            end={{x: 0.5, y: 1}}
            style={styles.btn}>
            <Text style={styles.btnText}>
              {continueDisabled ? 'Agency coming soon' : 'Continue'}
            </Text>
            {!continueDisabled && <IcArrow c="#fff" />}
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},

  topGlow: {position: 'absolute', top: -120, left: '10%', right: '10%', height: 400, borderRadius: 500},
  bottomGlow: {position: 'absolute', bottom: -200, left: -60, right: -60, height: 400, borderRadius: 500},

  scroll: {flex: 1},
  scrollContent: {paddingHorizontal: 22},

  // Top bar — back button only, step indicator removed.
  topRow: {flexDirection: 'row', alignItems: 'center', minHeight: 42},
  backBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: T.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  header: {paddingTop: 22, paddingBottom: 18, paddingHorizontal: 2},
  eyebrow: {color: T.textMute, fontSize: 11, fontWeight: '600', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12},
  title: {color: T.text, fontSize: 33, fontWeight: '700', letterSpacing: -1, lineHeight: 34, marginBottom: 11},
  subtitle: {color: T.textDim, fontSize: 14, lineHeight: 20, letterSpacing: -0.1, maxWidth: 320},

  cards: {gap: 13},
  cardWrap: {borderRadius: 22},
  card: {borderRadius: 22, padding: 18, overflow: 'hidden'},
  cardIdle: {borderWidth: 1, borderColor: T.hair},
  cardActive: {borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)'},
  edgeLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1},

  cardTop: {flexDirection: 'row', alignItems: 'flex-start', gap: 14},
  cardIcon: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, overflow: 'hidden',
  },
  cardInfo: {flex: 1, paddingTop: 1},
  cardEyebrow: {fontSize: 9.5, fontWeight: '700', letterSpacing: 1.8, marginBottom: 5},
  cardTitle: {color: T.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.4, marginBottom: 5},
  cardDesc: {color: T.textDim, fontSize: 12.5, lineHeight: 18, letterSpacing: -0.05},

  radio: {width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  radioFill: {width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  radioDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff'},

  divider: {height: 1, backgroundColor: T.hair, marginTop: 16, marginBottom: 14},

  features: {gap: 12, marginBottom: 17},
  featureRow: {flexDirection: 'row', alignItems: 'center', gap: 11},
  featureCheck: {
    width: 19, height: 19, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(74,222,128,0.12)',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)',
  },
  featureText: {color: T.text, fontSize: 13.5, fontWeight: '500', letterSpacing: -0.1},

  tierLabel: {color: T.textMute, fontSize: 9, fontWeight: '700', letterSpacing: 1.8, marginBottom: 9},
  subRow: {flexDirection: 'row', gap: 10},
  subCardWrap: {flex: 1, borderRadius: 14},
  subCard: {flex: 1, borderRadius: 14, paddingTop: 13, paddingHorizontal: 14, paddingBottom: 14, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: T.hair2, overflow: 'hidden'},
  subCardActive: {borderColor: 'rgba(91,141,239,0.45)'},
  subCardSoon: {opacity: 0.6, borderStyle: 'dashed'},
  subTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6},
  subName: {color: T.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.3},
  subCheck: {width: 17, height: 17, borderRadius: 8.5, alignItems: 'center', justifyContent: 'center'},
  subDesc: {color: T.textDim, fontSize: 11.5, lineHeight: 16, letterSpacing: -0.05},
  soonBadge: {
    position: 'absolute', top: -1, right: 12,
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 99,
    backgroundColor: '#05070B', borderWidth: 1, borderColor: T.accent,
  },
  soonText: {fontSize: 7.5, letterSpacing: 1.2, fontWeight: '800', color: T.accent},

  footer: {position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 22, paddingTop: 22},
  reassure: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginBottom: 13},
  reassureText: {color: T.textMute, fontSize: 9.5, letterSpacing: 0.6},
  btn: {
    height: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  btnText: {color: '#fff', fontSize: 16.5, fontWeight: '700', letterSpacing: 0.2},
}));
