/**
 * iOS-style scroll-wheel time picker (hour + minute columns, plus an AM/PM
 * column in 12-hour mode).
 *
 * Each column is a vertical `ScrollView` that snaps to ITEM_HEIGHT.
 * A ScrollView (not FlatList) deliberately sidesteps RN's "nested
 * VirtualizedLists on same axis" warning when the host screen wraps
 * this widget in its own ScrollView; the data sets (24 hours / 12
 * minute steps) are small enough that full render isn't an issue.
 *
 * `hour` in and out is ALWAYS 0-23 whichever cycle is shown — `hourCycle: 12`
 * only changes the columns (1-12 + AM/PM); the caller's stored shape is untouched.
 */
import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {to12h, to24h} from './time12h';

// Obsidian/cobalt palette (Bravo "Schedule" design handoff) — mirrors
// BookingDateTimeScreen so the wheel reads as part of the same card.
const D = {
  text:      '#F2F4F8',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair2:     'rgba(255,255,255,0.09)',
  fSemi:     'Manrope_600SemiBold',
  fBold:     'Manrope_700Bold',
  fMono:     'monospace',
};

const ITEM_HEIGHT = 42;
const VISIBLE_ROWS = 5;                        // odd so centre row is unambiguous
const PICKER_HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;
const PAD_ROWS = (VISIBLE_ROWS - 1) / 2;

const pad = (n: number) => n.toString().padStart(2, '0');

interface ColumnProps {
  values: number[];
  selected: number;
  onChange: (v: number) => void;
  /** Row label (defaults to zero-padded). */
  format?: (v: number) => string;
}

