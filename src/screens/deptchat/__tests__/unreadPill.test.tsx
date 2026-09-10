/**
 * The unread badge, pinned as a COMPONENT rather than as text.
 *
 * Three copies of this badge had drifted apart, and the divergence was
 * invisible to every existing test because they all asserted the NUMBER. The
 * organisation drill-in row reused a StyleSheet entry that carries no
 * `backgroundColor` — the gradient wrapper was supplying it — on a plain
 * `View`, so it rendered a bare white numeral with no fill and no shadow, right
 * next to a filled pill in the same list.
 *
 * So the assertion here is the FILL, not the digits.
 */
import React from 'react';
import {render} from '@testing-library/react-native';

jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));

import {UnreadPill} from '../UnreadPill';

describe('UnreadPill', () => {
  it('has a real fill — it is a gradient, not a transparent View', () => {
    const tree = render(<UnreadPill count={3} />).toJSON();
    expect(tree).toBeTruthy();
    expect(tree.type).toBe('LinearGradient');
    expect(tree.props.colors).toHaveLength(2);
  });

  it('renders nothing at zero, so callers need no `&&` of their own', () => {
    expect(render(<UnreadPill count={0} />).toJSON()).toBeNull();
    expect(render(<UnreadPill count={-1} />).toJSON()).toBeNull();
  });

  it('clamps at 99+ — four digits would push the row name off a 320dp screen', () => {
    expect(render(<UnreadPill count={100} />).getByText('99+')).toBeTruthy();
    expect(render(<UnreadPill count={99} />).getByText('99')).toBeTruthy();
  });
});
