import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {enterpriseApi} from '@services/api';
import {findNavigatorWithRoute} from '@navigation/departmentalEntry';
import {OB, ObHeader, SectionLabel, Card, useInDepartmentalShell} from './_obsidian';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;

/**
 * A4 / M4 — Select Role, the Enterprise fork.
 *
 * "After choosing Enterprise, the user declares whether they are creating the
 *  organisation or joining one."
 *
 * ── WHY THIS SCREEN EXISTS SEPARATELY FROM RoleSelection ─────────────────────
 *
 * `RoleSelectionScreen` picks a PLAN (lite / pro / enterprise / provider) before
 * registration. This picks a ROLE WITHIN Enterprise, and it can only be asked
 * after authentication — creating a workspace needs a user to own it, and
 * joining one needs an identity to attach the request to.
 *
 * ── A2 / M2: PROFESSIONAL MUST NOT APPEAR ────────────────────────────────────
 *
 * The PDF's plan rule governs the Enterprise onboarding route, and this screen
 * is that route. It shows no plan tiers at all — which satisfies the rule
 * structurally rather than by filtering a list someone could later re-widen.
 * `PricingScreen` is Settings → Pricing, a different surface, and filtering it
 * would break plan management for every user in the app.
 */
export default function EnterpriseSetupScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inShell = useInDepartmentalShell();
  const [checking, setChecking] = useState(true);

  // If they ALREADY own a workspace this screen is a dead end — send them in.
  // Checked on mount rather than trusted from a param: the fork is reachable
  // from more than one entry point and a stale param would strand the owner on
  // a "create your workspace" screen for a workspace they have.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const {data} = await enterpriseApi.myWorkspace();
        if (alive && data?.workspace) {
          // F-WSHUB — owners land on the Workspace Hub (their workspace, plus
          // any invites' one honest home), entering the shell from there via
          // the departmentalEntry resolver. Resolved first: the Agent/CPO
          // shells don't register the hub route, and a replace to a route the
          // mounted tree lacks is silently dropped — those keep the old door.
          if (findNavigatorWithRoute(navigation, 'WorkspaceHub')) {
            navigation.replace('WorkspaceHub');
          } else {
            navigation.replace('Departmental');
          }
          return;
        }
      } catch {
        // Offline or the flag is off — fall through and show the choice. The
        // create call itself is the real gate and reports its own failure.
      }
      if (alive) {setChecking(false);}
    })();
    return () => {alive = false;};
  }, [navigation]);

  const goCreate = useCallback(() => navigation.navigate('CreateWorkspace'), [navigation]);
  const goJoin = useCallback(() => navigation.navigate('JoinWorkspace', {}), [navigation]);

  return (
    <View style={[s.root, {paddingTop: inShell ? 0 : insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Enterprise" onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: (inShell ? 0 : insets.bottom) + 28}}>
        <Text style={s.lede}>
          How are you joining Bravo Enterprise?
        </Text>
        <Text style={s.sub}>
          You can change this later only by leaving your organisation, so pick the
          one that describes you.
        </Text>

        <SectionLabel>Choose one</SectionLabel>

        <Card style={s.choice} onPress={checking ? undefined : goCreate}>
          <View style={s.row}>
            <View style={[s.badge, {backgroundColor: 'rgba(91,141,239,0.14)'}]}>
              <Icon name="office-building-outline" size={22} color={OB.accent} />
            </View>
            <View style={s.copy}>
              <Text style={s.title} accessibilityRole="header">Create a workspace</Text>
              <Text style={s.body}>
                You are setting up your organisation. You become the Admin, build
                the channel structure and approve who joins.
              </Text>
            </View>
            <Icon name="chevron-right" size={22} color={OB.textMute} />
          </View>
        </Card>

        <Card style={s.choice} onPress={checking ? undefined : goJoin}>
          <View style={s.row}>
            <View style={[s.badge, {backgroundColor: 'rgba(180,188,204,0.12)'}]}>
              <Icon name="account-multiple-plus-outline" size={22} color={OB.text} />
            </View>
            <View style={s.copy}>
              <Text style={s.title} accessibilityRole="header">Join a workspace</Text>
              <Text style={s.body}>
                Your organisation already uses Bravo. You will need the invitation
                link or code they shared with you.
              </Text>
            </View>
            <Icon name="chevron-right" size={22} color={OB.textMute} />
          </View>
        </Card>

        {/* M11A geometry, applied early: a Member who has applied sees nothing
            of the organisation until they are approved, so this screen never
            names one. */}
        <Text style={s.foot}>
          Joining does not give you access until an Admin approves your request.
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:   {flex: 1, backgroundColor: OB.bg},
  lede:   {color: OB.text, fontSize: 20, fontWeight: '700', marginTop: 6},
  sub:    {color: OB.textMute, fontSize: 13, marginTop: 8, lineHeight: 20},
  choice: {marginTop: 12, paddingVertical: 18},
  row:    {flexDirection: 'row', alignItems: 'center', gap: 14},
  badge:  {width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center'},
  copy:   {flex: 1},
  title:  {color: OB.text, fontSize: 15, fontWeight: '700'},
  body:   {color: OB.textMute, fontSize: 12, marginTop: 4, lineHeight: 18},
  foot:   {color: OB.textMute, fontSize: 12, marginTop: 22, textAlign: 'center'},
}));
