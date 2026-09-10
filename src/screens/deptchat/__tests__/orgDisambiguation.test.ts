/**
 * Channels vs2 edge A7 — two organisations with the SAME NAME are
 * indistinguishable, and on the hub that choice decides which company's data
 * the whole Departmental surface then reads and writes.
 *
 * Names carry no uniqueness constraint anywhere (the Rev-7 security argument
 * depends on that), so this is ordinary data, not a corruption.
 */
import {
  collidingOrgNames, needsOrgDisambiguator, shortOrgRef, orgDisambiguator,
  orgSectionLabels, UNATTRIBUTED_ORG_LABEL,
} from '../orgDisambiguation';

describe('collidingOrgNames', () => {
  it('finds only the names that appear more than once', () => {
    expect([...collidingOrgNames(['Acme', 'Borealis', 'Acme'])]).toEqual(['acme']);
  });

  it('is EMPTY for the overwhelmingly common single-org case', () => {
    // The disambiguator is noise when nothing collides, and noise is how people
    // stop reading a line that matters.
    expect(collidingOrgNames(['Acme']).size).toBe(0);
    expect(collidingOrgNames([]).size).toBe(0);
  });

  it('treats case and surrounding space as the SAME name', () => {
    // "Acme" and "acme " are the same name to the person choosing between them,
    // which is the entire failure being fixed.
    expect(collidingOrgNames(['Acme', 'acme ']).size).toBe(1);
    expect(needsOrgDisambiguator(' ACME', collidingOrgNames(['Acme', 'acme ']))).toBe(true);
  });

  it('collides BLANK names, which are indistinguishable by definition', () => {
    expect(collidingOrgNames(['', '  ']).size).toBe(1);
  });

  it('handles three or more sharing one name', () => {
    const c = collidingOrgNames(['Acme', 'Acme', 'Acme', 'Borealis']);
    expect(c.size).toBe(1);
    expect(needsOrgDisambiguator('Borealis', c)).toBe(false);
  });
});

describe('shortOrgRef', () => {
  it('uses the TAIL of the uuid, upper-cased', () => {
    // The head is what people already see repeated in URLs and tickets; the
    // last block is the part they actually scan.
    expect(shortOrgRef('aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001')).toBe('ID 0001');
  });

  it('differs for two ids that share a prefix', () => {
    const a = shortOrgRef('aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001');
    const b = shortOrgRef('aaaa1111-bbbb-4ccc-8ddd-eeeeffff0002');
    expect(a).not.toBe(b);
  });

  it('degrades rather than throwing on a short or empty id', () => {
    expect(shortOrgRef('')).toBe('');
    expect(shortOrgRef('ab')).toBe('ID AB');
  });
});

describe('orgDisambiguator — what a surface actually renders', () => {
  const ACME_1 = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
  const ACME_2 = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0002';
  const colliding = collidingOrgNames(['Acme', 'Acme', 'Borealis']);

  it('returns NULL when nothing collides — the surface keeps its own subtitle', () => {
    expect(orgDisambiguator('Borealis', ACME_1, colliding, 'Owner')).toBeNull();
  });

  it('keeps the surface detail and appends the id handle', () => {
    // The hub has a role line, Manage Channels has a channel count — the extra
    // line stays informative instead of becoming a bare id.
    expect(orgDisambiguator('Acme', ACME_1, colliding, 'Owner · Manage and enter'))
      .toBe('Owner · Manage and enter · ID 0001');
  });

  it('yields DIFFERENT text for the two colliding rows — the whole point', () => {
    const a = orgDisambiguator('Acme', ACME_1, colliding, 'Owner');
    const b = orgDisambiguator('Acme', ACME_2, colliding, 'Owner');
    expect(a).not.toBe(b);
  });

  it('still disambiguates when the surface has no detail to offer', () => {
    // The invite picker has neither a role nor a count.
    expect(orgDisambiguator('Acme', ACME_1, colliding)).toBe('ID 0001');
  });

  it('drops a blank detail rather than rendering a dangling separator', () => {
    expect(orgDisambiguator('Acme', ACME_1, colliding, '   ')).toBe('ID 0001');
  });
});

/**
 * B-624 — naming the organisation SECTIONS on the departmental Channels screen.
 *
 * `listChannels` answers `org_id` and not `org_name`, so the header is resolved
 * from names the client already holds. A section with no name is the flat pile
 * wearing a hat, so the fallback matters as much as the hit.
 */
describe('orgSectionLabels', () => {
  const BAG = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
  const JACQUES = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0002';

  it('names a section from the workspaces the client already knows', () => {
    const labels = orgSectionLabels([BAG, JACQUES], [
      {org_id: BAG, name: 'BAG'}, {org_id: JACQUES, name: 'Jacques Security'},
    ]);
    expect(labels.get(BAG)).toBe('BAG');
    expect(labels.get(JACQUES)).toBe('Jacques Security');
  });

  it('falls back to the SHORT HANDLE, never a raw uuid and never blank', () => {
    // An agency-owned org is structurally absent from `user.workspaces`. That
    // is a normal state; a blank header would be the flat pile again.
    const labels = orgSectionLabels([BAG, JACQUES], [{org_id: BAG, name: 'BAG'}]);
    expect(labels.get(JACQUES)).toBe('ID 0002');
    expect(labels.get(JACQUES)).not.toContain(JACQUES);
  });

  it('labels the un-attributed (old-server) section without an id', () => {
    const labels = orgSectionLabels([null, BAG], [{org_id: BAG, name: 'BAG'}]);
    expect(labels.get(null)).toBe(UNATTRIBUTED_ORG_LABEL);
    expect(labels.get(null)).not.toMatch(/ID /);
  });

  it('disambiguates two organisations that resolve to the SAME name', () => {
    // Edge A7, reached through the existing rule rather than a second copy.
    const labels = orgSectionLabels([BAG, JACQUES], [
      {org_id: BAG, name: 'Acme'}, {org_id: JACQUES, name: 'acme '},
    ]);
    expect(labels.get(BAG)).toBe('Acme · ID 0001');
    expect(labels.get(JACQUES)).toBe('acme · ID 0002');
    expect(labels.get(BAG)).not.toBe(labels.get(JACQUES));
  });

  it('does NOT re-suffix a fallback label with its own handle', () => {
    // Two unknown orgs whose handles differ do not collide at all; the point is
    // that a label already equal to its ref never becomes "ID 0001 · ID 0001".
    const labels = orgSectionLabels([BAG, JACQUES], []);
    expect(labels.get(BAG)).toBe('ID 0001');
    expect(labels.get(JACQUES)).toBe('ID 0002');
  });

  it('leaves the single-org case a plain name — no id, no separator', () => {
    const labels = orgSectionLabels([BAG], [{org_id: BAG, name: 'BAG'}]);
    expect(labels.get(BAG)).toBe('BAG');
  });

  it('the FIRST source wins, so the caller can order them by authority', () => {
    const labels = orgSectionLabels([BAG], [
      {org_id: BAG, name: 'BAG'}, {org_id: BAG, name: 'Stale name'},
    ]);
    expect(labels.get(BAG)).toBe('BAG');
  });

  it('ignores a blank source name instead of rendering an empty header', () => {
    const labels = orgSectionLabels([BAG], [{org_id: BAG, name: '   '}]);
    expect(labels.get(BAG)).toBe('ID 0001');
  });
});
