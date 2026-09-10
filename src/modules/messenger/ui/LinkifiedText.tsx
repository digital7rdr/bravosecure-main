/**
 * B-90 T-12 — tappable URLs inside chat bubbles, plus @-mention highlighting.
 *
 * Splits the body with the SAME regex the preview pipeline uses
 * (linkPreview.splitByUrls) and renders URL segments as underlined,
 * tappable nested Text spans. Nested spans wrap naturally with the
 * surrounding text, so long messages behave exactly like the previous
 * plain <Text>.
 *
 * Mentions are applied FIRST, then each remaining plain run is linkified.
 * That order matters: a display name can contain a dot ("R. Khan"), and
 * linkifying first would let the URL regex claim part of a mention and split
 * the highlight in half. Doing mentions first means the URL pass only ever
 * sees text that is definitely not part of a mention.
 *
 * Both features live in ONE body renderer on purpose. The bubble renders a body
 * and a caption through this component; a separate mention renderer would have
 * to be remembered at both call sites, and the one that was forgotten would
 * quietly show plain text — the same "author sees something different from
 * everyone else" shape that let B-144 survive manual testing.
 */
import React from 'react';
import {StyleSheet, Text, Linking, type StyleProp, type TextStyle} from 'react-native';
import {splitByUrls} from './linkPreview';
import {segmentMentions, type Mention} from '../runtime/mentionText';

interface Props {
  text: string | null | undefined;
  style?: StyleProp<TextStyle>;
  /** Link tint — pass a light tone on dark bubbles, white on cobalt. */
  linkColor: string;
  /** @-mentions carried by the message, if any. */
  mentions?: readonly Mention[];
  /** The viewing user's id, so a mention OF THEM can be emphasised. */
  selfUserId?: string | null;
  /** Mention tint. Defaults to `linkColor` so callers can opt out of theming. */
  mentionColor?: string;
  /**
   * Chip fill behind a mention. Defaults to a translucent white, which is what
   * makes the chip legible on the cobalt outgoing bubble where the tint itself
   * has to be near-white.
   */
  mentionChipColor?: string;
  /**
   * B-450 — the bubble's "open the action sheet" handler.
   *
   * A URL span is a `<Text onPress>`, which claims the touch responder, so a
   * long-press that lands ON a link never reached the bubble's own handler and
   * a message containing a link could not be replied to, forwarded or deleted
   * by pressing its most tappable part. Plain runs and mention chips register
   * no press handler, so they never had the problem and need nothing here.
   */
  onLongPress?: () => void;
}

export function LinkifiedText({
  text, style, linkColor, mentions, selfUserId, mentionColor, mentionChipColor, onLongPress,
}: Props) {
  const body = text ?? '';

  if (!mentions?.length) {
    return <LinkRun text={body} style={style} linkColor={linkColor} onLongPress={onLongPress} />;
  }

  const parts = segmentMentions(body, mentions, selfUserId);
  const tint = mentionColor ?? linkColor;
  const chipBg = mentionChipColor ?? 'rgba(255,255,255,0.18)';
  return (
    <Text style={style}>
      {parts.map((seg, i) =>
        seg.kind === 'mention' ? (
          <Text
            key={`m${i}`}
            // Rendered as a CHIP — tint + weight + a translucent background —
            // not just a colour. Colour alone failed on the outgoing bubble:
            // the tint there has to survive a cobalt fill, so it was white,
            // which is exactly the body-text colour, and the mention was
            // indistinguishable from the sentence around it. A translucent
            // background reads against both the cobalt (sent) and obsidian
            // (received) fills without inventing a new palette entry, and it
            // does not depend on colour perception alone (WCAG 1.4.1).
            //
            // A mention of YOU is heavier still — the whole reason to
            // highlight is to find the line addressed to you when scrolling
            // back through a busy group.
            style={[
              styles.mention,
              {color: tint, backgroundColor: chipBg},
              seg.isSelf ? styles.mentionSelf : null,
            ]}
            // Read as one unit, so a screen reader says "at Alice", not the
            // surrounding sentence broken across spans.
            accessibilityLabel={`mention ${seg.text.slice(1)}`}>
            {seg.text}
          </Text>
        ) : (
          <LinkRun key={`t${i}`} text={seg.text} linkColor={linkColor} onLongPress={onLongPress} />
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  mention:     {fontWeight: '600'},
  mentionSelf: {fontWeight: '800'},
});

/** The original URL pass, unchanged, over one run of non-mention text. */
function LinkRun({text, style, linkColor, onLongPress}: {
  text: string;
  style?: StyleProp<TextStyle>;
  linkColor: string;
  onLongPress?: () => void;
}) {
  const segments = splitByUrls(text);
  const hasUrl = segments.some(s => s.url);
  if (!hasUrl) {
    return <Text style={style}>{text}</Text>;
  }
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.url ? (
          <Text
            key={`${i}-${seg.url}`}
            style={{color: linkColor, textDecorationLine: 'underline'}}
            accessibilityRole="link"
            onPress={() => { void Linking.openURL(seg.url!).catch(() => {}); }}
            // B-450 — without this, a long-press on the link opened the URL on
            // release (Pressability only cancels onPress when onLongPress
            // exists) and the bubble's action sheet never appeared.
            //
            // No delayLongPress here, and none is possible: RN's <Text> builds
            // its Pressability config without that prop (Libraries/Text/Text.js),
            // so 500ms is a platform floor on this element alone. Do not "fix"
            // the mismatch with the 280/350ms touchable sites by adding one — it
            // is silently ignored.
            onLongPress={onLongPress}
            suppressHighlighting>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}
