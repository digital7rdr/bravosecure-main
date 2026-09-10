import {useCallback, useMemo, useState} from 'react';
import {useFocusEffect} from '@react-navigation/native';

import {departmentApi} from '@services/api';
import {useEntitlements} from '@store/entitlements';
import {activeWorkspaceOrgParam, scopeChannelsToActiveWorkspace} from '@store/activeWorkspace';
import {useMessengerStore} from '../store/messengerStore';
import {listCompanyFiles, type CompanyFile, type ShelfChannel} from './companyShelf';

/**
 * Scope v2 Phase 4 — the ONE membership source for every company-file surface.
 *
 * The scope of the company shelf IS the channel list (see companyShelf.ts), so
 * if a screen could assemble that list itself it could pass a wider one — a
 * filter to forget, which is the shape this phase was warned about. Screens get
 * a finished answer and no way to widen it.
 *
 * `listChannels` is the server's membership-scoped result, refetched on focus:
 * a member removed from a channel loses its files the next time they open the
 * surface, with no local invalidation to get wrong.
 *
 * NOT fetched for a non-org account. Running it unconditionally made every
 * personal user issue `GET /department/channels` on each focus — three DB
 * queries and a logged 403 apiece — for a shelf they can never see. Narrowing,
 * never widening: `isOrgAffiliated` is the same flag that decides whether the
 * shelf exists at all.
 */
function useCompanyChannels(): ShelfChannel[] {
  const isOrgAffiliated = useEntitlements().isOrgAffiliated;
  const [channels, setChannels] = useState<ShelfChannel[]>([]);

  useFocusEffect(
    useCallback(() => {
      if (!isOrgAffiliated) {
        // Not "leave it alone" — CLEAR it. Losing org affiliation must drop the
        // shelf, not freeze whatever the last membership answer was.
        setChannels([]);
        return undefined;
      }
      let alive = true;
      void (async () => {
        try {
          // Phase B — the vault shelf shows the hub-selected workspace's
          // channels (fail-open helpers: no context / old server = all).
          const {data} = await departmentApi.listChannels(activeWorkspaceOrgParam());
          if (alive) {
            const list = scopeChannelsToActiveWorkspace(data.channels ?? []);
            // RECORD each conversation as departmental — additively, in the
            // registry, and NEVER by writing `deptGroupByChannel`.
            //
            // My first version healed that map instead, and it disarmed B-206:
            // DepartmentChatScreen uses `deptGroupByChannel[channelId] !== gid`
            // as the trigger for its history remap, and deliberately records the
            // new mapping only AFTER migrating so an interruption retries.
            // Writing the new id here satisfied that guard without migrating, so
            // the member's thread history stayed orphaned under the old id
            // permanently — the exact "thread looks wiped" symptom B-206 exists
            // to fix. Rewriting state without enumerating its consumers, which
            // is the failure CLAUDE.md change-safety rule 8 is about.
            //
            // The registry has no such consumer: it is a pure additive set of
            // conversations ever known to be departmental, so recording the old
            // AND the new id is correct — a company file filed under either must
            // still be refused.
            const store = useMessengerStore.getState();
            for (const ch of list) {
              if (ch.group_conversation_id) {
                // vs2 edge A9 — carry the org here too. Leaving the boot-time
                // registry arm as the ONLY populator is what makes a tap that
                // beats it (offline, cold boot, a 403 on the dept API) fall
                // back to the sticky org.
                store.rememberDeptConversation(ch.group_conversation_id, ch.org_id);
              }
            }
            setChannels(list);
          }
        } catch {
          // FAIL CLOSED. If membership cannot be confirmed we show nothing —
          // serving the previous list here would keep a removed member's files
          // visible for exactly as long as that state survived.
          if (alive) {setChannels([]);}
        }
      })();
      return () => { alive = false; };
    }, [isOrgAffiliated]),
  );

  return channels;
}

/**
 * Every company file the caller may open, newest first.
 *
 * MEMOISED on the three inputs. `listCompanyFiles` walks every message of every
 * member channel and allocates a fresh array, so running it on each render put
 * back exactly the cost `FilesScreen` documents removing in its Round-6 perf
 * note — this subscribes to the whole `s.messages` map, whose identity flips on
 * any append in any conversation.
 */
export function useCompanyShelf(): CompanyFile[] {
  const channels = useCompanyChannels();
  const deptGroupByChannel = useMessengerStore(s => s.deptGroupByChannel);
  const messages = useMessengerStore(s => s.messages);
  return useMemo(
    () => listCompanyFiles({channels, deptGroupByChannel, messages}),
    [channels, deptGroupByChannel, messages],
  );
}

/**
 * The conversation ids that count as COMPANY, for surfaces that already have
 * their own row builder and only need to know what to keep.
 *
 * Exists so `FilesScreen` — which is the Vault tab's landing route inside the
 * departmental shell (`DepartmentalNavigator`), and which otherwise lists media
 * from EVERY conversation on the device including DMs — can scope itself from
 * the same membership answer rather than re-deriving one.
 */
export function useCompanyConversationIds(): ReadonlySet<string> {
  const channels = useCompanyChannels();
  const deptGroupByChannel = useMessengerStore(s => s.deptGroupByChannel);
  return useMemo(() => {
    const ids = new Set<string>();
    for (const ch of channels) {
      const convoId = ch.group_conversation_id ?? deptGroupByChannel?.[ch.id];
      if (convoId) {ids.add(convoId);}
    }
    return ids;
  }, [channels, deptGroupByChannel]);
}

/**
 * Record every department conversation the server knows about, so
 * `moveBytesToVault` can refuse a company file.
 *
 * Extracted so it is testable BEHAVIOURALLY rather than by scanning
 * MainNavigator's text: a scan asserting the tokens survives inverting the
 * guard (`if (!ch.group_conversation_id)`), which records nothing.
 *
 * Called once per owner at messenger boot — the only point all three shells and
 * a cold notification deep-link share. Best-effort by contract: a dept-API 403
 * is the expected answer for every non-org account and must never surface.
 */
export async function armDeptConversationRegistry(): Promise<number> {
  try {
    // Phase B — DELIBERATELY UNSCOPED: the vault-refusal registry must know
    // every workspace's dept conversations (same class as the messenger-list
    // filters), or workspace B's company files become vaultable.
    const {data} = await departmentApi.listChannels();
    const store = useMessengerStore.getState();
    let armed = 0;
    for (const ch of data.channels ?? []) {
      if (ch.group_conversation_id) {
        // vs2 edge A9 — the org travels with it. THIS call is unscoped by
        // design (see above), so `org_id` here is the only place the client
        // ever learns which workspace a dept conversation belongs to — a
        // dept-message push carries no org at all.
        store.rememberDeptConversation(ch.group_conversation_id, ch.org_id);
        armed += 1;
      }
    }
    return armed;
  } catch {
    // Not a dept member, or offline. The registry is persisted and additive, so
    // leaving it as-is is correct — never clear it here.
    return 0;
  }
}
