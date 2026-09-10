/**
 * FlexibleVideoTile — RTCView wrapper that guarantees a non-zero render
 * surface and forwards an explicit object-fit policy.
 *
 * The PARENT owns the rect. GroupCallScreen pins every tile wrapper to
 * its measured slot rect (BS-GC-BLACKVIDEO) and the inner container is
 * 100% x 100%, so a self-sizing `aspectRatio` here is dropped by Yoga in
 * every role — it was dead in every slot (GCV-2). Cropping is therefore
 * a decision the caller makes via `objectFit`, not something this
 * component can negotiate from the source dimensions.
 *
 * Why the 1px floor stays (BS-GC-0x0): field logcat (TECNO + Pixel)
 * showed `BLASTBufferQueue ... rejecting buffer:active_size=0x0`
 * repeating forever when a slot momentarily resolved to width 0 — every
 * decoded frame was dropped at the compositor and the tile stayed blank.
 * The floor guarantees a real surface until layout settles.
 *
 * Camera-off / no-video paths must NOT use this component — render the
 * avatar fallback as a fixed-dimension View instead.
 */
import React, {useMemo} from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {RTCView} from 'react-native-webrtc';

interface Props {
  streamURL: string;
  /** Front camera mirror — only set true for the user's own self-tile. */
  mirror?: boolean;
  /** RTCView z-order. Defaults to 0. Set 1 for PiP-on-top. */
  zOrder?: number;
  /**
   * 'cover' (default) fills the slot and centre-crops the source to the
   * slot aspect. 'contain' fits the whole frame inside the slot and lets
   * the parent's background show in the letterbox — use it where seeing
   * the full transmitted frame matters more than filling the rect.
   */
  objectFit?: 'contain' | 'cover';
  /**
   * Container style. The parent supplies the box (width AND height);
   * this component only adds the non-zero-surface floor.
   */
  containerStyle?: StyleProp<ViewStyle>;
}

export default function FlexibleVideoTile({
  streamURL,
  mirror = false,
  zOrder = 0,
  objectFit = 'cover',
  containerStyle,
}: Props): React.ReactElement {
  // Fix #42: memoize the merged style array so RN's StyleSheet diff
  // short-circuits instead of treating the outer View as changed every
  // frame (which cascaded into parent-grid layout recalculation).
  const mergedStyle = useMemo(
    () => [containerStyle, {minWidth: 1, minHeight: 1}],
    [containerStyle],
  );
  return (
    <View style={mergedStyle}>
      <RTCView
        streamURL={streamURL}
        style={StyleSheet.absoluteFill}
        objectFit={objectFit}
        mirror={mirror}
        zOrder={zOrder}
      />
    </View>
  );
}
