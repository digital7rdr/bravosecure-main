/**
 * 01 / 09 — Agent Type Select
 *
 * Two partner tracks:
 *   • Individual Agent   — active, goes to the 9-screen registration flow
 *   • Agency (Corporate) — coming soon, non-selectable
 *
 * Matches Bravo Agent Portal design bundle (Command Navy system).
 */
import React, {useEffect, useState} from 'react';
import {View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton, AlertWarn, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {nextStepFor, uiTypeToBackend, isAlreadyExistsError, extractMsg} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import {pendingProvider} from '@store/pendingProvider';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type AgentType = 'agency' | 'agent';

interface TypeDef {
  id: AgentType;
  icon: string;
  title: string;
  sub: string;
  bullets: string[];
  cta: string;
  comingSoon?: boolean;
  next?: keyof AgentStackParamList;
}

// Issue 34 — officers still never self-register: the ONLY way onto a roster is
// an invitation code, and only a provider can mint one. So the provider still
// decides who joins; the officer just does their own typing instead of the
// provider keying them in. (Original rule, unchanged in substance: "officers
// join via their provider's roster (managed sub-accounts)".)
const TYPES: TypeDef[] = [
  {
    id: 'agent',
    icon: 'shield-account-outline',
    title: 'Agent',
    sub: 'Close protection officer joining a security company that invited you.',
    bullets: [
      'Join with the invitation code your provider gave you',
      'Your provider manages your roster, shifts and payouts',
      'Identity + compliance checks still apply before deployment',
    ],
    cta: 'Continue with invitation code',
    next: 'AgentInviteCode',
  },
  {
    id: 'agency',
    icon: 'office-building-outline',
    title: 'Service Provider',
    sub: 'Registered private security company onboarding a roster of officers as a Bravo partner.',
    bullets: [
      'Company-wide compliance pack',
      'Create & manage your own CPOs under one master licence',
      'Provider dashboard · team dispatch · consolidated payouts',
    ],
    cta: 'Continue as Service Provider',
    next: 'AgentRegistrationWizard',
  },
];

export default function AgentTypeSelectScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [selected, setSelected] = useState<AgentType>('agency');
  const [busy, setBusy] = useState(false);
  const selectedDef = TYPES.find(t => t.id === selected)!;
  const completeAuth = useAuthStore(st => st.completeAuth);

  // If an agent row already exists for this user, skip straight to the
  // next screen — the registration wizard — so returning users don't
  // re-do this step.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await agentApi.getMe();
        if (cancelled) {return;}
        // Agent exists → jump to whichever step they're on.
        const next = nextStepFor(data.agent.status);
        if (next) {navigation.replace(next as never);}
      } catch {
        // 404 = no agent row yet; user stays on this screen to pick a type.
      }
    })();
    return () => { cancelled = true; };
  }, [navigation]);

  const onContinue = async () => {

    if (selectedDef.comingSoon || busy) {return;}
    // Issue 34 — the agent track has no agents row to create yet; the invitation
    // code is what links them, and redeeming it seeds everything server-side.
    if (selected === 'agent') {
      navigation.navigate('AgentInviteCode');
      return;
    }
    setBusy(true);
    try {
      await agentApi.create(uiTypeToBackend(selected));
      // The company agent now exists and the server flipped the user to
      // role='service_provider' — the pending-provider bridge flag has done its
      // job. Clear it + refresh the local user so role state is authoritative.
      await pendingProvider.clear();
      // completeAuth re-pulls /auth/me so the local user.role reflects the
      // server-side flip to 'service_provider'.
      await completeAuth().catch(() => undefined);
      navigation.navigate('AgentRegistrationWizard');
    } catch (e: unknown) {
      if (isAlreadyExistsError(e)) {
        await pendingProvider.clear();
        navigation.navigate('AgentRegistrationWizard');
      } else {
        Alert.alert('Could not create agent profile', extractMsg(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      {/* BB-4 (2026-08-15 back audit) — this is AgentNavigator's
          initialRouteName and nothing navigates TO it, so it is always the
          stack's first route: a bare-goBack chevron was a permanently dead
          control. NavHeader renders its spacer when onBack is undefined. */}
      <NavHeader title="Agent Portal" onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined} />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        <View style={s.brandLock}>
          <View style={s.brandRow}>
            <View style={s.logoDot} />
            <Text style={s.logoText}>BRAVO</Text>
          </View>
          <Text style={s.brandKicker}>AGENT PORTAL</Text>
          <Text style={s.brandSub}>Join the Bravo operator network</Text>
        </View>

        <Text style={s.sectionLabel}>Select Profile Type</Text>

        {TYPES.map(t => {
          const on = selected === t.id && !t.comingSoon;
          const disabled = !!t.comingSoon;
          return (
            <TouchableOpacity
              key={t.id}
              onPress={() => !disabled && setSelected(t.id)}
              disabled={disabled}
              activeOpacity={disabled ? 1 : 0.85}
              style={[
                s.ptype,
                on && s.ptypeActive,
                disabled && s.ptypeDisabled,
              ]}>

              {t.comingSoon && (
                <View style={s.comingBadge}>
                  <Text style={s.comingBadgeText}>COMING SOON</Text>
                </View>
              )}

              <View style={s.ptypeHead}>
                <View style={[s.ptypeIcon, on && s.ptypeIconActive, disabled && s.ptypeIconDisabled]}>
                  <Icon
                    name={t.icon as React.ComponentProps<typeof Icon>['name']}
                    size={20}
                    color={disabled ? Colors.textMuted : on ? Colors.primary : Colors.textSecondary}
                  />
                </View>
                <View style={s.ptypeBody}>
                  <Text style={[s.ptypeTitle, disabled && s.ptypeTitleDisabled]}>{t.title}</Text>
                  <Text style={[s.ptypeSub, disabled && s.ptypeSubDisabled]}>{t.sub}</Text>
                </View>
                {!disabled && (
                  <View style={[s.radio, on && s.radioOn]}>
                    {on && <View style={s.radioDot} />}
                  </View>
                )}
              </View>

              <View style={s.bullets}>
                {t.bullets.map(b => (
                  <View key={b} style={s.bulletRow}>
                    <Icon
                      name={disabled ? 'clock-outline' : 'check'}
                      size={12}
                      color={disabled ? Colors.textMuted : BRAND.ok}
                    />
                    <Text style={[s.bulletText, disabled && s.bulletTextDisabled]}>{b}</Text>
                  </View>
                ))}
              </View>
            </TouchableOpacity>
          );
        })}

        <AlertWarn>
          All partners must complete in-person onboarding at a Bravo office before
          receiving any assignments.
        </AlertWarn>
      </ScrollView>

      <CTAButton
        label={busy ? 'Saving…' : selectedDef.cta}
        onPress={() => { void onContinue(); }}

        variant={selectedDef.comingSoon || busy ? 'disabled' : 'primary'}
      />
    </View>
  );
}


const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 10},

  brandLock: {
    padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(30,136,255,0.05)',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    marginBottom: 2,
  },
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  logoDot: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: Colors.primary,
    shadowColor: BRAND.glow, shadowOpacity: 0.5, shadowRadius: 12,
    shadowOffset: {width: 0, height: 0},
  },
  logoText: {
    fontFamily: BravoFont.extraBold, fontSize: 20, letterSpacing: 4,
    color: Colors.textPrimary,
  },
  brandKicker: {
    fontFamily: BravoFont.bold, fontSize: 10.5, letterSpacing: 2.4,
    color: BRAND.acc, marginTop: 4,
  },
  brandSub: {fontSize: 10.5, color: Colors.textMuted, marginTop: 2, lineHeight: 15},

  sectionLabel: {
    fontFamily: BravoFont.bold, fontSize: 10.5, letterSpacing: 1.5,
    color: Colors.textMuted, textTransform: 'uppercase', marginTop: 6,
  },

  ptype: {
    padding: 12, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    position: 'relative',
  },
  ptypeActive: {
    borderColor: Colors.primary,
    backgroundColor: 'rgba(30,136,255,0.08)',
    shadowColor: Colors.primary, shadowOpacity: 0.1, shadowRadius: 22,
    shadowOffset: {width: 0, height: 8},
  },
  ptypeDisabled: {
    opacity: 0.55,
    backgroundColor: Colors.surfaceOverlay,
    borderStyle: 'dashed',
  },

  ptypeHead: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
  },
  ptypeIcon: {
    width: 34, height: 34, borderRadius: 9,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  ptypeIconActive: {
    backgroundColor: Colors.backgroundDepth,
    borderColor: Colors.primary,
  },
  ptypeIconDisabled: {
    borderColor: Colors.surfaceBorder,
  },
  ptypeBody: {flex: 1, minWidth: 0},
  ptypeTitle: {
    fontFamily: BravoFont.bold, fontSize: 13, letterSpacing: 0.5,
    color: Colors.textPrimary,
  },
  ptypeTitleDisabled: {color: Colors.textSecondary},
  ptypeSub: {fontSize: 10.5, color: Colors.textSecondary, marginTop: 3, lineHeight: 14},
  ptypeSubDisabled: {color: Colors.textMuted},

  comingBadge: {
    position: 'absolute', top: -9, right: 12,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99,
    backgroundColor: Colors.backgroundDepth,
    borderWidth: 1, borderColor: Colors.primary,
    zIndex: 2,
  },
  comingBadgeText: {
    fontFamily: BravoFont.extraBold, fontSize: 8.5, letterSpacing: 1.4,
    color: Colors.primary,
  },

  bullets: {
    marginTop: 12, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    gap: 6,
  },
  bulletRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 8},
  bulletText: {
    flex: 1, fontSize: 10.5, color: Colors.textSecondary, lineHeight: 14,
  },
  bulletTextDisabled: {color: Colors.textMuted},

  radio: {
    width: 16, height: 16, borderRadius: 8,
    borderWidth: 1.5, borderColor: Colors.borderDefault,
    marginTop: 4,
  },
  radioOn: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
    shadowColor: Colors.primary, shadowOpacity: 0.4, shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
    alignItems: 'center', justifyContent: 'center',
  },
  radioDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff'},
}));
