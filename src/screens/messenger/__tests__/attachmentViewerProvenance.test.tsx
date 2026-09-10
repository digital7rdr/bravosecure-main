/**
 * Scope v2 Phase 4, R4-B3 — `AttachmentFileViewer` must forward the REAL
 * conversation, not merely satisfy the type.
 *
 * Making `ViewableFile.conversationId` required got the compiler to enumerate
 * every builder — but `null` is a legal value of `string | null`, so the type
 * only forces a builder to STATE something. Changing this one line to
 * `conversationId: null` left both full projects green while re-opening the
 * company-file copy path from the department chat and the workspace Vault tab,
 * because the choke point then sees no provenance to refuse on.
 *
 * `AttachmentViewTarget.conversationId` is already required and both callers
 * pass a real one; the bug was purely the drop in between. So assert the VALUE.
 */
import React from 'react';
import {render} from '@testing-library/react-native';

const mockViewerProps = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://x.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@/modules/messenger/media/useAttachmentUri', () => ({
  useAttachmentUri: () => ({uri: 'file:///tmp/x.pdf', state: 'ready'}),
  attachmentErrorText: () => '',
}));
jest.mock('@/modules/messenger/ui/FileViewer', () => ({
  FileViewer: (props: unknown) => { mockViewerProps(props); return null; },
}));

import {AttachmentFileViewer} from '@/modules/messenger/ui/AttachmentFileViewer';

const target = {
  id: 'm1',
  conversationId: 'conv-department-channel',
  name: 'BOARD-MINUTES.pdf',
  createdAt: 1,
  sizeBytes: 10,
  media_object_key: 'obj-1',
  media_key: 'k',
  media_iv: 'i',
  media_mime: 'application/pdf',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('AttachmentFileViewer forwards provenance to the vault choke point', () => {
  it('passes the target\'s ACTUAL conversation id, not null', () => {
    render(<AttachmentFileViewer target={target} onClose={jest.fn()} />);
    const props = mockViewerProps.mock.calls[0][0] as {file: {conversationId: string | null}};
    expect(props.file.conversationId).toBe('conv-department-channel');
    // Explicit: `null` is the regression, and it typechecks.
    expect(props.file.conversationId).not.toBeNull();
  });

  it('carries it for a different conversation too, so it is not a constant', () => {
    render(<AttachmentFileViewer target={{...target, conversationId: 'conv-dm'}} onClose={jest.fn()} />);
    const props = mockViewerProps.mock.calls[0][0] as {file: {conversationId: string | null}};
    expect(props.file.conversationId).toBe('conv-dm');
  });
});
