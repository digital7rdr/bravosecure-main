/**
 * B-87/MX-03 — pinch-zoom / double-tap / pan image surface for the
 * full-screen viewer. Built on the CLASSIC gesture-handler API +
 * core Animated with the native driver: gesture frames never cross the
 * JS bridge, and no reanimated worklets are required (the babel worklets
 * plugin is not configured in this app — do not "upgrade" this to
 * GestureDetector worklet callbacks without wiring that first).
 *
 * Gesture model:
 *   - pinch scales about the box centre (baseScale × live pinch factor)
 *   - pan translates in screen points; simultaneous with pinch so the
 *     user can drag while zooming
 *   - releases clamp scale to [1, 4] and translation to the visible
 *     bounds (zoomMath), springing back with the native driver
 *   - double-tap toggles 1x ↔ 2.5x; zoom-out re-centres
 *
 * Why no Animated listeners: release-time math reads the final
 * translation/scale from the GESTURE EVENT payloads and mirrors rest
 * state in plain refs — listener semantics for native-driven values
 * with offsets differ per platform and can't be device-verified here.
 *
 * Must be hosted inside a GestureHandlerRootView when rendered in a
 * RN <Modal> (Modals open a new native window — see FileViewer).
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Image} from 'react-native';
import {
  PanGestureHandler,
  PinchGestureHandler,
  TapGestureHandler,
  State as GestureState,
  type PanGestureHandlerStateChangeEvent,
  type PinchGestureHandlerStateChangeEvent,
  type TapGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import {
  clampScale,
  clampTranslation,
  containRect,
  DOUBLE_TAP_SCALE,
  MIN_SCALE,
  swipeIntent,
} from './zoomMath';

const SPRING = {useNativeDriver: true, tension: 120, friction: 12} as const;

export function ZoomableImage({uri, width, height, onSwipe}: {
  uri:    string;
  width:  number;
  height: number;
  /**
   * B-287 — page to the next (+1) / previous (-1) image. Fires only on a
   * release that `swipeIntent` accepts, which never fires while zoomed. Omit
   * to keep the surface a plain zoomable image (the vault + files viewers).
   */
  onSwipe?: (direction: -1 | 1) => void;
}) {
  // Intrinsic image size → contain-fit rect for translation bounds.
  // Until getSize resolves, the full box is used (slightly loose pan
  // bounds on letterboxed images — corrected the moment it lands).
  const [imgDims, setImgDims] = useState<{w: number; h: number} | null>(null);
  useEffect(() => {
    let live = true;
    Image.getSize(
      uri,
      (w, h) => { if (live && w > 0 && h > 0) {setImgDims({w, h});} },
      () => { /* keep box fallback */ },
    );
    return () => { live = false; };
  }, [uri]);

  // Animated nodes: base* rest state is JS-set on gesture ends;
  // pinchScale/panX/panY stream from the UI thread via Animated.event.
  const baseScale  = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const scale      = useRef(Animated.multiply(baseScale, pinchScale)).current;
  const panX       = useRef(new Animated.Value(0)).current;
  const panY       = useRef(new Animated.Value(0)).current;

  // Rest-state mirrors — kept in sync at gesture boundaries from event
  // payloads, never from listeners.
  const baseScaleRef = useRef(1);
  const restTxRef    = useRef(0);
  const restTyRef    = useRef(0);
  const panActiveRef = useRef(false);

  // Fresh image → rest state.
  useEffect(() => {
    baseScaleRef.current = 1;
    restTxRef.current = 0;
    restTyRef.current = 0;
    panActiveRef.current = false;
    baseScale.setValue(1);
    pinchScale.setValue(1);
    panX.setOffset(0);
    panX.setValue(0);
    panY.setOffset(0);
    panY.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  const pinchHandlerRef = useRef(null);
  const panHandlerRef   = useRef(null);

  const onPinchEvent = useRef(Animated.event(
    [{nativeEvent: {scale: pinchScale}}],
    {useNativeDriver: true},
  )).current;
  const onPanEvent = useRef(Animated.event(
    [{nativeEvent: {translationX: panX, translationY: panY}}],
    {useNativeDriver: true},
  )).current;

  const contentRect = () =>
    containRect(width, height, imgDims?.w ?? width, imgDims?.h ?? height);

  /** Spring the translation to its clamped rest for the given scale. */
  const settleTranslation = (atScale: number, tx: number, ty: number) => {
    const content = contentRect();
    const target = clampTranslation({
      scale: atScale, viewW: width, viewH: height,
      contentW: content.width, contentH: content.height, tx, ty,
    });
    // flattenOffset folds any gesture offset into the plain value so the
    // spring starts from the exact on-screen position.
    panX.flattenOffset();
    panY.flattenOffset();
    Animated.spring(panX, {...SPRING, toValue: target.tx}).start();
    Animated.spring(panY, {...SPRING, toValue: target.ty}).start();
    restTxRef.current = target.tx;
    restTyRef.current = target.ty;
  };

  const onPinchStateChange = (e: PinchGestureHandlerStateChangeEvent) => {
    if (e.nativeEvent.oldState !== GestureState.ACTIVE) {return;}
    const g = e.nativeEvent.scale;
    const raw = baseScaleRef.current * (isFinite(g) && g > 0 ? g : 1);
    const clamped = clampScale(raw);
    baseScaleRef.current = clamped;
    // Keep the on-screen product continuous (base×1 === oldBase×gesture),
    // then rubber-band to the clamp target if the pinch overshot.
    baseScale.setValue(raw);
    pinchScale.setValue(1);
    if (raw !== clamped) {
      Animated.spring(baseScale, {...SPRING, toValue: clamped}).start();
    }
    // Re-clamp translation for the new scale — unless a pan is still
    // active (its own END will settle with this scale via the refs).
    if (!panActiveRef.current) {
      settleTranslation(clamped, restTxRef.current, restTyRef.current);
    }
  };

  const onPanStateChange = (e: PanGestureHandlerStateChangeEvent) => {
    const {state, oldState, translationX, translationY} = e.nativeEvent;
    // BEGAN fires on EVERY touch-down over the image (taps included) —
    // it only prepares continuity, it must NOT latch panActiveRef: a tap
    // goes BEGAN→FAILED without ever being ACTIVE, and a latched flag
    // here permanently killed double-tap zoom + the pinch-release settle.
    if (state === GestureState.BEGAN) {
      // Freeze any settle spring, then fold the current value into the
      // offset so this gesture's translation (starting at 0) continues
      // seamlessly from the on-screen position.
      panX.stopAnimation();
      panY.stopAnimation();
      panX.extractOffset();
      panY.extractOffset();
      return;
    }
    if (state === GestureState.ACTIVE) {
      panActiveRef.current = true;
      return;
    }
    // Terminal states (END / CANCELLED / FAILED) — from BEGAN (tap that
    // never activated) or from ACTIVE (real drag).
    if (oldState !== GestureState.ACTIVE) {
      panActiveRef.current = false;
      return;
    }
    panActiveRef.current = false;
    const totalX = restTxRef.current + (isFinite(translationX) ? translationX : 0);
    const totalY = restTyRef.current + (isFinite(translationY) ? translationY : 0);
    // B-287 — a horizontal release at rest scale pages instead of panning.
    const dir = onSwipe
      ? swipeIntent({
          translationX,
          translationY,
          velocityX: e.nativeEvent.velocityX,
          scale: baseScaleRef.current,
        })
      : 0;

    if (dir !== 0 && onSwipe) {
      // B-293 — carry the image OFF in the drag direction before swapping.
      //
      // Swapping the source with no motion is why this read as "not working"
      // even once the gesture fired: the photo simply changed, with no cue that
      // a swipe had been recognised. 130ms is short enough not to feel like lag
      // and long enough to be legible as a page turn.
      panX.flattenOffset();
      panY.flattenOffset();
      Animated.timing(panX, {
        toValue: dir === 1 ? -width : width,
        duration: 130,
        useNativeDriver: true,
      }).start(() => {
        onSwipe(dir);
        /**
         * B-295 — re-centre THROUGH THE ANIMATION SYSTEM. Never `setValue` or
         * `setOffset` here.
         *
         * `panX` is NATIVE-DRIVEN: both the pan `Animated.event` and the slide
         * above pass `useNativeDriver: true`. Writing a native-driven node from
         * JS does not reliably reach the native side — the shadow node keeps the
         * last ANIMATED value, which is ±width. So the image stayed parked
         * off-screen, the viewer went blank, and a blank viewer has no gesture
         * surface, so the next swipe hit nothing and it read as stuck on the
         * first photo. That was v1.0.174/175.
         *
         * A zero-duration timing takes the same path `settleTranslation`'s
         * spring already uses, which is why the settle path never had this bug.
         * This module's header says it outright: do not read or write
         * native-driven values from JS.
         *
         * Unconditional, and that part is still load-bearing: at the first or
         * last photo `onSwipe` changes nothing, so the uri-effect that normally
         * resets translation never runs. The snap-back doubles as the "no more
         * photos this way" cue.
         */
        Animated.timing(panX, {toValue: 0, duration: 0, useNativeDriver: true}).start();
        Animated.timing(panY, {toValue: 0, duration: 0, useNativeDriver: true}).start();
        restTxRef.current = 0;
        restTyRef.current = 0;
      });
      return;
    }

    // Not a page — settle back to rest, or a rejected swipe leaves the photo
    // parked off-axis.
    settleTranslation(baseScaleRef.current, totalX, totalY);
  };

  const onDoubleTap = (e: TapGestureHandlerStateChangeEvent) => {
    if (e.nativeEvent.state !== GestureState.ACTIVE) {return;}
    // No panActiveRef guard here: a double-tap's second touch-down puts
    // the pan in BEGAN, and callback ordering between the tap ACTIVATING
    // and the pan being cancelled is not guaranteed. A REAL drag cancels
    // the tap gesture natively anyway, so the guard was redundant.
    const target = baseScaleRef.current > 1.05 ? MIN_SCALE : DOUBLE_TAP_SCALE;
    baseScaleRef.current = target;
    Animated.spring(baseScale, {...SPRING, toValue: target}).start();
    // Zoom-in anchors centre (translations are 0 at rest); zoom-out
    // re-centres whatever pan the user had.
    panX.stopAnimation();
    panY.stopAnimation();
    panX.flattenOffset();
    panY.flattenOffset();
    Animated.spring(panX, {...SPRING, toValue: 0}).start();
    Animated.spring(panY, {...SPRING, toValue: 0}).start();
    restTxRef.current = 0;
    restTyRef.current = 0;
  };

  return (
    <TapGestureHandler numberOfTaps={2} maxDelayMs={240} onHandlerStateChange={onDoubleTap}>
      <Animated.View style={{width, height}}>
        <PanGestureHandler
          ref={panHandlerRef}
          simultaneousHandlers={pinchHandlerRef}
          minPointers={1}
          maxPointers={2}
          onGestureEvent={onPanEvent}
          onHandlerStateChange={onPanStateChange}>
          <Animated.View style={{width, height}}>
            <PinchGestureHandler
              ref={pinchHandlerRef}
              simultaneousHandlers={panHandlerRef}
              onGestureEvent={onPinchEvent}
              onHandlerStateChange={onPinchStateChange}>
              <Animated.View
                style={{
                  width,
                  height,
                  transform: [{translateX: panX}, {translateY: panY}, {scale}],
                }}>
                <Image
                  source={{uri}}
                  style={{width, height}}
                  resizeMode="contain"
                  accessibilityRole="image"
                />
              </Animated.View>
            </PinchGestureHandler>
          </Animated.View>
        </PanGestureHandler>
      </Animated.View>
    </TapGestureHandler>
  );
}
