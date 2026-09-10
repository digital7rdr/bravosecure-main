/**
 * BR-1 — non-blocking restore progress banner for MessengerHome.
 *
 * Subscribes to the background restore runner (restoreBackground.ts) and
 * renders a slim status strip under the connection banner:
 *   • running — spinner + step label + live message count. The user can
 *     read and send while history streams in batch-by-batch underneath.
 *   • error   — the humanized failure + RETRY (resumes at the first
 *     incomplete phase; cursors persist so no work is repeated).
 *   • done    — brief success line with counts; auto-dismisses.
 *
 * Renders nothing when idle, so it costs the home screen nothing outside
 * an active restore.
 */
import React, {useEffect, useSyncExternalStore} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {
  getBackgroundRestoreState,
  subscribeBackgroundRestore,
  retryBackgroundRestore,
  dismissBackgroundRestoreResult,
} from '@/modules/messenger/backup/restoreBackground';

// Obsidian surface + cobalt accent per the design-system master tokens.
const C = {
  surf:   'rgba(91, 141, 239, 0.10)',
  bd:     'rgba(91, 141, 239, 0.35)',
  accent: '#5B8DEF',
  tx:     '#E6EDF7',
  tx2:    '#8FA3C0',
  okSurf: 'rgba(0, 200, 83, 0.10)',
  okBd:   'rgba(0, 200, 83, 0.35)',
  ok:     '#00C853',
  errSurf: 'rgba(255, 92, 92, 0.10)',
  errBd:  'rgba(255, 92, 92, 0.35)',
  err:    '#FF5C5C',
};

export default function RestoreActivityBanner(): React.ReactElement | null {
  const state = useSyncExternalStore(subscribeBackgroundRestoreSafe, getBackgroundRestoreState);

  // Success state lingers briefly, then clears itself.
  useEffect(() => {
    if (state.kind !== 'done') {return;}
    const t = setTimeout(() => dismissBackgroundRestoreResult(), 8_000);
    return () => clearTimeout(t);
  }, [state.kind]);

  if (state.kind === 'idle') {return null;}

  if (state.kind === 'running') {
    return (
      <View style={[s.root, {backgroundColor: C.surf, borderColor: C.bd}]}>
        <ActivityIndicator size="small" color={C.accent} />
        <View style={s.body}>
          <Text style={s.title} numberOfLines={1}>
            {state.messages > 0
              ? `Restoring your messages — ${state.messages.toLocaleString()} so far`
              : 'Restoring your messages…'}
          </Text>
          <Text style={s.sub} numberOfLines={1}>{state.step} · You can keep chatting</Text>
        </View>
      </View>
    );
  }

  if (state.kind === 'done') {
    return (
      <TouchableOpacity
        style={[s.root, {backgroundColor: C.okSurf, borderColor: C.okBd}]}
        onPress={dismissBackgroundRestoreResult}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss restore summary">
        <Icon name="check-circle-outline" size={16} color={C.ok} />
        <View style={s.body}>
          <Text style={s.title} numberOfLines={1} accessibilityLiveRegion="polite">
            Restore complete — {state.messages.toLocaleString()} messages, {state.conversations.toLocaleString()} chats
          </Text>
          {state.skipped > 0 && (
            <Text style={s.sub} numberOfLines={1}>{state.skipped.toLocaleString()} older messages couldn’t be decrypted</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[s.root, {backgroundColor: C.errSurf, borderColor: C.errBd}]}>
      <Icon name="alert-circle-outline" size={16} color={C.err} />
      <View style={s.body}>
        <Text style={s.title} numberOfLines={2} accessibilityLiveRegion="polite">{state.message}</Text>
      </View>
      <TouchableOpacity
        style={s.retryBtn}
        onPress={() => { retryBackgroundRestore(); }}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Retry restore">
        <Text style={s.retryTxt}>RETRY</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={s.dismissBtn}
        onPress={dismissBackgroundRestoreResult}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss restore error">
        <Icon name="close" size={14} color={C.tx2} />
      </TouchableOpacity>
    </View>
  );
}

// Why: useSyncExternalStore re-subscribes on identity change; the module
// function is stable, but wrap it so the unsubscribe contract is explicit.
function subscribeBackgroundRestoreSafe(onStoreChange: () => void): () => void {
  return subscribeBackgroundRestore(onStoreChange);
}

const s = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  body: {flex: 1},
  title: {color: C.tx, fontSize: 12, fontWeight: '600'},
  sub:   {color: C.tx2, fontSize: 11, marginTop: 1},
  retryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(91, 141, 239, 0.18)',
  },
  retryTxt: {color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.6},
  dismissBtn: {padding: 4},
});
