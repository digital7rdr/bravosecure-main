import 'reflect-metadata';
import {PATH_METADATA} from '@nestjs/common/constants';
import {OpsDataController} from './ops-data.controller';
import {OpsController} from './ops.controller';

/**
 * SK-08 (audit 2026-08-07) — the org-audit reader used to live at
 * `audit/org/:orgUserId`, which OpsController's `audit/:subject_type/:subject_id`
 * wildcard could shadow depending on controller registration order. The reader
 * moved to `audit-log/…` (no shared prefix). These pins keep both facts true.
 */
describe('ops audit route shadowing (SK-08)', () => {
  it('org-audit reader lives under the unshadowed audit-log/ prefix', () => {
    const path = Reflect.getMetadata(PATH_METADATA, OpsDataController.prototype.orgAudit);
    expect(path).toBe('audit-log/org/:orgUserId');
  });

  it('no OpsDataController audit reader shares the audit/ wildcard prefix', () => {
    const wildcard = Reflect.getMetadata(PATH_METADATA, OpsController.prototype.subjectAudit);
    expect(wildcard).toBe('audit/:subject_type/:subject_id');
    for (const name of Object.getOwnPropertyNames(OpsDataController.prototype)) {
      const p = Reflect.getMetadata(PATH_METADATA, (OpsDataController.prototype as unknown as Record<string, object>)[name]);
      if (typeof p !== 'string' || p === 'audit') continue; // the browse reader itself is exact-match, unshadowed
      expect(p.startsWith('audit/')).toBe(false);
    }
  });
});
