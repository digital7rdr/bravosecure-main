import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, Modal, Pressable, TouchableOpacity, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {orgApi} from '@services/api';
import {activeWorkspaceOrgParam} from '@store/activeWorkspace';
import {OB} from './_obsidian';
import type {WorkspaceModule, WorkspaceSettings} from './hiddenModules';

/**
 * Channels vs2 item 17b — the admin's control over what Home advertises.
 *
 * ⚠️ THIS HIDES CARDS, IT DOES NOT REVOKE ACCESS. Say so in the sheet, because
 * an admin who reads "hide Attendance" as "stop my team clocking in" will make a
 * decision they did not intend. Routes stay registered, every server guard is
 * unchanged, and a push or a deep link into a hidden module still works — which
 * is deliberate: notifications already in flight must not dead-end.
 *
 * Writes the WHOLE set. Two admins toggling different rows from stale sheets
 * would otherwise interleave into a state neither chose; last-writer-wins is at
 * least a state somebody asked for. The server re-checks manager rights.
 */
const MODULES: Array<{key: WorkspaceModule; label: string; sub: string}> = [
  {key: 'attendance', label: 'Attendance', sub: 'Shifts, check-in and reviews'},
  {key: 'incidents', label: 'Incidents', sub: 'Reporting and the queue'},
];

