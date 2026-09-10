# `#broadcast` purge snapshot — 2026-08-20

Taken before any change, per `20260817000000_purge_legacy_workspace_broadcasts.sql`'s
mandatory-snapshot instruction. **The purge has NOT been run** — see §3.

Source query (the migration's own snapshot query, verbatim in intent):

```sql
SELECT c.id, c.org_id, c.name, c.level, c.parent_id, c.created_at
  FROM public.department_channels c
 WHERE c.is_broadcast AND c.archived_at IS NULL
   AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id)
 ORDER BY c.org_id, c.level;
```

## 1. Totals at snapshot time

| Metric                                                | Value  |
| ----------------------------------------------------- | ------ |
| `department_channels` rows                            | 173    |
| live broadcasts, ALL tenants                          | 29     |
| live broadcasts, WORKSPACE tenants (the purge target) | **18** |
| `org_workspaces`                                      | 16     |
| `is_lateral` column present                           | **NO** |

The 11-row difference between 29 and 18 is agency tenants, which the purge
deliberately does not touch.

## 2. The 18 target rows

| #   | id                                   | org_id                               | name               | level | parent_id                            | created_at          |
| --- | ------------------------------------ | ------------------------------------ | ------------------ | ----- | ------------------------------------ | ------------------- |
| 1   | 45f54641-d29a-451c-8e91-9a595324825f | 2362cc87-e924-490a-aca8-71d139092106 | `#broadcast`       | 1     | —                                    | 2026-08-04 21:57:43 |
| 2   | fa0d3c43-c2a8-4210-9af0-fb8fe961ddcf | 2b8dc53a-58a0-4481-b977-7d08563498b3 | `#broadcast`       | 1     | —                                    | 2026-08-05 06:09:53 |
| 3   | cb40a9d0-4e25-4859-8c4d-68e697a9921f | 2c13f774-8e39-44d5-be28-5fd2cbeea219 | `#broadcast`       | 1     | —                                    | 2026-08-05 06:03:59 |
| 4   | 38149a9c-7ea1-4829-9815-34e220db575f | 3165d0e1-0d3f-4d8c-be5d-a4b85d11b453 | `#broadcast`       | 1     | —                                    | 2026-08-08 09:08:29 |
| 5   | 86d5ba51-7556-48c1-a755-391b3d5de1d9 | 45f492c8-c1a2-4264-af69-986198d3fc21 | `#broadcast`       | 1     | —                                    | 2026-08-04 19:31:19 |
| 6   | 89f079c8-e374-4f0e-92a8-c7d50bfb9bdf | 608290a3-5a87-452d-8c71-7d15dccdb6a3 | `#broadcast`       | 1     | —                                    | 2026-08-08 13:59:18 |
| 7   | e26e45fc-8c0e-49c1-8d7b-4f659d063f4a | 608290a3-5a87-452d-8c71-7d15dccdb6a3 | `#broadcast`       | 2     | 335ef2f2-a109-4c2b-be63-c46f9f9d712d | 2026-08-08 14:03:17 |
| 8   | 3d53f4eb-5998-47cb-a5b9-9fd5a0fa0341 | 71c6c269-cc66-48b3-8848-8a778bc5e99e | `#broadcast`       | 1     | —                                    | 2026-08-04 21:57:43 |
| 9   | 67f670c9-e25d-4796-9638-e535fc2eda81 | 88d34848-2498-4886-ab5d-50460421d70d | `#broadcast`       | 1     | —                                    | 2026-08-04 21:57:43 |
| 10  | 950029d1-4593-467e-91c8-e0f477581956 | 961ce978-0233-4524-b672-a6f926a36890 | **`Announcement`** | 1     | —                                    | 2026-08-04 21:57:43 |
| 11  | d22c36db-7bb1-4630-a13a-1ce484d963a1 | aeb2e71e-b1a9-4709-80cc-a01bc44fe484 | `#broadcast`       | 1     | —                                    | 2026-08-09 19:11:22 |
| 12  | 54eac0b8-3086-4cb2-8342-4dff23a4115b | ccf801fc-c5de-4cde-984f-e720e3f0ecb3 | `#broadcast`       | 1     | —                                    | 2026-08-04 21:57:43 |
| 13  | ce5e0c39-ce06-428a-a034-7b80f6ee0cf8 | cf0a3de1-6767-402a-8be3-8045d778fa73 | `#broadcast`       | 1     | —                                    | 2026-08-08 07:32:35 |
| 14  | d94a8fc8-b224-4023-b98d-98fe05040c95 | d2cbe19d-3dbc-4d7a-aad2-4a50b58f2956 | `#broadcast`       | 1     | —                                    | 2026-08-04 21:57:43 |
| 15  | dc0d3667-44e2-4096-9f96-f210ad3b5bfa | d83a3403-2866-4e31-8b13-2f484e48a143 | `#broadcast`       | 1     | —                                    | 2026-08-09 04:58:52 |
| 16  | d7613e5f-4f6f-4fed-a2e2-647a5fd0ac8b | d83a3403-2866-4e31-8b13-2f484e48a143 | `#broadcast`       | 2     | ed84700d-e378-4e25-a3d8-5e9a5398d652 | 2026-08-09 05:35:22 |
| 17  | 0c8770d3-12e0-4130-ab78-b90154808694 | d83a3403-2866-4e31-8b13-2f484e48a143 | `#broadcast`       | 3     | 9883493d-c8fe-4ca0-a775-da958d194f3c | 2026-08-09 05:38:46 |
| 18  | 54a3311d-0866-4832-986d-35082485a250 | fbb5a374-f7b2-4ff0-8414-25587f7a8a6f | `#broadcast`       | 1     | —                                    | 2026-08-05 05:56:51 |

## 3. What this snapshot tells us — read before running the purge

**⚠️ Row 10 is named `Announcement`, not `#broadcast`.** An admin renamed it, which
means somebody is using it. The purge deletes on the `is_broadcast` FLAG, not on the
name, so it would destroy a channel that has been deliberately adopted. The migration's
header describes these rows as "created before that rule and by nobody" — for org
`961ce978` that is not true. **Confirm with that customer before purging.**

**15 of the 18 are PARENTLESS.** Those are the rows the G4 work surfaces under
`UNPLACED ANNOUNCEMENTS` on the admin screen, so they keep an editor door with or
without the purge. Only rows 7, 16 and 17 are parented and will nest into their
organisation once the new client ships.

**Org `d83a3403` holds three** (levels 1/2/3) and org `608290a3` holds two — these are
the workspaces where the old screen showed several identically-named cards, which is
what the founder crossed out.

**Gate 4 is still unsatisfied.** The purge must not run until a build that can create a
replacement announcement lateral is on devices. Today neither the new auth-service nor
a new APK is deployed, so purging leaves those 16 workspaces with no announcement
channel and no way to make one.

## 3b. GATE 4 MEASURED — 2026-08-20, after the auth-service deploy

Gate 4 is "a workspace can create an announcement lateral". With the migration
applied and the new auth-service live, the gate is now measurable rather than
assumed — and it is a clear NO-GO:

| Component                                                   | Value                |
| ----------------------------------------------------------- | -------------------- |
| DB accepts a lateral (`is_lateral` + trigger)               | ✅ landed 2026-08-20 |
| Workspace laterals created so far                           | **0**                |
| Replacement announcement channels in existence              | **0**                |
| Workspaces a purge would leave with NO announcement channel | **15 of 16**         |

The capability EXISTS server-side but has never been EXERCISED, because no build
on any device can reach it yet. Purging today destroys the only announcement
channel 15 of 16 workspaces have, with nothing able to replace it.

Gate 4 clears only when a device build has demonstrably created one — at which
point `replacement_announcements` above becomes non-zero. Re-run that query as
the gate check; do not substitute "the APK shipped" for it.

## 4. Re-take before the purge

This snapshot is informational. Row membership can change (a workspace created after
2026-08-20 gets no new `#broadcast`, but an archive/unarchive moves rows in and out),
so **re-run the query immediately before the purge** and assert the deleted count
equals that fresh snapshot — which the migration's own `ROW_COUNT` assertion does.
