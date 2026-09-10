import {useCallback, useEffect, useRef} from 'react';
import {useIsFocused, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Alert} from '@utils/alert';
import {useAuthStore} from '@store/authStore';
import {departmentApi, type DepartmentChannelDto} from '@services/api';
import {ensureChannelProvisioned} from '@/modules/messenger/orgWorkspace/provisionChannel';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {waitForMessengerReady} from '@/modules/messenger/hooks';
import type {MessengerStackParamList} from '@navigation/types';

/**
 * THE one way to open a department channel.
 *
 * This is not a convenience wrapper. Opening a channel is four decisions, and
 * every one of them is invisible at the call site:
 *
 *  1. WAIT for the messenger store to finish hydrating from the encrypted DB.
 *     Reading `groups[id].masterKeyB64` mid-hydration is indistinguishable from
 *     "the key is gone", which fired the destructive reactivation prompt on
 *     ordinary logins.
 *  2. PROVISION an admin's brand-new channel that has no Signal group yet.
 *  3. OFFER RECOVERY when the OWNER's device holds the group id but lost its
 *     master key — the owner IS the key source, so re-share cannot rescue it.
 *  4. Carry `isOwner` and `postMode` into the route. `isOwner` gates "Delete
 *     channel" in ChannelMembersScreen; `postMode` drives the receive-side
 *     rejection of posts from non-posters.
 *
 * When item 6 added a SECOND door (the organisation drill-down), that door
 * re-implemented only step 4 and dropped `isOwner` with it — so the owner could
 * delete a channel reached one way and not the other, and a key-less owner got
 * a silently dead thread with no prompt. That is this repo's most-shipped
 * defect shape (one behaviour, N drifted copies), so the behaviour lives here
 * and the screens own only their own state.
 */
export interface OpenDepartmentChannelHooks {
  /** Channel id while its group is being provisioned; null when that ends. */
  onProvisioning?: (channelId: string | null) => void;
  /** A channel's group id was just learned — patch it into the local list. */
  onGroupLearned?: (channelId: string, groupConversationId: string) => void;
}

