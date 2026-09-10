import React from 'react';
import {render, fireEvent, act} from '@testing-library/react-native';
import {BravoAlertHost} from '../BravoAlertHost';
import {Alert, _resetAlertsForTest} from '@utils/alert';

beforeEach(() => act(() => _resetAlertsForTest()));

describe('BravoAlertHost — branded dialog rendering', () => {
  it('renders nothing until an alert is issued', () => {
    const {queryByText} = render(<BravoAlertHost />);
    expect(queryByText('OK')).toBeNull();
  });

  it('renders title, message and the default OK button', () => {
    const {getByText} = render(<BravoAlertHost />);
    act(() => Alert.alert('Session expired', 'Please sign in again.'));
    expect(getByText('Session expired')).toBeTruthy();
    expect(getByText('Please sign in again.')).toBeTruthy();
    expect(getByText('OK')).toBeTruthy();
  });

  it('button press fires onPress and closes the dialog', () => {
    const onPress = jest.fn();
    const {getByText, queryByText} = render(<BravoAlertHost />);
    act(() => Alert.alert('Delete file?', 'This cannot be undone.', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Delete', style: 'destructive', onPress},
    ]));
    fireEvent.press(getByText('Delete'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(queryByText('Delete file?')).toBeNull();
  });

  it('shows the next queued alert after the first is closed', () => {
    const {getByText} = render(<BravoAlertHost />);
    act(() => {
      Alert.alert('First');
      Alert.alert('Second');
    });
    fireEvent.press(getByText('OK'));
    expect(getByText('Second')).toBeTruthy();
  });
});