function Column({values, selected, onChange, format = pad}: ColumnProps) {
  const ref = useRef<ScrollView>(null);
  const hasInit = useRef(false);
  /** Row this column has already been scrolled to — see the effect below. */
  const appliedIdx = useRef(-1);
  /** True while the wheel is under the user's control: touch AND momentum. */
  const busy = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const idx = values.indexOf(selected);

  // B-646 — this effect drives an IMPERATIVE scrollTo, so it must fire only when
  // the target row genuinely moves. It used to depend on `values`, which the
  // parent rebuilt with Array.from() on every render, so it re-ran every time and
  // re-issued `scrollTo({animated: true})` on all three columns. An animated
  // scrollTo emits its own scroll events and fires onMomentumScrollEnd when it
  // settles, which called onChange, which re-rendered, which scrolled again — the
  // wheel fought the finger and read as frozen. Two guards close it:
  //   - key on the row INDEX (a number), never the array identity;
  //   - never scroll while the wheel is under the user's control, and remember
  //     where it already is, so the same offset is never re-issued.
  useEffect(() => {
    if (!ref.current || idx < 0) {return;}
    if (busy.current || appliedIdx.current === idx) {return;}
    appliedIdx.current = idx;
    ref.current.scrollTo({y: idx * ITEM_HEIGHT, animated: hasInit.current});
    hasInit.current = true;
  }, [idx]);

  useEffect(() => () => { if (settle.current) {clearTimeout(settle.current);} }, []);

  const releaseSoon = useCallback(() => {
    // B-646 r2 — the guard must span the MOMENTUM phase, not just the touch.
    // onScrollEndDrag fires the instant the finger lifts, but the wheel keeps
    // gliding until onMomentumScrollEnd; releasing at drag-end left a window
    // where a re-render found busy=false with appliedIdx still on the OLD row
    // and scrolled the wheel back mid-glide. Momentum-end clears this timer;
    // the timer exists because RN emits no momentum-end on a slow release.
    if (settle.current) {clearTimeout(settle.current);}
    settle.current = setTimeout(() => { busy.current = false; settle.current = null; }, 160);
  }, []);

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (settle.current) {clearTimeout(settle.current); settle.current = null;}
      busy.current = false;
      const offset = e.nativeEvent.contentOffset.y;
      const landed = Math.round(offset / ITEM_HEIGHT);
      const clamped = Math.max(0, Math.min(values.length - 1, landed));
      // The wheel is physically here now; recording it stops the effect from
      // animating it back to the same place on the resulting re-render.
      appliedIdx.current = clamped;
      const next = values[clamped];
      if (next !== selected) {onChange(next);}
    },
    [values, selected, onChange],
  );

  const onDragStart = useCallback(() => {
    if (settle.current) {clearTimeout(settle.current); settle.current = null;}
    busy.current = true;
  }, []);
  const onDragEnd = releaseSoon;

  return (
    <View style={s.col}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        // B-646 r2 — `disableIntervalMomentum` is DELIBERATELY absent. It makes the
        // list "stop on the next index in relation to scroll position AT RELEASE,
        // regardless of how fast the gesture is" — i.e. it throws the fling velocity
        // away. On a picker that means a normal flick, which barely moves the content
        // before the finger leaves, snaps straight back to the row it started on and
        // the wheel reads as dead. Velocity + snapToInterval is the iOS-picker feel.
        onMomentumScrollEnd={onMomentumEnd}
        onScrollBeginDrag={onDragStart}
        onScrollEndDrag={onDragEnd}
        nestedScrollEnabled
        contentContainerStyle={{paddingVertical: PAD_ROWS * ITEM_HEIGHT}}
        overScrollMode="never"
        bounces={false}>
        {values.map(v => {
          const isCentre = v === selected;
          return (
            <View key={v} style={s.item}>
              <Text style={[s.itemText, isCentre && s.itemTextSel]}>{format(v)}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

interface Props {
  /** 0-23, whichever cycle is displayed. */
  hour: number;
  minute: number;
  /** Always receives a 0-23 hour. */
  onChange: (hour: number, minute: number) => void;
  /** Minute step (defaults to 5). */
  minuteStep?: number;
  /** 24 (default) = a 0-23 hour column; 12 = a 1-12 hour column plus AM/PM. */
  hourCycle?: 12 | 24;
}

const PERIODS = [0, 1];
const periodLabel = (v: number) => (v === 1 ? 'PM' : 'AM');
const plain = (v: number) => String(v);

export default function WheelTimePicker({hour, minute, onChange, minuteStep = 5, hourCycle = 24}: Props) {
  const is12 = hourCycle === 12;
  // Stable identities: these feed Column's scroll effect, and a fresh array per
  // render is what made it re-scroll every time (B-646).
  const hours = useMemo(
    () => (is12
      ? Array.from({length: 12}, (_, i) => i + 1)
      : Array.from({length: 24}, (_, i) => i)),
    [is12],
  );
  const minutes = useMemo(
    () => Array.from({length: Math.floor(60 / minuteStep)}, (_, i) => i * minuteStep),
    [minuteStep],
  );

  const snappedMinute = minutes.reduce(
    (best, v) => (Math.abs(v - minute) < Math.abs(best - minute) ? v : best),
    minutes[0],
  );

  const {hour12, pm} = to12h(hour);

  return (
    <View style={s.wrap}>
      <View pointerEvents="none" style={s.topLight} />
      <View pointerEvents="none" style={s.rail} />
      <View style={s.cols}>
        <Column
          values={hours}
          selected={is12 ? hour12 : hour}
          format={is12 ? plain : pad}
          onChange={v => onChange(is12 ? to24h(v, pm) : v, snappedMinute)}
        />
        <View pointerEvents="none" style={s.colDivider} />
        <Column
          values={minutes}
          selected={snappedMinute}
          onChange={v => onChange(hour, v)}
        />
        {is12 && (
          <>
            <View pointerEvents="none" style={s.colDivider} />
            <Column
              values={PERIODS}
              selected={pm ? 1 : 0}
              format={periodLabel}
              onChange={v => onChange(to24h(hour12, v === 1), snappedMinute)}
            />
          </>
        )}
      </View>
      <View style={s.labels}>
        <Text style={s.label}>HOUR</Text>
        <Text style={s.label}>MIN</Text>
        {is12 && <Text style={s.label}>AM/PM</Text>}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    borderRadius: 20, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(16,22,34,0.85)',
    borderWidth: 1, borderColor: D.hair2,
  },
  topLight: {
    position: 'absolute', top: 0, left: 22, right: 22, height: 1,
    backgroundColor: 'rgba(120,160,255,0.25)',
  },
  rail: {
    position: 'absolute', left: 16, right: 16,
    top: 16 + PAD_ROWS * ITEM_HEIGHT, height: ITEM_HEIGHT,
    borderRadius: 13, borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    backgroundColor: 'rgba(91,141,239,0.10)',
    // B-646 r2 — NO zIndex. On Android a z-indexed sibling is lifted above the
    // columns for HIT-TESTING as well as painting, and `pointerEvents="none"` did
    // not save it: the band sits exactly over the centre row, which is precisely
    // where a thumb lands, so every drag that began on the selected value was
    // swallowed and the wheel felt locked. Measured on a Pixel 6a: four drags
    // starting inside the band (y 1756-1866) moved nothing; an identical drag
    // starting below it scrolled normally. Declared BEFORE <cols>, so without
    // zIndex it paints behind the numbers — which is the look we want anyway.
  },
  cols: {flexDirection: 'row', height: PICKER_HEIGHT},
  colDivider: {width: 1, marginVertical: 8, backgroundColor: D.hair2},
  col: {flex: 1, overflow: 'hidden'},
  item: {height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center'},
  itemText: {
    fontFamily: D.fMono, fontSize: 18,
    color: D.textMute, letterSpacing: 0,
  },
  itemTextSel: {
    fontFamily: D.fBold, fontSize: 30,
    color: D.text, letterSpacing: -0.5,
  },
  labels: {
    flexDirection: 'row', marginTop: 6,
  },
  label: {
    flex: 1, textAlign: 'center',
    fontFamily: D.fMono, fontSize: 9,
    color: D.textFaint, letterSpacing: 2,
  },
});
