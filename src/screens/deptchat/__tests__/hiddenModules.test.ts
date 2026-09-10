/**
 * Channels vs2 item 17b — the ONE rule four surfaces consume.
 *
 * The rule is small; what matters is which direction it fails in. Every unknown
 * has to resolve to VISIBLE, because the alternative is a fetch blip emptying a
 * workspace's home screen — and a user cannot tell that apart from the feature
 * having been switched off for them.
 */
import {moduleVisible, hiddenModulesFor, moduleRowSubtitle} from '../hiddenModules';

describe('moduleVisible fails OPEN on every unknown', () => {
  it.each([
    ['not loaded yet', null],
    ['the request failed', undefined],
  ])('%s → visible', (_label, settings) => {
    expect(moduleVisible(settings as never, 'attendance')).toBe(true);
    expect(moduleVisible(settings as never, 'incidents')).toBe(true);
  });

  it('an empty hidden set shows everything', () => {
    const s = {orgUserId: 'o1', hiddenModules: []};
    expect(moduleVisible(s, 'attendance')).toBe(true);
    expect(moduleVisible(s, 'incidents')).toBe(true);
  });

  it('hides exactly what is listed, and nothing else', () => {
    const s = {orgUserId: 'o1', hiddenModules: ['attendance']};
    expect(moduleVisible(s, 'attendance')).toBe(false);
    expect(moduleVisible(s, 'incidents')).toBe(true);
  });

  it('a value nobody recognises does not hide anything', () => {
    // A newer server naming a module this build has never heard of must not
    // make an existing card vanish.
    const s = {orgUserId: 'o1', hiddenModules: ['telepathy']};
    expect(moduleVisible(s, 'attendance')).toBe(true);
    expect(moduleVisible(s, 'incidents')).toBe(true);
  });
});

describe('hiddenModulesFor keys on the org the RESPONSE names', () => {
  const S = {orgUserId: 'orgA', hiddenModules: ['attendance']};

  it('applies them when the viewed org matches', () => {
    expect(hiddenModulesFor(S, 'orgA')).toBe(S);
  });

  it('REFUSES them for a different org — settings must not cross workspaces', () => {
    /**
     * The hub can put the user in workspace B while a response for A is still
     * in state. Applying A's hiding to B would remove cards B never hid.
     */
    expect(hiddenModulesFor(S, 'orgB')).toBeNull();
    expect(moduleVisible(hiddenModulesFor(S, 'orgB'), 'attendance')).toBe(true);
  });

  it('applies them when there is NO org context — the majority path', () => {
    // `activeWorkspaceOrgParam()` is undefined before a hub selection (drawer,
    // CPO shell, every notification tap). Refusing here would make the feature
    // dead for most users; the response is for whatever org the SERVER
    // resolved for this caller, which is the one they are in.
    expect(hiddenModulesFor(S, undefined)).toBe(S);
    expect(hiddenModulesFor(S, null)).toBe(S);
  });
});

describe('the combined row narrows its copy rather than over-promising', () => {
  it('names both when both are shown', () => {
    expect(moduleRowSubtitle(true, true, true)).toMatch(/incident queue/);
    expect(moduleRowSubtitle(false, true, true)).toMatch(/report incidents/i);
  });

  it('never mentions incidents when incidents are hidden', () => {
    expect(moduleRowSubtitle(true, true, false)).not.toMatch(/incident/i);
    expect(moduleRowSubtitle(false, true, false)).not.toMatch(/incident/i);
  });

  it('never mentions attendance or check-in when attendance is hidden', () => {
    expect(moduleRowSubtitle(true, false, true)).not.toMatch(/shift|check.?in|attendance/i);
    expect(moduleRowSubtitle(false, false, true)).not.toMatch(/shift|check.?in|attendance/i);
  });
});
