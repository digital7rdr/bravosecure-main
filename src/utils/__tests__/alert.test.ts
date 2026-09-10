import {
  Alert,
  confirmSwitchDashboard,
  currentAlert,
  dismissCurrentAlert,
  pressAlertButton,
  resolveAlertLayout,
  subscribeAlerts,
  _resetAlertsForTest,
} from '../alert';

beforeEach(() => _resetAlertsForTest());

describe('Alert.alert compat queue', () => {
  it('defaults to a single OK button (native behavior)', () => {
    Alert.alert('Title', 'Body');
    const cur = currentAlert()!;
    expect(cur.title).toBe('Title');
    expect(cur.message).toBe('Body');
    expect(cur.buttons).toEqual([{text: 'OK'}]);
  });

  it('queues FIFO while one is visible', () => {
    Alert.alert('First');
    Alert.alert('Second');
    expect(currentAlert()!.title).toBe('First');
    pressAlertButton(currentAlert()!.id, currentAlert()!.buttons[0]);
    expect(currentAlert()!.title).toBe('Second');
  });

  it('press advances the queue BEFORE running the handler (handler can re-alert)', () => {
    const order: string[] = [];
    Alert.alert('First', undefined, [{
      text: 'Go',
      onPress: () => {
        order.push(`during:${currentAlert()?.title ?? 'none'}`);
        Alert.alert('Chained');
      },
    }]);
    pressAlertButton(currentAlert()!.id, currentAlert()!.buttons[0]);
    expect(order).toEqual(['during:none']);
    expect(currentAlert()!.title).toBe('Chained');
  });

  it('a throwing handler still closes the dialog', () => {
    Alert.alert('Boom', undefined, [{text: 'X', onPress: () => { throw new Error('handler'); }}]);
    pressAlertButton(currentAlert()!.id, currentAlert()!.buttons[0]);
    expect(currentAlert()).toBeNull();
  });

  it('backdrop/back dismiss fires onDismiss and no button handler (RN Android semantics)', () => {
    const onPress = jest.fn();
    const onDismiss = jest.fn();
    Alert.alert('T', 'm', [{text: 'Cancel', style: 'cancel', onPress}], {onDismiss});
    dismissCurrentAlert();
    expect(currentAlert()).toBeNull();
    expect(onPress).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('cancelable: false blocks backdrop/back dismissal', () => {
    Alert.alert('Stay', 'm', [{text: 'OK'}], {cancelable: false});
    dismissCurrentAlert();
    expect(currentAlert()!.title).toBe('Stay');
  });

  it('stale press ids are ignored (double-tap race)', () => {
    Alert.alert('A');
    Alert.alert('B');
    const a = currentAlert()!;
    pressAlertButton(a.id, a.buttons[0]);
    pressAlertButton(a.id, a.buttons[0]);
    expect(currentAlert()!.title).toBe('B');
  });

  it('notifies subscribers on every transition', () => {
    const cb = jest.fn();
    const un = subscribeAlerts(cb);
    Alert.alert('X');
    dismissCurrentAlert();
    expect(cb).toHaveBeenCalledTimes(2);
    un();
  });

  it('coerces sloppy titles/messages (some call sites pass errors)', () => {
    Alert.alert(undefined as unknown as string, 42 as unknown as string);
    const cur = currentAlert()!;
    expect(cur.title).toBe('');
    expect(cur.message).toBe('42');
  });
});

describe('resolveAlertLayout — design-system variants', () => {
  it('two buttons render as a row with cancel pinned left', () => {
    const {axis, items} = resolveAlertLayout([
      {text: 'Delete', style: 'destructive'},
      {text: 'Cancel', style: 'cancel'},
    ]);
    expect(axis).toBe('row');
    expect(items.map(i => i.variant)).toEqual(['cancel', 'destructive']);
  });

  it('exactly one filled primary among multiple defaults (one-primary rule)', () => {
    const {items} = resolveAlertLayout([
      {text: 'Later'},
      {text: 'Now'},
    ]);
    expect(items.map(i => i.variant)).toEqual(['secondary', 'primary']);
  });

  it('three or more buttons stack in call order', () => {
    const {axis, items} = resolveAlertLayout([
      {text: 'One'},
      {text: 'Two', style: 'destructive'},
      {text: 'Cancel', style: 'cancel'},
    ]);
    expect(axis).toBe('column');
    expect(items.map(i => i.button.text)).toEqual(['One', 'Two', 'Cancel']);
  });

  it('B-680/FS-54 — a long verb stacks instead of truncating in a half-card', () => {
    const {axis, items} = resolveAlertLayout([
      {text: 'Cancel', style: 'cancel'},
      {text: 'Discard changes'},
    ]);
    expect(axis).toBe('column');
    // Critic P1-2 — the stacked pair pins cancel LAST regardless of call order.
    expect(items.map(i => i.button.text)).toEqual(['Discard changes', 'Cancel']);
  });

  it('single OK is the primary', () => {
    const {axis, items} = resolveAlertLayout([{text: 'OK'}]);
    expect(axis).toBe('row');
    expect(items[0].variant).toBe('primary');
  });
});

describe('NAV-16 (2026-08-26 rapid-use audit) — identical requests coalesce', () => {
  // A mashed button whose handler opens an Alert used to enqueue one dialog
  // per tap (confirmProductSwitch ×20 = 20 dialogs dismissed one at a time).
  it('THE BUG: N identical shows while one is queued produce ONE dialog', () => {
    for (let i = 0; i < 20; i++) { Alert.alert('Go to Workspace?', 'You can come back.'); }
    const first = currentAlert()!;
    expect(first.title).toBe('Go to Workspace?');
    pressAlertButton(first.id, first.buttons[0]);
    expect(currentAlert()).toBeNull();
  });

  it('a DIFFERENT alert still queues behind the visible one', () => {
    Alert.alert('First');
    Alert.alert('First', 'but different body');
    Alert.alert('Second');
    const a = currentAlert()!;
    pressAlertButton(a.id, a.buttons[0]);
    expect(currentAlert()!.message).toBe('but different body');
    const b = currentAlert()!;
    pressAlertButton(b.id, b.buttons[0]);
    expect(currentAlert()!.title).toBe('Second');
  });

  it('SAFETY RULE: a handler-carrying duplicate is NEVER dropped (promise wrappers)', () => {
    // locationPermission/ShiftEditor wrap Alert in a Promise settled only by
    // their own button handlers; dropping the second request would strand
    // that await forever. Only handler-less info alerts coalesce.
    const first = jest.fn();
    const second = jest.fn();
    Alert.alert('Allow location?', 'Needed for the mission.', [{text: 'OK', onPress: first}]);
    Alert.alert('Allow location?', 'Needed for the mission.', [{text: 'OK', onPress: second}]);
    const a = currentAlert()!;
    pressAlertButton(a.id, a.buttons[0]);
    const b = currentAlert()!;
    pressAlertButton(b.id, b.buttons[0]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(currentAlert()).toBeNull();
  });

  it('confirmSwitchDashboard latches at the source — a mash asks ONCE', () => {
    let now = 50_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const onYes = jest.fn();
      for (let i = 0; i < 20; i++) { now += 20; confirmSwitchDashboard('Workspace', onYes); }
      expect(currentAlert()).not.toBeNull();
      const a = currentAlert()!;
      pressAlertButton(a.id, a.buttons.find(x => x.text === 'Yes')!);
      expect(onYes).toHaveBeenCalledTimes(1);
      expect(currentAlert()).toBeNull();
      // ...and a deliberate later confirm still asks.
      now += 1_000;
      confirmSwitchDashboard('Workspace', onYes);
      expect(currentAlert()).not.toBeNull();
    } finally { spy.mockRestore(); }
  });
  it('a repeat AFTER dismissal shows again — only live duplicates coalesce', () => {
    Alert.alert('Once');
    const a = currentAlert()!;
    pressAlertButton(a.id, a.buttons[0]);
    expect(currentAlert()).toBeNull();
    Alert.alert('Once');
    expect(currentAlert()!.title).toBe('Once');
  });
});
describe('B-88 static sweep — no native Alert imports remain', () => {
  // The entire point of the shim: the SYSTEM AlertDialog must never
  // render again. Any new file importing Alert from react-native
  // regresses to the unbranded popup.
  const fs = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const SRC = pathMod.resolve(__dirname, '..', '..');

  function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = pathMod.join(dir, e.name);
      if (e.isDirectory()) {yield* walk(p);}
      else if (/\.(ts|tsx)$/.test(e.name)) {yield p;}
    }
  }

  it('no src file pulls Alert from react-native (static or lazy require)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = pathMod.relative(SRC, file).replace(/\\/g, '/');
      if (rel === 'utils/alert.ts') {continue;}
      const text = fs.readFileSync(file, 'utf8');
      const staticImports = text.match(/import\s*\{[^}]*\}\s*from\s*'react-native'/gs) ?? [];
      if (staticImports.some(im => /(?<![\w.])Alert(?![\w])/.test(im))) {
        offenders.push(rel + ' (static import)');
      }
      if (/\{\s*Alert\s*\}\s*=\s*require\(\s*'react-native'\s*\)/.test(text)) {
        offenders.push(rel + ' (lazy require)');
      }
    }
    expect(offenders).toEqual([]);
  });
});
