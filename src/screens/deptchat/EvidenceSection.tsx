/**
 * EvidenceSection (Dept Chat v2 · Step 10 · E4 · Item H) — renders an
 * incident's encrypted evidence (photos AND videos) inside the manager +
 * submitter detail screens. Lists the opaque attachment pointers, then on tap
 * fetches THIS device's sealed key, unseals it, downloads + decrypts the
 * ciphertext, and shows the media. The decrypted MIME decides the renderer:
 * video/* plays through expo-video (the FileViewer precedent — expo-av is
 * deliberately avoided, ESM interop crash on Hermes), everything else renders
 * as an image. Renders nothing when there is no evidence. Reuses the runtime
 * seam via loadEvidenceUri — no crypto here.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useVideoPlayer, VideoView} from 'expo-video';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {incidentApi} from '@services/api';
import {OB, SectionLabel} from './_obsidian';
import {loadEvidenceUri} from './incidentEvidence';

type Att = {id: string; storage_key: string};
type Resolved = {uri: string; mime: string} | null;

export function EvidenceSection({incidentId}: {incidentId: string}) {
  const [atts, setAtts] = useState<Att[]>([]);
  const [loading, setLoading] = useState(true);
  // attId → resolved {uri, mime} | null (open failed / not for this device).
  const [files, setFiles] = useState<Record<string, Resolved>>({});
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const {data} = await incidentApi.listAttachments(incidentId);
        if (alive) {setAtts(data.map(a => ({id: a.id, storage_key: a.storage_key})));}
      } catch {
        /* none, or not authorised — render nothing */
      } finally {
        if (alive) {setLoading(false);}
      }
    })();
    return () => { alive = false; };
  }, [incidentId]);

  const open = useCallback(async (att: Att) => {
    if (files[att.id] !== undefined || opening) {return;}
    setOpening(att.id);
    const file = await loadEvidenceUri(incidentId, att.id, att.storage_key);
    setFiles(prev => ({...prev, [att.id]: file}));
    setOpening(null);
  }, [incidentId, files, opening]);

  if (loading || atts.length === 0) {return null;}

  return (
    <View style={{marginTop: 20}}>
      <SectionLabel>EVIDENCE</SectionLabel>
      <View style={{gap: 10}}>
        {atts.map(att => {
          const file = files[att.id];
          if (file) {
            return file.mime.startsWith('video/')
              ? <EvidenceVideo key={att.id} uri={file.uri} />
              : <Image key={att.id} source={{uri: file.uri}} style={k.photo} resizeMode="cover" />;
          }
          const failed = file === null;
          return (
            <TouchableOpacity
              key={att.id}
              style={k.row}
              activeOpacity={0.85}
              disabled={failed || opening === att.id}
              onPress={() => { void open(att); }}>
              <View style={k.icon}>
                <Icon name={failed ? 'image-off-outline' : 'file-lock-outline'} size={18} color={failed ? OB.alert : OB.accentSoft} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                {/* "attachment", not "photo" — the type is unknowable until
                    decrypted (the mime travels inside the sealed key). */}
                <Text style={k.title}>{failed ? "Can't open on this device" : 'Encrypted attachment'}</Text>
                <Text style={k.sub} numberOfLines={1}>{failed ? 'Sealed for another device, or unavailable' : 'Tap to decrypt & view'}</Text>
              </View>
              {opening === att.id
                ? <ActivityIndicator size="small" color={OB.accentSoft} />
                : failed ? null : <Icon name="eye-outline" size={18} color={OB.accentSoft} />}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/** Inline video player over the decrypted local file — nativeControls so
 *  scrub/pause/fullscreen come free; no autoplay (evidence, not a feed). */
function EvidenceVideo({uri}: {uri: string}) {
  const player = useVideoPlayer({uri}, p => { p.loop = false; });
  return (
    <View style={k.videoWrap}>
      <VideoView style={k.video} player={player} allowsFullscreen contentFit="contain" nativeControls />
    </View>
  );
}

const k = StyleSheet.create(scaleTextStyles({
  photo: {width: '100%', height: 220, borderRadius: 14, backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair},
  videoWrap: {width: '100%', height: 220, borderRadius: 14, overflow: 'hidden', backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair},
  video: {width: '100%', height: '100%'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair},
  icon: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  title: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13.5},
  sub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
}));
