'use client';

import {useMemo} from 'react';
import {Shell} from '@/components/Shell';
import {useDepartments, type DepartmentChannelRow} from '@/lib/api';
import {formatDateUtc} from '@/lib/datetime';

// SK-06 — the server has always returned parent_id/level/channel_type/access;
// the console flattened them away. Rebuild the hierarchy client-side (the ops
// list endpoint is created_at-ordered, not tree-ordered) and render an
// indented tree with type/access badges.
const TYPE_BADGE: Record<string, {label: string; cls: string}> = {
  board: {label: 'BOARD', cls: 'pill-warn'},
  department: {label: 'DEPT', cls: 'pill-info'},
  incident: {label: 'INCIDENT', cls: 'pill-err'},
};
const ACCESS_BADGE: Record<string, {label: string; cls: string}> = {
  read_only: {label: 'READ-ONLY', cls: 'pill-warn'},
  restricted: {label: 'RESTRICTED', cls: 'pill-err'},
};

function orderAsTree(rows: DepartmentChannelRow[]): DepartmentChannelRow[] {
  const byParent = new Map<string | null, DepartmentChannelRow[]>();
  const ids = new Set(rows.map(r => r.id));
  for (const r of rows) {
    // A parent outside this page renders the child as a root rather than
    // dropping it.
    const key = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  const out: DepartmentChannelRow[] = [];
  const walk = (parent: string | null) => {
    for (const r of byParent.get(parent) ?? []) {
      out.push(r);
      walk(r.id);
    }
  };
  walk(null);
  return out;
}

export default function Departments() {
  const { data: channels, isLoading, error } = useDepartments();
  const rows = useMemo(() => orderAsTree(channels ?? []), [channels]);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Department Channels</div>
          <h2>Department Channels</h2>
        </div>
        <div className="page-head-right">
          <span className="pill pill-info">● {rows.length} CHANNELS</span>
        </div>
      </div>

      {isLoading && (
        <div style={{padding:32,color:'var(--tx-3)'}}>Loading channels…</div>
      )}
      {error && (
        <div style={{padding:32,color:'var(--err)'}}>
          Failed to load channels · {String((error as Error).message)}
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <div style={{padding:32,color:'var(--tx-3)'}}>
          No department channels yet. Channels are an Enterprise (messenger tier) feature; create them per department.
        </div>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div style={{
          border:'1px solid var(--bd)', borderRadius:12, overflow:'hidden',
          background:'var(--sf-1)',
          // Why: .main-area is a flex column; a direct child with a
          // non-visible overflow has its flex min-height collapsed to 0,
          // so without this it shrinks to the leftover height and clips
          // the table instead of letting the page scroll. flexShrink:0
          // keeps it at full content height so .main-area scrolls.
          flexShrink:0,
        }}>
          <table style={{width:'100%', borderCollapse:'collapse', fontSize:13}}>
            <thead>
              <tr style={{textAlign:'left', color:'var(--tx-3)', background:'var(--sf-2)'}}>
                <th style={{padding:'12px 16px', fontWeight:600}}>Channel</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Type</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Department</th>
                <th style={{padding:'12px 16px', fontWeight:600, textAlign:'right'}}>Members</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Status</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => {
                const type = TYPE_BADGE[c.channel_type];
                const access = ACCESS_BADGE[c.access];
                const depth = Math.max(0, c.level ?? 0);
                return (
                  <tr key={c.id} style={{borderTop:'1px solid var(--bd)'}}>
                    <td style={{padding:'12px 16px'}}>
                      <div style={{display:'flex', alignItems:'baseline', gap:6, paddingLeft: depth * 18}}>
                        {depth > 0 && <span style={{color:'var(--tx-3)', fontFamily:'monospace'}}>└</span>}
                        <div>
                          <div style={{fontWeight:600, color:'var(--tx-1)'}}>{c.name}</div>
                          {c.description && (
                            <div style={{color:'var(--tx-3)', fontSize:12, marginTop:2}}>{c.description}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{padding:'12px 16px'}}>
                      <span style={{display:'inline-flex', gap:6, flexWrap:'wrap'}}>
                        {type ? <span className={`pill ${type.cls}`}>{type.label}</span> : <span style={{color:'var(--tx-3)'}}>—</span>}
                        {access && <span className={`pill ${access.cls}`}>{access.label}</span>}
                      </span>
                    </td>
                    <td style={{padding:'12px 16px', color:'var(--tx-2)'}}>{c.department ?? '—'}</td>
                    <td style={{padding:'12px 16px', textAlign:'right', color:'var(--tx-2)'}}>{c.member_count}</td>
                    <td style={{padding:'12px 16px'}}>
                      <span className={`pill ${c.provisioned ? 'pill-ok' : 'pill-info'}`}>
                        {c.provisioned ? '● E2E active' : '○ Not active'}
                      </span>
                    </td>
                    <td style={{padding:'12px 16px', color:'var(--tx-3)'}}>{formatDateUtc(c.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
