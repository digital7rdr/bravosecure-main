/**
 * Generic pinch-zoom / pan / double-tap canvas for arbitrary content whose
 * natural size isn't known ahead of time (e.g. a tree diagram that grows
 * with the data, unlike ZoomableImage's fixed intrinsic image size).
 *
 * Built on the SAME classic gesture-handler + Animated (native driver)
 * model as `modules/messenger/ui/ZoomableImage` — this app's babel config
 * does not wire the reanimated worklets plugin, so this deliberately does
 * NOT use GestureDetector/worklet callbacks. Shares `zoomMath`'s clamp
 * functions, which are already generic (viewport/content dimensions in,
 * not image-specific).
 *
 * Content keeps its natural layout size (measured via onLayout) inside a
 * fixed-size, clipped viewport; pan is allowed even at scale 1 so content
 * taller than the viewport can be reached without a scroll gesture
 * conflicting with pinch/pan.
 */
import React, {useRef, useState} from 'react';
import {Animated, StyleSheet, View, type LayoutChangeEvent, type ViewStyle} from 'react-native';
import {
  PanGestureHandler,
  PinchGestureHandler,
  TapGestureHandler,
  State as GestureState,
  type PanGestureHandlerStateChangeEvent,
  type PinchGestureHandlerStateChangeEvent,
  type TapGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import {clampScale, clampTranslation, DOUBLE_TAP_SCALE, MIN_SCALE} from '@/modules/messenger/ui/zoomMath';

const SPRING = {useNativeDriver: true, tension: 120, friction: 12} as const;

export function ZoomableView({children, style}: {children: React.ReactNode; style?: ViewStyle}) {
  const [viewport, setViewport] = useState({w: 0, h: 0});
  const [content, setContent] = useState({w: 0, h: 0});
  const viewportRef = useRef(viewport);
  const contentRef = useRef(content);
  viewportRef.current = viewport;
  contentRef.current = content;

  const onViewportLayout = (e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setViewport({w: width, h: height});
  };
  const onContentLayout = (e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setContent({w: width, h: height});
  };

  const baseScale  = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const scale      = useRef(Animated.multiply(baseScale, pinchScale)).current;
  const panX       = useRef(new Animated.Value(0)).current;
  const panY       = useRef(new Animated.Value(0)).current;

  const baseScaleRef = useRef(1);
  const restTxRef    = useRef(0);
  const restTyRef    = useRef(0);
  const panActiveRef = useRef(false);

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

  const settleTranslation = (atScale: number, tx: number, ty: number) => {
    const target = clampTranslation({
      scale: atScale,
      viewW: viewportRef.current.w, viewH: viewportRef.current.h,
      contentW: contentRef.current.w, contentH: contentRef.current.h,
      tx, ty,
    });
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
    baseScale.setValue(raw);
    pinchScale.setValue(1);
    if (raw !== clamped) {
      Animated.spring(baseScale, {...SPRING, toValue: clamped}).start();
    }
    if (!panActiveRef.current) {
      settleTranslation(clamped, restTxRef.current, restTyRef.current);
    }
  };

  const onPanStateChange = (e: PanGestureHandlerStateChangeEvent) => {
    const {state, oldState, translationX, translationY} = e.nativeEvent;
    if (state === GestureState.BEGAN) {
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
    if (oldState !== GestureState.ACTIVE) {
      panActiveRef.current = false;
      return;
    }
    panActiveRef.current = false;
    const totalX = restTxRef.current + (isFinite(translationX) ? translationX : 0);
    const totalY = restTyRef.current + (isFinite(translationY) ? translationY : 0);
    settleTranslation(baseScaleRef.current, totalX, totalY);
  };

  const onDoubleTap = (e: TapGestureHandlerStateChangeEvent) => {
    if (e.nativeEvent.state !== GestureState.ACTIVE) {return;}
    const target = baseScaleRef.current > 1.05 ? MIN_SCALE : DOUBLE_TAP_SCALE;
    baseScaleRef.current = target;
    Animated.spring(baseScale, {...SPRING, toValue: target}).start();
    panX.stopAnimation();
    panY.stopAnimation();
    panX.flattenOffset();
    panY.flattenOffset();
    settleTranslation(target, restTxRef.current, restTyRef.current);
  };

  return (
    <View style={[style, styles.viewport]} onLayout={onViewportLayout}>
      <TapGestureHandler numberOfTaps={2} maxDelayMs={240} onHandlerStateChange={onDoubleTap}>
        <Animated.View style={StyleSheet.absoluteFill}>
          <PanGestureHandler
            ref={panHandlerRef}
            simultaneousHandlers={pinchHandlerRef}
            minPointers={1}
            maxPointers={2}
            onGestureEvent={onPanEvent}
            onHandlerStateChange={onPanStateChange}>
            <Animated.View style={StyleSheet.absoluteFill}>
              <PinchGestureHandler
                ref={pinchHandlerRef}
                simultaneousHandlers={panHandlerRef}
                onGestureEvent={onPinchEvent}
                onHandlerStateChange={onPinchStateChange}>
                <Animated.View
                  onLayout={onContentLayout}
                  style={{
                    transform: [{translateX: panX}, {translateY: panY}, {scale}],
                  }}>
                  {children}
                </Animated.View>
              </PinchGestureHandler>
            </Animated.View>
          </PanGestureHandler>
        </Animated.View>
      </TapGestureHandler>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {overflow: 'hidden'},
});
