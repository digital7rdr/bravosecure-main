/**
 * MX-09 upload-progress registry — first coverage.
 *
 * Drives the UploadProgressRing on every media/voice-note bubble.
 * Values are observed through the real `useUploadProgress` hook (the
 * registry deliberately exports no getter), rendered with
 * react-test-renderer — no react-native import involved.
 */

import React from 'react';
// @ts-expect-error — react-test-renderer ships no bundled types and the
// repo avoids @types devDeps for test-only tooling; the module is `any`.
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {setUploadProgress, useUploadProgress} from '../media/uploadProgress';

function Probe({id}: {id: string}): React.ReactElement {
  const value = useUploadProgress(id);
  return React.createElement('probe', {value});
}

function mount(id: string): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => { r = create(React.createElement(Probe, {id})); });
  return r;
}

const valueOf = (r: ReactTestRenderer): number | null =>
  (r.root.findByType('probe' as never).props as {value: number | null}).value;

afterEach(() => {
  // The registry is module-level; clear the ids this file used.
  for (const id of ['m1', 'm2']) {act(() => setUploadProgress(id, null));}
});

describe('useUploadProgress', () => {
  it('null while no upload is in flight', () => {
    expect(valueOf(mount('m1'))).toBeNull();
  });

  it('reflects a published fraction', () => {
    const r = mount('m1');
    act(() => setUploadProgress('m1', 0.5));
    expect(valueOf(r)).toBe(0.5);
  });

  it('clamps below 0 and above 1', () => {
    const r = mount('m1');
    act(() => setUploadProgress('m1', -0.4));
    expect(valueOf(r)).toBe(0);
    act(() => setUploadProgress('m1', 3.7));
    expect(valueOf(r)).toBe(1);
  });

  it('quantises to 2% steps so a chatty XHR cannot render-storm', () => {
    const r = mount('m1');
    act(() => setUploadProgress('m1', 0.333));
    expect(valueOf(r)).toBe(0.34);
    act(() => setUploadProgress('m1', 0.999));
    expect(valueOf(r)).toBe(1);
  });

  it('null clears a finished upload back to idle', () => {
    const r = mount('m1');
    act(() => setUploadProgress('m1', 0.8));
    act(() => setUploadProgress('m1', null));
    expect(valueOf(r)).toBeNull();
  });

  it('message ids are independent', () => {
    const a = mount('m1');
    const b = mount('m2');
    act(() => setUploadProgress('m1', 0.2));
    act(() => setUploadProgress('m2', 0.9));
    expect(valueOf(a)).toBe(0.2);
    expect(valueOf(b)).toBe(0.9);
  });
});
