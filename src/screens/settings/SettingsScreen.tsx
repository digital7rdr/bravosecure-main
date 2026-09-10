/**
 * SettingsScreen (BUILD_RUNBOOK Step 25) — language, currency, notification categories
 * (Safety forced-on), location-sharing scope, and app-lock. Saves to
 * PATCH /users/me/preferences; switching to/from Arabic flips RTL via I18nManager and
 * prompts a restart (an RN constraint — forceRTL fully applies only after a reload).
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Switch} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {preferencesApi, type UserPreferences} from '@services/api';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {t, setLanguage, applyRtl, getLanguage, type Lang} from '@/i18n';
import {goBackOnce} from '@navigation/tapGuard';

const LANGS: Array<{code: Lang; label: string}> = [
  {code: 'en', label: 'English'},
  {code: 'ar', label: 'العربية'},
  {code: 'bn', label: 'বাংলা'},
];
const CURRENCIES: Array<UserPreferences['currency']> = ['AED', 'SAR', 'BDT', 'GBP'];
// REGION (#8) — canonical region options (incl. ZA) + an explicit N/A for users
// outside coverage. Matching is region-scoped: a client only ever receives SPs in
// their region, and an SP only receives same-region client requests.
const REGION_OPTS: Array<{code: 'AE' | 'SA' | 'BD' | 'GB' | 'ZA' | 'N/A'; label: string}> = [
  {code: 'AE',  label: 'UAE — Dubai'},
  {code: 'SA',  label: 'Saudi Arabia'},
  {code: 'BD',  label: 'Bangladesh'},
  {code: 'GB',  label: 'United Kingdom'},
  {code: 'ZA',  label: 'South Africa'},
  {code: 'N/A', label: 'Outside supported area'},
];
const SCOPES: Array<{key: UserPreferences['locationScope']; labelKey: string}> = [
  {key: 'while_on_duty', labelKey: 'settings.location.while_on_duty'},
  {key: 'during_mission', labelKey: 'settings.location.during_mission'},
  {key: 'never', labelKey: 'settings.location.never'},
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [lang, setLang] = useState<Lang>(getLanguage());
  const [currency, setCurrency] = useState<UserPreferences['currency']>('AED');
  const [homeRegion, setHomeRegion] = useState<UserPreferences['homeRegion']>(null);
  const [notif, setNotif] = useState<Record<string, boolean>>({safety: true, trip: true, marketing: false});
  const [scope, setScope] = useState<UserPreferences['locationScope']>('while_on_duty');
  const [appLock, setAppLock] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    preferencesApi.get().then(({data}) => {
      if (!alive) {return;}
      if (data.language) {setLang(data.language);}
      setCurrency(data.currency ?? 'AED');
      setHomeRegion(data.homeRegion ?? null);
      setNotif({...(data.notifPrefs ?? {}), safety: true});
      setScope(data.locationScope ?? 'while_on_duty');
      setAppLock(!!data.appLock);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const save = async (patch: Partial<UserPreferences>) => {
    setSaving(true);
    try {
      await preferencesApi.patch(patch);
    } catch {
      Alert.alert(t('settings.title'), 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const pickLanguage = async (next: Lang) => {
    if (next === lang) {return;}
    setLang(next);
    setLanguage(next);
    const flipped = applyRtl(next);     // returns true when the RTL direction changed
    await save({language: next});
    if (flipped) {Alert.alert(t('settings.title'), t('settings.restartPrompt'));}
  };

  const toggleNotif = (key: string) => {
    if (key === 'safety') {return;} // forced on (server-enforced too)
    const next = {...notif, [key]: !notif[key]};
    setNotif(next);
    void save({notifPrefs: next});
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t('settings.title')}</Text>
        {saving ? <Icon name="cloud-sync-outline" size={18} color={UI.textMute} /> : <View style={{width: 18}} />}
      </View>

      <ScrollView contentContainerStyle={{padding: 20, paddingBottom: insets.bottom + 32, gap: 22}} showsVerticalScrollIndicator={false}>
        {/* Language */}
        <Section title={t('settings.language')}>
          {LANGS.map(l => (
            <Row key={l.code} label={l.label} selected={lang === l.code} onPress={() => { void pickLanguage(l.code); }} />
          ))}
        </Section>

        {/* Currency */}
        <Section title={t('settings.currency')}>
          {CURRENCIES.map(c => (
            <Row key={c} label={c ?? ''} selected={currency === c} onPress={() => { setCurrency(c); void save({currency: c}); }} />
          ))}
        </Section>

        {/* Region (REGION #8) — view + change your region. A client only receives
            SPs in their region; an SP only receives same-region client requests. */}
        <Section title="Region">
          {REGION_OPTS.map(r => (
            <Row key={r.code} label={r.label} selected={homeRegion === r.code}
              onPress={() => { setHomeRegion(r.code); void save({homeRegion: r.code}); }} />
          ))}
        </Section>

        {/* Notifications */}
        <Section title={t('settings.notifications')}>
          <ToggleRow
            label={t('settings.notifications.safety')}
            sub={t('settings.notifications.safety.locked')}
            value disabled onValueChange={() => undefined} />
          <ToggleRow label={t('settings.notifications.trip')} value={notif.trip !== false} onValueChange={() => toggleNotif('trip')} />
          <ToggleRow label={t('settings.notifications.marketing')} value={notif.marketing === true} onValueChange={() => toggleNotif('marketing')} />
        </Section>

        {/* Location scope */}
        <Section title={t('settings.location')}>
          {SCOPES.map(sc => (
            <Row key={sc.key} label={t(sc.labelKey)} selected={scope === sc.key} onPress={() => { setScope(sc.key); void save({locationScope: sc.key}); }} />
          ))}
        </Section>

        {/* App lock */}
        <Section title={t('settings.appLock')}>
          <ToggleRow label={t('settings.appLock.desc')} value={appLock} onValueChange={() => { const v = !appLock; setAppLock(v); void save({appLock: v}); }} />
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View>
      <Text style={s.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}
function Row({label, selected, onPress}: {label: string; selected: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity style={s.row} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.rowLabel, selected && {color: UI.text}]}>{label}</Text>
      {selected && <Icon name="check" size={18} color={UI.accent} />}
    </TouchableOpacity>
  );
}
function ToggleRow({label, sub, value, disabled, onValueChange}: {
  label: string; sub?: string; value: boolean; disabled?: boolean; onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={s.row}>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={s.rowLabel}>{label}</Text>
        {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
      </View>
      <Switch
        value={value} disabled={disabled} onValueChange={onValueChange}
        trackColor={{true: UI.accentDeep, false: 'rgba(255,255,255,0.12)'}} thumbColor={value ? UI.accentSoft : '#9aa3b2'} />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12},
  back: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: UI.surface},
  headerTitle: {flex: 1, fontFamily: UI.fSemi, fontSize: 16, color: UI.text},
  sectionTitle: {fontFamily: UI.fBold, fontSize: 10.5, letterSpacing: 1.2, color: UI.textMute, marginBottom: 8, marginLeft: 4},
  card: {borderRadius: 14, borderWidth: 1, borderColor: UI.hair, backgroundColor: UI.surface, overflow: 'hidden'},
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: UI.hair,
  },
  rowLabel: {flex: 1, fontFamily: UI.fSemi, fontSize: 14, color: UI.textDim},
  rowSub: {fontFamily: UI.fSans, fontSize: 11.5, color: UI.textMute, marginTop: 2},
}));
