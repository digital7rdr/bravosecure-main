# Archived workflows

Moved out of `.github/workflows/` on 2026-09-11 when the project moved to
`digital7rdr/bravosecure-main` and production on bravosecure.cloud. None of
these run; they are kept as reference for what CI used to do.

Why they were archived rather than fixed in place:

| Workflow | Trigger | Why it must not run here |
| --- | --- | --- |
| `deploy-staging.yml` | push | SSHes to the decommissioned Contabo box (94.136.184.52) |
| `deploy-migrations.yml` | push | applies migrations to the OLD hosted Supabase project |
| `mirror-to-client.yml` | push | mirrors the source to a client repository |
| `build-mobile.yml` | push | bakes the old sslip.io staging URLs into the APK |
| `static.yml` | push | publishes to GitHub Pages |
| `mutation.yml`, `flake-watch.yml` | schedule | crypto mutation/flake runs — expensive, revisit |
| `ci.yml`, `supply-chain.yml`, `bundle-size.yml`, `pr-analysis.yml`, `labeler.yml` | PR/push | sound, but need the new repo's secrets and a `workflow`-scoped token to add |

To reinstate one: copy it back to `.github/workflows/`, repoint hosts and
secrets, and push with a token that carries the `workflow` scope (GitHub
refuses workflow changes from tokens without it). Start with `ci.yml`
(typecheck + tests) and `supply-chain.yml`; production deploys are done
from the box with `deploy/production/deploy.sh`, not from CI.
