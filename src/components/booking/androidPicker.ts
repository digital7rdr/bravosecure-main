/**
 * Booking · the Android native date / time picker door.
 *
 * Why this is NOT a declarative <DateTimePicker> on Android: that component is a
 * native dialog FRAGMENT, and the library re-invokes `open()` from an effect keyed
 * on the `onChange` identity (datetimepicker/src/datetimepicker.android.js, deps
 * `[onChange, valueTimestamp, mode]`). An inline arrow handler is a new identity on
 * every render, so every re-render while the dialog is up calls `open()` again — and
 * the native module answers a second `open()` with `oldFragment.update(args);
 * return;` (DatePickerModule.java), which snaps the dialog back to `value` and never
 * settles the new promise. On a booking screen that re-renders on its own (the
 * debounced price estimate) that reverts the day the user just tapped; and a fragment
 * left behind by an activity restore carries no listeners, so the field goes
 * permanently dead — tapping it opens nothing, for good. Opening imperatively from
 * the press gesture removes the coupling: exactly one `open()` per real gesture.
 *
 * Why 'set' is checked here rather than at each call site: the library's DISMISS path
 * calls back with `originalValue` — a DEFINED date — so a handler that only checks
 * the date argument treats Cancel as a pick, and then chains on into the next sheet.
 */
import {DateTimePickerAndroid, type DateTimePickerEvent} from '@react-native-community/datetimepicker';

export interface AndroidPickerRequest {
  value: Date;
  /** Date mode only — the Android time dialog ignores a floor. */
  minimumDate?: Date;
  is24Hour?: boolean;
  onPicked: (d: Date) => void;
}

function openAndroidPicker(mode: 'date' | 'time', req: AndroidPickerRequest): void {
  DateTimePickerAndroid.open({
    value: req.value,
    mode,
    display: 'default',
    ...(req.minimumDate ? {minimumDate: req.minimumDate} : {}),
    ...(req.is24Hour === undefined ? {} : {is24Hour: req.is24Hour}),
    onChange: (ev: DateTimePickerEvent, d?: Date) => {
      if (ev?.type !== 'set' || !d) {return;}
      req.onPicked(d);
    },
  });
}

export const openAndroidDatePicker = (req: AndroidPickerRequest): void => openAndroidPicker('date', req);
export const openAndroidTimePicker = (req: AndroidPickerRequest): void => openAndroidPicker('time', req);