export function useOpenDepartmentChannel(hooks: OpenDepartmentChannelHooks = {}) {
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const userId = useAuthStore(st => st.user?.id);

  // Why: the hooks object is a fresh literal on every render of the calling
  // screen, so closing over it directly would give the returned callback a new
  // identity every render — and this callback is what the whole list binds to.
  //
  // Assigned in an EFFECT, not the render body. A ref written during render is
  // the pattern React 19 warns about: a discarded or replayed render leaves the
  // ref pointing at a closure that never committed. It is safe today only
  // because both call sites pass stable setters, so the next caller that closes
  // over state would inherit a silent staleness bug.
  const hooksRef = useRef(hooks);
  useEffect(() => { hooksRef.current = hooks; });

  /**
   * OPENING IS ASYNCHRONOUS AND UNCANCELLABLE, so it has to check whether the
   * screen still wants it.
   *
   * `waitForMessengerReady` resolves on a 4-SECOND TIMEOUT when hydration never
   * lands — the ordinary cold-boot case. Without this guard, a member who taps
   * a row and immediately presses back gets yanked into a chat seconds later
   * from wherever they went; worse, `Alert` here is a global FIFO queue owned
   * by the app root, not a screen modal, so "Reactivate channel?" surfaces on
   * an unrelated screen and its confirm button navigates from there.
   *
   * The directory always had these awaits; the drill-down navigated
   * synchronously until it started sharing this opener, so merging the doors is
   * what spread the exposure.
   *
   * FOCUS, NOT MOUNT. The first version of this guard keyed on unmount, which
   * closes only the case it was written from (tap → back → pop). The directory
   * is a TAB ROOT — React Navigation does not unmount it on a tab switch, nor
   * when another screen is pushed over it — so tap → switch to Attendance, or
   * tap → drill into the tree, both left `alive` true and the stale navigate
   * still fired. Those are the commoner exits, not the rarer ones.
   */
  const isFocused = useIsFocused();
  const alive = useRef(true);
  /**
   * A COUNTER, not just a boolean — because the boolean re-arms.
   *
   * Sampling `alive` when the await finishes cannot see a round trip: tap →
   * switch tab → switch back inside the 4s window leaves it `true` again, which
   * is exactly the state the guard exists to catch. The question is "did the
   * user leave AT ANY POINT while this ran", so each departure bumps a
   * generation that an in-flight open captured at its start.
   */
  const departures = useRef(0);
  useEffect(() => {
    alive.current = isFocused;
    if (!isFocused) {departures.current += 1;}
    return () => {
      alive.current = false;
      departures.current += 1;
    };
  }, [isFocused]);

  const stillWanted = useCallback(
    (startedAt: number) => alive.current && departures.current === startedAt,
    []);

  const recoverChannel = useCallback(async (c: DepartmentChannelDto) => {
    /**
     * HOLDS THE SAME GUARD AS THE MAIN CALLBACK.
     *
     * This runs from an Alert button, long after the press that raised it — by
     * which time the opener's own finally has already released the flag and
     * cleared the spinner. So during a reset + full group mint + re-key (several
     * seconds, and destructive) every row was live again: a tap on another row
     * cleared THIS row's spinner mid-recovery and re-enabled it, and a second
     * tap on it saw the stale key-less dto, prompted again, and ran a second
     * resetGroup that destroyed the group the first had just minted and re-keyed
     * members into.
     */
    if (opening.current) {return;}
    opening.current = true;
    hooksRef.current.onProvisioning?.(c.id);
    try {
      await departmentApi.resetGroup(c.id);
      const res = await ensureChannelProvisioned(c.id, c.name, null);
      // The group was really minted, so record it even if we are unmounting —
      // the callback is a setState the screen may have already discarded, and
      // React tolerates that. Only NAVIGATION and ALERTS are gated below,
      // because those two act on whatever screen is in front of the user now.
      if (res.status === 'ok') {
        hooksRef.current.onGroupLearned?.(c.id, res.groupConversationId);
      }
      if (res.status === 'ok') {
        if (alive.current) {
          navigation.navigate('DepartmentChat', {
            channelId: c.id, channelName: c.name, channelDesc: c.description ?? '',
            groupConversationId: res.groupConversationId, myRole: c.my_role, isOwner: true,
            postMode: c.post_mode,
          });
        } else {
          // The navigate IS the success report, so leaving the screen removed
          // the only feedback from the MOST COMMON outcome — the reasoning that
          // keeps the failure alerts ungated was applied to three cases out of
          // four. Confirming this destroys every earlier message for every
          // member; that cannot land in silence.
          Alert.alert('Channel reactivated',
            `${c.name} has a fresh encrypted group and its members are re-keyed. Earlier messages stay unreadable.`);
        }
      } else if (res.status === 'needs_members') {
        // NOT a success title: the history is gone and nothing was re-keyed.
        Alert.alert('Channel reset',
          `${c.name} has a fresh encrypted group, but no other member was reachable to re-key yet. Earlier messages are unreadable. Add a member to start messaging.`);
      } else if (res.status === 'failed') {
        Alert.alert('Could not reactivate', `${c.name}: ${res.message}`);
      }
    } catch (e) {
      /**
       * REPORTED EVEN IF THE SCREEN IS GONE, unlike everywhere else here.
       *
       * `resetGroup` has already nulled the channel's group server-side by this
       * point, which makes every earlier message in it permanently unreadable
       * for every member. Staying silent because the user wandered off between
       * confirming and the request finishing would leave them with a destroyed
       * transcript and no idea it happened — the alert queue is app-global, so
       * it will reach them wherever they are. The general "don't surface on
       * another screen" rule is about unasked-for noise; this is the result of
       * something they explicitly confirmed.
       */
      Alert.alert('Could not reactivate', `${c.name}: ${(e as Error)?.message ?? 'Reset failed.'}`);
    } finally {
      opening.current = false;
      hooksRef.current.onProvisioning?.(null);
    }
  }, [navigation]);


  /**
   * ONE open at a time.
   *
   * The 0-4s hydration wait leaves every OTHER row tappable — `provisioning` is
   * a single id, so only the tapped row disables. Two chains in flight both
   * reached `navigate`, and the second tap's `onProvisioning(null)` cleared the
   * first's spinner while its work continued, so the indicator lied in both
   * directions. Worse, the two navigates landed on one screen: without a
   * per-channel route key the second only swapped params, and the chat screen
   * keeps its group id in state.
   *
   * A ref, not state: this is read and set inside one tap handler, before any
   * render could deliver a new value.
   */
  const opening = useRef(false);

  return useCallback(async (c: DepartmentChannelDto) => {
    if (opening.current) {return;}
    opening.current = true;
    // BEFORE the awaits, not after. The spinner used to start only once
    // provisioning began, so the 0-4s hydration wait left the row fully enabled
    // and visually inert — the founder's "the tap renders but the action takes
    // time to register" symptom, manufactured.

    const startedAt = departures.current;
    try {
      hooksRef.current.onProvisioning?.(c.id);
      await getMessengerRuntime('production');
      await waitForMessengerReady();
      if (!stillWanted(startedAt)) {return;}
      let groupConversationId = c.group_conversation_id;
      const isOwner = !!userId && c.created_by === userId;
      const hasKey = !!groupConversationId &&
        !!useMessengerStore.getState().groups[groupConversationId]?.masterKeyB64;

      if (!groupConversationId && c.my_role === 'admin') {
        const res = await ensureChannelProvisioned(c.id, c.name, c.group_conversation_id);
        if (res.status === 'ok' || res.status === 'already') {
          groupConversationId = res.groupConversationId;
          hooksRef.current.onGroupLearned?.(c.id, res.groupConversationId);
        }
        if (!stillWanted(startedAt)) {return;}
        // The failure branches ONLY. Splitting the original if/else-if chain to
        // slip the liveness check in turned its trailing `else` into a catch-all
        // that fired "Could not open channel" on success — the statuses must
        // stay explicit.
        if (res.status === 'needs_members') {
          Alert.alert('Channel not active yet',
            'Add a member to this channel first — its encrypted group is created once there is someone to message.');
          return;
        }
        if (res.status === 'failed') {
          Alert.alert('Could not open channel', res.message);
          return;
        }
      } else if (groupConversationId && !hasKey && isOwner) {
        Alert.alert('Reactivate channel?',
          'This channel lost its encryption key on this device. Reactivating creates a fresh encrypted group and re-keys its members. Earlier messages stay unreadable.',
          [
            {text: 'Cancel', style: 'cancel'},
            {text: 'Reactivate', onPress: () => { void recoverChannel(c); }},
          ]);
        return;
      }
      navigation.navigate('DepartmentChat', {
        channelId: c.id,
        channelName: c.name,
        channelDesc: c.description ?? '',
        groupConversationId,
        myRole: c.my_role,
        isOwner,
        postMode: c.post_mode,
      });
    } catch (e) {
      // `getMessengerRuntime` REJECTS on an offline cold boot and again after a
      // wipe. With no catch here that rejection escaped into `void onPress(…)`,
      // the clear below never ran, and the row kept its spinner AND its
      // `disabled` for the life of the screen — dead, silent and unrecoverable.
      // Round 3's own "keep the rows on a failed refresh" fix guarantees there
      // are tappable rows in exactly that state.
      if (stillWanted(startedAt)) {
        Alert.alert('Could not open channel', `${c.name}: ${(e as Error)?.message ?? 'Please try again.'}`);
      }
    } finally {
      // ONE clear site, and it runs on every path.
      opening.current = false;
      hooksRef.current.onProvisioning?.(null);
    }
  }, [navigation, userId, recoverChannel, stillWanted]);
}
