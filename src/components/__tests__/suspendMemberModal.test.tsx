import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import {SuspendMemberModal} from '../SuspendMemberModal';

// The native date picker has no place in a unit test — the dialog's contract is
// the payload it emits, not the OS spinner.
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

const DAY_MS = 86_400_000;

function setup(overrides: Partial<React.ComponentProps<typeof SuspendMemberModal>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <SuspendMemberModal
      visible
      memberName="Roger"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return {...utils, onConfirm, onCancel};
}

describe('SuspendMemberModal', () => {
  it('names the member and warns what suspension costs them', () => {
    const {getByText} = setup();
    expect(getByText('Suspend Roger?')).toBeTruthy();
    expect(getByText(/signed out and lose access to agency chat/i)).toBeTruthy();
  });

  // D2 — the reason is mandatory; the server rejects an empty one, so the
  // dialog must not let it be sent in the first place.
  it('refuses to submit without a reason', () => {
    const {getByText, onConfirm} = setup();
    fireEvent.press(getByText('Suspend'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('submits once a reason is typed', () => {
    const {getByText, getByLabelText, onConfirm} = setup();
    fireEvent.changeText(getByLabelText('Suspension reason'), 'Kit not returned');
    fireEvent.press(getByText('Suspend'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const p = onConfirm.mock.calls[0][0];
    expect(p.suspend_reason).toBe('Kit not returned');
    expect(p.suspended_until).not.toBeNull();
  });

  it('a whitespace-only reason still counts as empty', () => {
    const {getByText, getByLabelText, onConfirm} = setup();
    fireEvent.changeText(getByLabelText('Suspension reason'), '    ');
    fireEvent.press(getByText('Suspend'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a quick-pick sets the window that many days out', () => {
    const {getByText, getByLabelText, onConfirm} = setup();
    fireEvent.press(getByText('30 days'));
    fireEvent.changeText(getByLabelText('Suspension reason'), 'Investigation');
    fireEvent.press(getByText('Suspend'));

    const p = onConfirm.mock.calls[0][0];
    const span = new Date(p.suspended_until).getTime() - new Date(p.suspended_from).getTime();
    expect(Math.round(span / DAY_MS)).toBe(30);
  });

  it('Indefinite clears the end date', () => {
    const {getByText, getByLabelText, onConfirm} = setup();
    fireEvent.press(getByText('Indefinite'));
    fireEvent.changeText(getByLabelText('Suspension reason'), 'Pending review');
    fireEvent.press(getByText('Suspend'));

    expect(onConfirm.mock.calls[0][0].suspended_until).toBeNull();
    expect(getByText('Indefinite — until you lift it')).toBeTruthy();
  });

  it('Cancel closes without suspending', () => {
    const {getByText, onCancel, onConfirm} = setup();
    fireEvent.press(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not double-submit while a suspension is in flight', () => {
    const {getByLabelText, onConfirm} = setup({busy: true});
    fireEvent.changeText(getByLabelText('Suspension reason'), 'Kit not returned');
    // While busy the visible label is a spinner, so target the stable a11y name.
    fireEvent.press(getByLabelText('Suspend'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
