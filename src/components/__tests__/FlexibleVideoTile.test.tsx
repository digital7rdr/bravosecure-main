/**
 * GCV-2 — FlexibleVideoTile is a thin, honest RTCView wrapper:
 * the PARENT owns the rect, this component owns only the non-zero
 * surface floor (BS-GC-0x0) and forwards an explicit objectFit policy.
 *
 * These assertions are the regression pins that stop the deleted
 * self-sizing machinery (`aspectRatio` state + `onDimensionsChange`)
 * from being reintroduced — it was inert in every slot and cost a
 * native→JS bridge post per resolution change.
 */
import React from 'react';
import {render} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import FlexibleVideoTile from '../FlexibleVideoTile';

interface JsonNode {
  type:     string;
  props:    Record<string, unknown>;
  children: JsonNode[] | null;
}

function renderTile(el: React.ReactElement): {outer: JsonNode; rtc: JsonNode} {
  const outer = render(el).toJSON() as unknown as JsonNode;
  const rtc = (outer.children ?? [])[0];
  return {outer, rtc};
}

const flat = (node: JsonNode): Record<string, unknown> =>
  (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;

describe('FlexibleVideoTile', () => {
  it('defaults objectFit to cover', () => {
    const {rtc} = renderTile(<FlexibleVideoTile streamURL="stream://a" />);
    expect(rtc.type).toBe('RTCView');
    expect(rtc.props.objectFit).toBe('cover');
  });

  it('forwards an explicit objectFit verbatim', () => {
    const {rtc} = renderTile(<FlexibleVideoTile streamURL="stream://a" objectFit="contain" />);
    expect(rtc.props.objectFit).toBe('contain');
  });

  it('forwards streamURL / mirror / zOrder, with mirror=false and zOrder=0 defaults', () => {
    const {rtc} = renderTile(<FlexibleVideoTile streamURL="stream://a" />);
    expect(rtc.props.streamURL).toBe('stream://a');
    expect(rtc.props.mirror).toBe(false);
    expect(rtc.props.zOrder).toBe(0);

    const flipped = renderTile(<FlexibleVideoTile streamURL="stream://b" mirror zOrder={1} />);
    expect(flipped.rtc.props.streamURL).toBe('stream://b');
    expect(flipped.rtc.props.mirror).toBe(true);
    expect(flipped.rtc.props.zOrder).toBe(1);
  });

  it('GCV-2: the merged container style carries NO aspectRatio (the parent owns the rect)', () => {
    // The wrapper is pinned to its measured slot rect by GroupCallScreen,
    // so Yoga drops aspectRatio in every role — it was dead code that
    // still churned state on every frame-resolution change.
    const {outer} = renderTile(
      <FlexibleVideoTile streamURL="stream://a" containerStyle={{width: '100%', height: '100%'}} />,
    );
    expect(flat(outer)).not.toHaveProperty('aspectRatio');
  });

  it('BS-GC-0x0: the 1px surface floor survives the merge', () => {
    const {outer} = renderTile(<FlexibleVideoTile streamURL="stream://a" />);
    expect(flat(outer).minWidth).toBe(1);
    expect(flat(outer).minHeight).toBe(1);
  });

  it('GCV-3: RTCView gets no onDimensionsChange, so the native emitter stays off', () => {
    const {rtc} = renderTile(<FlexibleVideoTile streamURL="stream://a" />);
    expect(rtc.props.onDimensionsChange).toBeUndefined();
  });

  it("keeps the caller's containerStyle in the merged style", () => {
    const {outer} = renderTile(
      <FlexibleVideoTile streamURL="stream://a" containerStyle={{width: '100%', height: '100%'}} />,
    );
    const style = flat(outer);
    expect(style.width).toBe('100%');
    expect(style.height).toBe('100%');
    expect(style.minWidth).toBe(1);
  });

  it('RTCView fills the parent-owned box (absoluteFill)', () => {
    const {rtc} = renderTile(<FlexibleVideoTile streamURL="stream://a" />);
    expect(flat(rtc)).toMatchObject(StyleSheet.absoluteFillObject);
  });
});
