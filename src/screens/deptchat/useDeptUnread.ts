/**
 * useDeptUnreadTotal — live unread badge count for the CPO "Departmental" tab.
 *
 * The dept-chat channels are E2EE messenger groups; the per-conversation unread
 * tally lives in the messenger store. This hook fetches the CPO's dept channel
 * directory once (for the set of group_conversation_ids), then subscribes to the
 * messenger store and SUMs `unread_count` across those groups so the bottom-tab
 * badge tracks new posts in real time. Errors are tolerated as 0 (no badge).
 */
import {useEffect, useState} from 'react';
import {departmentApi} from '@services/api';
import {activeWorkspaceOrgParam, scopeChannelsToActiveWorkspace, useActiveWorkspace} from '@store/activeWorkspace';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';

export function useDeptUnreadTotal(): number {
  const [groupIds, setGroupIds] = useState<string[]>([]);

  // F17: the channel directory was fetched exactly once on mount, so a
  // channel whose group_conversation_id was null at fetch time (or that was
  // provisioned later in the session) never contributed to the badge until a
  // full remount. Re-fetch whenever the SET of group/ops_channel slots in the
  // store changes — that is precisely the moment a channel's conversation
  // first materialises — keyed by a stable signature so ordinary message
  // updates (which don't change the slot set) don't trigger refetches.
  const groupConvoSig = useMessengerStore(s =>
    Object.keys(s.conversations)
      .filter(id => {
        const t = s.conversations[id]?.type;
        return t === 'group' || t === 'ops_channel';
      })
      .sort()
      .join(','),
  );

  // Phase B — re-fetch when the hub switches workspaces, or the badge keeps
  // counting the PREVIOUS workspace's channels (edge review F2, latent).
  const activeOrgId = useActiveWorkspace(s => s.workspace?.org_id);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Phase B — the badge counts the hub-selected workspace only
        // (fail-open helpers: no context / old server = every channel).
        const {data} = await departmentApi.listChannels(activeWorkspaceOrgParam());
        const ids = scopeChannelsToActiveWorkspace(data.channels ?? [])
          .map(c => c.group_conversation_id)
          .filter((id): id is string => !!id);
        if (!cancelled) {setGroupIds(ids);}
      } catch {
        // Keep the prior id set on a transient error — clearing would blink
        // the badge to 0 on a single failed poll.
      }
    })();
    return () => {cancelled = true;};
  }, [groupConvoSig, activeOrgId]);

  return useMessengerStore(s =>
    groupIds.reduce((sum, gid) => sum + (s.conversations[gid]?.unread_count ?? 0), 0),
  );
}