export function ModuleVisibilitySheet({visible, onClose, onSaved}: {
  visible: boolean;
  onClose: () => void;
  /** The saved settings, so the host can apply them without a refetch. */
  onSaved: (next: WorkspaceSettings) => void;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * DID A GET ACTUALLY SUCCEED? Not the same question as "is it loading".
   *
   * `hidden` starts empty, so a FAILED load rendered both rows as SHOWN —
   * indistinguishable from a workspace that hides nothing — with Save still
   * enabled. One tap then PATCHed `[]` and un-hid both modules org-wide, with
   * an audit row recording it as the admin's deliberate change.
   */
  /**
   * vs2 item 4 — WHICH organisation these toggles belong to.
   *
   * The response echoes the org the SERVER resolved. Once a person can manage
   * more than one workspace, "the settings" is no longer a single thing: if the
   * echo disagrees with the workspace on screen, the sheet is showing one
   * company's toggles under another's name and Save would rewrite the wrong
   * one — silently, with a 200 and an audit row naming it as intent.
   *
   * Refuse rather than guess. Not a `loaded` variant: the load SUCCEEDED, and
   * conflating the two would tell the admin to retry something that will keep
   * answering the same way.
   */
  const [loadedOrg, setLoadedOrg] = useState<string | null>(null);
  const [wrongOrg, setWrongOrg] = useState(false);
  /**
   * Did the mismatch happen on the WRITE? Then the change already landed on
   * another organisation and the admin has to be told so — "close and re-open"
   * would imply nothing happened. The load-side mismatch is the harmless one.
   */
  const [savedElsewhere, setSavedElsewhere] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-read on every OPEN, not once on mount: the sheet is long-lived in the
  // host's tree, and showing yesterday's toggles is how an admin "un-hides"
  // something they never touched.
  const load = useCallback(() => {
    setLoading(true);
    setLoaded(false);
    setError(null);
    setWrongOrg(false);
    setSavedElsewhere(false);
    // Reset with the rest. The sheet is long-lived in its host tree, so a
    // stale loadedOrg from a PREVIOUS open would be what the save-side
    // mismatch check compares against.
    setLoadedOrg(null);
    // Read it at REQUEST time. Reading it in the .then would compare against
    // whatever the user switched to while the request was in flight.
    const asked = activeWorkspaceOrgParam()?.orgId ?? null;
    orgApi.workspaceSettings()
      .then(({data}) => {
        // No active workspace means the single-org case, where there is nothing
        // to disagree with — and no server org means no settings to edit.
        // `!data.orgUserId` is the dangerous case, not a harmless one: the
        // server resolved NOTHING, which serialises as an empty hidden set, and
        // an empty set with Save enabled is one tap from un-hiding every module
        // org-wide. If we asked about a specific workspace and got no org back,
        // that is a disagreement, not an answer.
        if (asked && data.orgUserId !== asked) {
          setWrongOrg(true);
          return;
        }
        setHidden(Array.isArray(data.hiddenModules) ? data.hiddenModules : []);
        setLoadedOrg(data.orgUserId ?? null);
        setLoaded(true);
      })
      .catch(() => setError('Could not load your settings.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (visible) {load();} }, [visible, load]);

  const toggle = (key: WorkspaceModule) => {
    setHidden(prev => prev.includes(key) ? prev.filter(m => m !== key) : [...prev, key]);
  };

  const save = () => {
    setSaving(true);
    setError(null);
    orgApi.setWorkspaceSettings(hidden)
      .then(({data}) => {
        // The PATCH re-resolves independently of the GET. If it landed on a
        // different org than the one whose toggles are on screen, the write
        // already happened — say so rather than reporting success.
        if (loadedOrg && data.orgUserId !== loadedOrg) {
          setSavedElsewhere(true);
          setWrongOrg(true);
          return;
        }
        onSaved(data); onClose();
      })
      .catch((e: unknown) => {
        /**
         * `org_context_unknown` is PERMANENT — the server refused because the
         * caller no longer holds the org the request named. "Please try again"
         * is a lie and leaves Save armed, which is exactly the complaint the
         * wrongOrg copy two branches down exists to avoid. Route it into the
         * honest state that already exists.
         */
        const code = (e as {response?: {data?: {message?: string; code?: string}}})
          ?.response?.data;
        if (code?.code === 'org_context_unknown' || code?.message === 'org_context_unknown') {
          setWrongOrg(true);
          return;
        }
        setError('Could not save. Please try again.');
      })
      .finally(() => setSaving(false));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={s.sheet}>
        <Text style={s.title}>Modules on Home</Text>
        {/* The sentence that stops a misread. */}
        <Text style={s.note}>
          Hiding a module removes its cards from Home. It does not remove access —
          links and notifications still work.
        </Text>

        {loading ? (
          <ActivityIndicator color={OB.accentSoft} style={{marginVertical: 20}} />
        ) : wrongOrg ? (
          // Its OWN state, distinct from a failed load: retrying will answer the
          // same way, so offering a retry would be a lie. Re-entering the
          // workspace is the action that fixes it.
          <Text style={s.note} accessibilityLabel="Settings belong to a different organisation">
            {savedElsewhere
              ? 'This change was applied to a different organisation than the one on screen. Open that workspace to review it.'
              : 'These settings belong to a different organisation. Close this and re-open the workspace you want to change.'}
          </Text>
        ) : !loaded ? (
          // No rows at all rather than a default-looking set: showing
          // "everything shown" when we do not know is how the Save above
          // became destructive.
          <TouchableOpacity
            style={s.row}
            accessibilityRole="button"
            accessibilityLabel="Retry loading module settings"
            onPress={load}>
            <Text style={s.rowLabel}>Tap to retry</Text>
          </TouchableOpacity>
        ) : (
          MODULES.map(m => {
            const on = !hidden.includes(m.key);
            return (
              <TouchableOpacity
                key={m.key}
                style={s.row}
                activeOpacity={0.8}
                accessibilityRole="switch"
                accessibilityState={{checked: on}}
                accessibilityLabel={`${m.label}, ${on ? 'shown' : 'hidden'}`}
                onPress={() => toggle(m.key)}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.rowLabel} numberOfLines={1}>{m.label}</Text>
                  <Text style={s.rowSub} numberOfLines={1}>{m.sub}</Text>
                </View>
                <Icon
                  name={on ? 'eye-outline' : 'eye-off-outline'}
                  size={20}
                  color={on ? OB.accentSoft : OB.textMute}
                />
              </TouchableOpacity>
            );
          })
        )}

        {error ? <Text style={s.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[s.save, saving && {opacity: 0.6}]}
          disabled={saving || loading || !loaded || wrongOrg}
          accessibilityRole="button"
          accessibilityLabel="Save module visibility"
          onPress={save}>
          {saving
            ? <ActivityIndicator color="#FFF" size="small" />
            : <Text style={s.saveText}>Save</Text>}
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute', left: 20, right: 20, top: '25%',
    /**
     * OPAQUE, deliberately — client 2026-08-22: "when I select Modules it's
     * difficult to read because the background words also show through".
     *
     * `OB.card` is `rgba(22,27,37,0.72)`, which is right for a card sitting ON
     * the page (the obsidian surface reads through by design) and wrong for a
     * sheet FLOATING over one: the Home cards behind it stayed legible straight
     * through the copy. Every sibling sheet in this module is already opaque
     * (`#0C1017` / `#10141C`); this one was the outlier. Elevation so Android
     * composites it above the page rather than blending with it.
     */
    backgroundColor: '#0C1017', borderRadius: 16, padding: 20, gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
    elevation: 24,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 8},
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: OB.hair,
  },
  save: {
    minHeight: 44, borderRadius: 10, backgroundColor: OB.accent,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  ...scaleTextStyles({
    title: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16},
    note: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, marginBottom: 4},
    rowLabel: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},
    rowSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
    error: {color: OB.alert, fontFamily: BravoFont.regular, fontSize: 12},
    saveText: {color: '#FFF', fontFamily: BravoFont.semiBold, fontSize: 14},
  }),
});
