/**
 * Client 2026-08-22 — the workspace drill-down in the news share sheet, tested
 * by RENDERING it.
 *
 * WHY THIS FILE EXISTS. The sheet itself (`ShareNewsSheet`) imports ChatScreen,
 * the messenger runtime and the API layer, so no test in this repo can mount it,
 * and its invariants are pinned by source scan. A scan proves a handler is
 * WIRED; it cannot prove it DOES anything. A review of the first cut made the
 * point concretely: changing `onOpenGroup(g.id)` to a no-op killed the entire
 * feature and every assertion stayed green — the same "shipped pinned by
 * nothing" shape as the `accessible={false}` channel-tree headline.
 *
 * So the two levels live in `ShareChannelPicker.tsx`, which imports only React
 * Native, and the behaviour is asserted here against real output.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import {
  ShareWorkspaceList, ShareChannelList, resolveOpenGroup, BLOCKED_LABEL,
} from '../ShareChannelPicker';
import type {ShareWorkspaceGroup, ShareChannelTarget} from '../shareChannelTargets';

const target = (over: Partial<ShareChannelTarget> & {name: string}): ShareChannelTarget => ({
  channelId: `c-${over.name}`,
  groupConversationId: `g-${over.name}`,
  postable: true,
  blockedReason: null,
  depth: 0,
  ...over,
});

const group = (name: string, channels: ShareChannelTarget[]): ShareWorkspaceGroup => ({
  id: `w-${name}`,
  name,
  channels,
  postableCount: channels.filter(c => c.postable).length,
});

const ADVISORS = group('Bravo Advisors', [
  target({name: 'Operations'}),
  target({name: 'Announcements', postable: false, blockedReason: 'read_only'}),
  target({name: 'Brand New', postable: false, blockedReason: 'not_active', groupConversationId: null}),
]);
const UAE = group('Bravo UAE', [target({name: 'Dispatch'})]);

describe('the workspace list (level 1)', () => {
  it('shows the workspace NAME — the client asked for the name, not an id', () => {
    const u = render(
      <ShareWorkspaceList groups={[ADVISORS, UAE]} loading={false} onOpenGroup={jest.fn()} />,
    );
    expect(u.getByText('Bravo Advisors')).toBeTruthy();
    expect(u.getByText('Bravo UAE')).toBeTruthy();
    expect(u.getByText('WORKSPACES')).toBeTruthy();
  });

  it('DRILLS IN on press, reporting the workspace that was tapped', () => {
    // THE FEATURE. A no-op handler here leaves every source scan green.
    const onOpenGroup = jest.fn();
    const u = render(
      <ShareWorkspaceList groups={[ADVISORS, UAE]} loading={false} onOpenGroup={onOpenGroup} />,
    );
    fireEvent.press(u.getByLabelText('Bravo UAE, 1 channels'));
    expect(onOpenGroup).toHaveBeenCalledWith('w-Bravo UAE');
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
  });

  it('renders NOTHING when there are no workspaces and nothing is loading', () => {
    // A member with no workspace must not see an empty "WORKSPACES" header.
    const u = render(<ShareWorkspaceList groups={[]} loading={false} onOpenGroup={jest.fn()} />);
    expect(u.queryByText('WORKSPACES')).toBeNull();
  });

  it('shows the loading row while the channel list is still in flight', () => {
    const u = render(<ShareWorkspaceList groups={[]} loading onOpenGroup={jest.fn()} />);
    expect(u.getByText('Loading workspaces…')).toBeTruthy();
  });
});

describe('the channel list (level 2)', () => {
  it('lists every channel of that workspace, including the ones that are blocked', () => {
    // Hiding a blocked channel would read as "my channel is missing"; showing it
    // with a reason is the honest form.
    const u = render(<ShareChannelList group={ADVISORS} onPickChannel={jest.fn()} />);
    for (const n of ['Operations', 'Announcements', 'Brand New']) {
      expect(u.getByText(n)).toBeTruthy();
    }
  });

  it('SHARES on press of a postable channel', () => {
    const onPickChannel = jest.fn();
    const u = render(<ShareChannelList group={ADVISORS} onPickChannel={onPickChannel} />);
    fireEvent.press(u.getByLabelText('Share to Operations'));
    expect(onPickChannel).toHaveBeenCalledWith(expect.objectContaining({name: 'Operations', postable: true}));
  });

  it('a READ-ONLY channel cannot be pressed, and says why', () => {
    // The gate is at the write (allowShareToChannel); this is the affordance
    // matching it, which A4 requires as well as — never instead of — the gate.
    const onPickChannel = jest.fn();
    const u = render(<ShareChannelList group={ADVISORS} onPickChannel={onPickChannel} />);
    const row = u.getByLabelText(`Announcements, ${BLOCKED_LABEL.read_only}`);
    fireEvent.press(row);
    expect(onPickChannel).not.toHaveBeenCalled();
    expect(u.getByText(BLOCKED_LABEL.read_only)).toBeTruthy();
  });

  it('a channel with no group yet cannot be pressed, and says THAT instead', () => {
    const onPickChannel = jest.fn();
    const u = render(<ShareChannelList group={ADVISORS} onPickChannel={onPickChannel} />);
    fireEvent.press(u.getByLabelText(`Brand New, ${BLOCKED_LABEL.not_active}`));
    expect(onPickChannel).not.toHaveBeenCalled();
    expect(u.getByText(BLOCKED_LABEL.not_active)).toBeTruthy();
  });

  it('marks blocked rows disabled for a screen reader, not merely faded', () => {
    const u = render(<ShareChannelList group={ADVISORS} onPickChannel={jest.fn()} />);
    expect(u.getByLabelText('Share to Operations').props.accessibilityState)
      .toMatchObject({disabled: false});
    expect(u.getByLabelText(`Announcements, ${BLOCKED_LABEL.read_only}`).props.accessibilityState)
      .toMatchObject({disabled: true});
  });

  it('scrolls nested — Android turns nested scrolling OFF by default', () => {
    // This list can sit under the sheet's own content; without the prop the
    // rows past the fold are unreachable on Android.
    const u = render(<ShareChannelList group={ADVISORS} onPickChannel={jest.fn()} />);
    expect(u.UNSAFE_getByType(require('react-native').ScrollView).props.nestedScrollEnabled).toBe(true);
  });
});

describe('resolveOpenGroup — a stale drill-in id can never show stale channels', () => {
  it('resolves the open workspace from the LIVE list', () => {
    expect(resolveOpenGroup([ADVISORS, UAE], 'w-Bravo UAE')).toBe(UAE);
  });

  it('falls back to the root view when the id is not in the list any more', () => {
    // The sheet refetches on every open; a workspace the user has left (or a
    // list that failed to load) must not render the previous session's channels
    // with the previous session's roles.
    expect(resolveOpenGroup([ADVISORS], 'w-Bravo UAE')).toBeNull();
    expect(resolveOpenGroup([], 'w-Bravo UAE')).toBeNull();
  });

  it('null id is the root view', () => {
    expect(resolveOpenGroup([ADVISORS], null)).toBeNull();
  });
});
