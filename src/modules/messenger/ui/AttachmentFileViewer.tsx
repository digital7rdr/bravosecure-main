/**
 * Media-parity M2 (2026-07-03) — a resolving attachment viewer shared by
 * ChatScreen, the Files tab, and Departmental chat. Given a message's
 * media fields it downloads + decrypts on demand (via useAttachmentUri,
 * temp-file-first + single-flight) and renders the shared FileViewer once
 * a local uri is ready. Before this, the Files tab and dept-chat had no
 * working open path at all (a disabled row / a no-op TouchableOpacity).
 */

import React from 'react';
import {Text, StyleSheet, Modal, Pressable, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAttachmentUri, attachmentErrorText, type AttachmentMessageLike} from '../media/useAttachmentUri';
import {FileViewer, type ViewableFile} from './FileViewer';

export interface AttachmentViewTarget extends AttachmentMessageLike {
  /** Conversation the message belongs to (for onDelete). */
  conversationId: string;
  /** Display name — filename / caption / type fallback. */
  name: string;
  createdAt: number;
  sizeBytes?: number;
}

export function AttachmentFileViewer({
  target,
  onClose,
  onDelete,
}: {
  target:   AttachmentViewTarget | null;
  onClose:  () => void;
  onDelete?: (t: AttachmentViewTarget) => void;
}) {
  if (!target) {return null;}
  return <Resolver key={target.id} target={target} onClose={onClose} onDelete={onDelete} />;
}

function Resolver({
  target,
  onClose,
  onDelete,
}: {
  target:   AttachmentViewTarget;
  onClose:  () => void;
  onDelete?: (t: AttachmentViewTarget) => void;
}) {
  const {uri, state, errorReason, load} = useAttachmentUri(target, {auto: true});

  if (state === 'loading' || (!uri && state !== 'error')) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.root} onPress={onClose}>
          <Icon name="lock" size={36} color="#7E8AA6" />
          <Text style={styles.text}>Decrypting…</Text>
        </Pressable>
      </Modal>
    );
  }

  if (state === 'error' || !uri) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.root} onPress={onClose}>
          <Icon name="image-broken-variant" size={36} color="#7E8AA6" />
          <Text style={styles.text}>{attachmentErrorText(errorReason)}</Text>
          <TouchableOpacity onPress={load} activeOpacity={0.7} style={{marginTop: 12}}>
            <Text style={[styles.text, {color: '#1E88FF'}]}>Tap to retry</Text>
          </TouchableOpacity>
        </Pressable>
      </Modal>
    );
  }

  const file: ViewableFile = {
    id:        target.id,
    name:      target.name,
    uri,
    mimeType:  target.media_mime ?? 'application/octet-stream',
    size:      target.sizeBytes,
    createdAt: target.createdAt,
    // Phase 4 — PROVENANCE. This was dropped, and because the field was
    // optional the compiler could not say so: FileViewer then sent null to the
    // vault, the company-file refusal never fired, and B1 was live again on the
    // department chat and the workspace Vault tab. The target already carries a
    // required conversationId; it just was not forwarded.
    conversationId: target.conversationId,
  };
  return (
    <FileViewer
      file={file}
      onClose={onClose}
      onDelete={() => { onDelete?.(target); onClose(); }}
    />
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center'},
  text: {color: '#7E8AA6', fontSize: 13, fontWeight: '600', marginTop: 10},
});
