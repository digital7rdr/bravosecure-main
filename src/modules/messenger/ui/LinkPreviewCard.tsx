import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, Image, TouchableOpacity, Linking} from 'react-native';
import {firstUrlIn, getLinkPreview, type LinkPreview} from './linkPreview';

/**
 * Renders a thin, inline preview card below a text bubble whenever the
 * message body contains a URL. Fetches OpenGraph metadata lazily the
 * first time this card mounts for a given URL — subsequent renders
 * hit the in-memory cache in `linkPreview.ts`.
 *
 * Kept compact — small image on the left, title/site on the right, one
 * line of description. No special-casing by host (YouTube / Twitter /
 * etc) for Phase 1; if the remote site has OG tags, we render them.
 */
/**
 * B-90 T-12 privacy — session-scoped per-URL consent for RECEIVED links.
 * Auto-fetching metadata for an inbound URL pings the third-party host
 * from the recipient's IP the moment the bubble renders (a tracking /
 * deanonymization vector — Signal never fetches on receive). Until the
 * sender-embedded-preview envelope change clears architecture review,
 * inbound cards render as a "Tap to load preview" chip and only fetch
 * after an explicit tap. Consent is remembered per URL for the session.
 */
const consentedUrls = new Set<string>();

export function LinkPreviewCard({
  text,
  autoFetch = true,
  onLongPress,
  delayLongPress = 280,
}: {
  text: string | null | undefined;
  /** False for received messages — require a tap before any network fetch. */
  autoFetch?: boolean;
  /**
   * B-450 — the bubble's "open the action sheet" handler. Both branches below
   * are TouchableOpacity, so each claims the touch responder and swallowed the
   * bubble's long-press: on a link message the card is often the largest target
   * in the bubble, which made "you can't reply to links" the common case.
   */
  onLongPress?: () => void;
  /**
   * Must match the delay of the bubble wrapper that owns this card, or the
   * card is a dead band: RN's default is 500ms, so a press released between
   * the wrapper's delay and 500ms fires this element's onPress instead — which
   * on the consent chip means the T-12 privacy fetch runs from a gesture the
   * user aimed at the action sheet.
   */
  delayLongPress?: number;
}) {
  const url = firstUrlIn(text);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [consented, setConsented] = useState(
    () => autoFetch || (!!url && consentedUrls.has(url)),
  );

  useEffect(() => {
    setConsented(autoFetch || (!!url && consentedUrls.has(url)));
  }, [url, autoFetch]);

  useEffect(() => {
    if (!url || !consented) { setPreview(null); return; }
    let cancelled = false;
    void getLinkPreview(url).then(p => { if (!cancelled) {setPreview(p);} });
    return () => { cancelled = true; };
  }, [url, consented]);

  if (!url) {return null;}

  if (!consented) {
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Load link preview"
        onPress={() => { consentedUrls.add(url); setConsented(true); }}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        style={styles.consentChip}>
        <Text style={styles.consentText}>Tap to load preview</Text>
      </TouchableOpacity>
    );
  }

  if (!preview) {return null;}
  // No useful metadata — don't render a bare card that just repeats the URL.
  if (!preview.title && !preview.image) {return null;}

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => { void Linking.openURL(url).catch(() => undefined); }}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      style={styles.card}>
      {preview.image && (
        <Image
          source={{uri: preview.image}}
          style={styles.img}
          resizeMode="cover"
        />
      )}
      <View style={styles.body}>
        {preview.siteName ? <Text style={styles.site} numberOfLines={1}>{preview.siteName}</Text> : null}
        {preview.title ? <Text style={styles.title} numberOfLines={2}>{preview.title}</Text> : null}
        {preview.description ? <Text style={styles.desc}  numberOfLines={2}>{preview.description}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {flexDirection:'row', gap:8, marginTop:6, paddingVertical:6, paddingRight:10, borderLeftWidth:3, borderLeftColor:'#60A5FA', backgroundColor:'rgba(96,165,250,0.06)', borderRadius:6, overflow:'hidden'},
  img:  {width:56, height:56, borderRadius:4, marginLeft:8, backgroundColor:'#1E293B'},
  body: {flex:1, paddingVertical:2},
  site: {color:'#60A5FA', fontSize:10, fontWeight:'700', letterSpacing:0.5, textTransform:'uppercase'},
  title:{color:'#E2E8F0', fontSize:12, fontWeight:'700', marginTop:1},
  desc: {color:'#94A3B8', fontSize:10.5, marginTop:2, lineHeight:14},
  consentChip: {alignSelf:'flex-start', marginTop:6, paddingHorizontal:10, paddingVertical:5, borderRadius:99, borderWidth:1, borderColor:'rgba(96,165,250,0.35)', backgroundColor:'rgba(96,165,250,0.08)'},
  consentText: {color:'#60A5FA', fontSize:10.5, fontWeight:'700'},
});
