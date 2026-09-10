/**
 * TimeDropdownField — the compact 12-hour time field both booking dashboards use.
 *
 * B-646 r3 — the hand-rolled `WheelTimePicker` is gone; this field now opens the
 * PLATFORM picker. The wheel cost three separate device bugs (the centre rail
 * swallowed drags on Android, `disableIntervalMomentum` threw the fling velocity
 * away so flicks did nothing, and an unmemoised prop made the column re-scroll
 * itself on every render), so the founder called it: use the OS picker everywhere.
 *
 * What still has to hold, and is pinned here:
 *   - the closed field reads 12-hour ("6:25 PM"), never 24-hour;
 *   - `onChange` still hands the caller a 0-23 hour, so no draft shape moved;
 *   - the minute step is enforced by the FIELD, because the Android clock dialog
 *     has no minute interval of its own;
 *   - Android opens the dialog imperatively and NEVER mounts a picker component.
 */
import React from 'react';
import {Platform} from 'react-native';
import {render, fireEvent} from '@testing-library/react-native';

import TimeDropdownField, {snapToStep} from '../TimeDropdownField';

const mockOpenTime = jest.fn();
jest.mock('../androidPicker', () => ({
  openAndroidTimePicker: (req: unknown) => mockOpenTime(req),
  openAndroidDatePicker: jest.fn(),
}));

type PickReq = {value: Date; is24Hour?: boolean; onPicked: (d: Date) => void};
const lastReq = (): PickReq => mockOpenTime.mock.calls.at(-1)![0] as PickReq;
const at = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};

const realOS = Platform.OS;
afterEach(() => {
  (Platform as {OS: string}).OS = realOS;
  mockOpenTime.mockClear();
});

describe('snapToStep — the minute rule the native clock cannot enforce', () => {
  it('rounds to the nearest step', () => {
    expect(snapToStep(18, 23, 5)).toEqual({hour: 18, minute: 25});
    expect(snapToStep(18, 22, 5)).toEqual({hour: 18, minute: 20});
  });

  it('carries into the next hour instead of producing minute 60', () => {
    // The whole reason this rounds TOTAL minutes rather than the minute field.
    expect(snapToStep(11, 58, 5)).toEqual({hour: 12, minute: 0});
  });

  it('wraps midnight instead of overflowing into hour 24', () => {
    expect(snapToStep(23, 59, 5)).toEqual({hour: 0, minute: 0});
  });

  it('is a no-op for a step of 1 or an unusable step', () => {
    expect(snapToStep(9, 37, 1)).toEqual({hour: 9, minute: 37});
    expect(snapToStep(9, 37, NaN)).toEqual({hour: 9, minute: 37});
  });
});

describe('TimeDropdownField — a 12-hour field over a 24-hour value', () => {
  it('labels the closed field in 12-hour form', () => {
    const u = render(<TimeDropdownField hour={18} minute={25} onChange={jest.fn()} testID="t" />);
    expect(u.getByText('6:25 PM')).toBeTruthy();
    expect(u.queryByText('18:25')).toBeNull();
  });

  it('accepts a display override (the Exec "Same as start time" label)', () => {
    const u = render(
      <TimeDropdownField
        hour={9} minute={0} onChange={jest.fn()}
        displayText="Same as start time (9:00 AM)" testID="t"
      />,
    );
    expect(u.getByText('Same as start time (9:00 AM)')).toBeTruthy();
  });
});

describe('TimeDropdownField on Android — the native clock dialog', () => {
  beforeEach(() => { (Platform as {OS: string}).OS = 'android'; });

  it('opens the dialog imperatively, seeded with the current value, in 12-hour mode', () => {
    const u = render(<TimeDropdownField hour={18} minute={25} onChange={jest.fn()} testID="t" />);
    fireEvent.press(u.getByTestId('t'));

    expect(mockOpenTime).toHaveBeenCalledTimes(1);
    const req = lastReq();
    expect(req.value.getHours()).toBe(18);
    expect(req.value.getMinutes()).toBe(25);
    // B-615's 12-hour rule, now served by the OS clock's own AM/PM face.
    expect(req.is24Hour).toBe(false);
  });

  it('hands the caller a 24-HOUR hour, snapped to the step', () => {
    const onChange = jest.fn();
    const u = render(<TimeDropdownField hour={9} minute={0} onChange={onChange} testID="t" />);
    fireEvent.press(u.getByTestId('t'));
    // The user picks 7:23 PM on the native clock.
    lastReq().onPicked(at(19, 23));
    expect(onChange).toHaveBeenCalledWith(19, 25);
  });

  it('respects a caller-supplied step', () => {
    const onChange = jest.fn();
    const u = render(
      <TimeDropdownField hour={9} minute={0} onChange={onChange} minuteStep={15} testID="t" />,
    );
    fireEvent.press(u.getByTestId('t'));
    lastReq().onPicked(at(14, 8));
    expect(onChange).toHaveBeenCalledWith(14, 15);
  });

  it('mounts NO picker component and no sheet — the dialog is the whole UI', () => {
    const u = render(<TimeDropdownField hour={18} minute={25} onChange={jest.fn()} testID="t" />);
    fireEvent.press(u.getByTestId('t'));
    // The iOS sheet must not exist on Android; a mounted Android picker is the
    // B-643 trap (it re-opens on every render).
    expect(u.queryByTestId('t-backdrop')).toBeNull();
    expect(u.queryByText('Done')).toBeNull();
  });

  it('does not fire onChange until the user actually picks', () => {
    const onChange = jest.fn();
    const u = render(<TimeDropdownField hour={9} minute={0} onChange={onChange} testID="t" />);
    fireEvent.press(u.getByTestId('t'));
    // A dismissed dialog never reaches onPicked — androidPicker filters on 'set'.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('TimeDropdownField on iOS — the native spinner in a sheet', () => {
  beforeEach(() => { (Platform as {OS: string}).OS = 'ios'; });

  it('opens a sheet and never calls the Android door', () => {
    const u = render(<TimeDropdownField hour={18} minute={25} onChange={jest.fn()} testID="t" />);
    fireEvent.press(u.getByTestId('t'));
    expect(mockOpenTime).not.toHaveBeenCalled();
    expect(u.getByText('Done')).toBeTruthy();
  });

  it('commits on Done, snapped, as a 24-hour hour', () => {
    const onChange = jest.fn();
    const u = render(<TimeDropdownField hour={18} minute={25} onChange={onChange} testID="t" />);
    fireEvent.press(u.getByTestId('t'));
    fireEvent.press(u.getByTestId('t-done'));
    expect(onChange).toHaveBeenCalledWith(18, 25);
  });

  it('dismissing the sheet discards the pick', () => {
    const onChange = jest.fn();
    const u = render(<TimeDropdownField hour={18} minute={25} onChange={onChange} testID="t" />);
    fireEvent.press(u.getByTestId('t'));
    fireEvent.press(u.getByTestId('t-backdrop'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
