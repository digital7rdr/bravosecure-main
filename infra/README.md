# Bravo Secure — Staging Infrastructure

This directory carries everything needed to deploy Bravo Secure to the staging environment **except secrets**. Secrets live in:

- **GitHub repository secrets** (used by the workflows under `.github/workflows/deploy-*.yml`)
- `/etc/bravo/*.env` on the staging EC2 host (sourced by the systemd units)
- The Vercel project for ops-console (set in the Vercel UI)
- The EAS project for mobile (set via `eas secret:create`)

**Nothing in this directory should ever contain a real secret.** The `.example` files are templates.

---

## Contents

| Path                              | Purpose                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `systemd/bravo-auth.service`      | systemd unit that runs the auth-service Docker image on EC2                    |
| `systemd/bravo-messenger.service` | systemd unit that runs the messenger-service Docker image on EC2               |
| `env/auth.env.example`            | Template for `/etc/bravo/auth.env`                                             |
| `env/messenger.env.example`       | Template for `/etc/bravo/messenger.env`                                        |
| `bootstrap-staging.sh`            | One-shot host setup script (installs Docker + AWS CLI, drops in systemd units) |
| `iam/deploy-policy.json`          | Least-privilege IAM policy for the deploy user / OIDC role                     |

For end-to-end context see `../docs/planning/DEPLOY_PLAN.md`.

---

## Deploy model in one paragraph

GitHub Actions builds Docker images on every push to `main`, pushes them to ECR, then SSHes into the EC2 staging host (`13.126.64.19`) to restart the systemd units. The systemd units read the current image tag from `/etc/bravo/<svc>.image` and the secrets from `/etc/bravo/<svc>.env`. Supabase migrations apply via the `deploy-migrations` workflow. The ops-console deploys to Vercel. Mobile builds go to EAS.

---

## What lives where

```
this repo                          GitHub Actions                 staging
─────────────                      ──────────────                 ───────
apps/auth-service/Dockerfile  ─┐
.github/workflows/deploy-auth ─┴─→  build + push to ECR  ─────→  EC2: docker pull, systemctl restart
.github/workflows/deploy-msg  ───→  build + push to ECR  ─────→  EC2: docker pull, systemctl restart
.github/workflows/deploy-migr ───→  supabase db push     ─────→  Supabase
.github/workflows/deploy-ops  ───→  vercel deploy        ─────→  Vercel (ops-staging.bravosecure.app)
.github/workflows/build-mobile───→  eas build            ─────→  EAS (preview-staging channel)
```

---

## First-time setup checklist (one-time, ~45 min)

Follow [`../FIRST_DEPLOY.md`](../FIRST_DEPLOY.md) top to bottom. The high-level order:

1. **Rotate any leaked credentials.** If an AWS key has appeared in chat / email / a screenshot, rotate it in IAM before anything else.
2. **Create accounts/projects** that don't exist yet: Sentry, Vercel, ECR.
3. **Bootstrap the EC2 host** by running `bootstrap-staging.sh` once.
4. **Fill the env files** on the host (`/etc/bravo/auth.env`, `/etc/bravo/messenger.env`).
5. **Add the GitHub repo secrets** (the workflows reference them; without them they fail loudly).
6. **Merge** the deploy branch to `main` — workflows fire automatically.
7. **Smoke test** with the 5 curls in `docs/planning/DEPLOY_PLAN.md` §F.

---

## Operating notes

### Tail the journals

```sh
sudo journalctl -u bravo-auth.service -f
sudo journalctl -u bravo-messenger.service -f
```

### Roll back to a previous image

The systemd unit reads `/etc/bravo/<svc>.image` for the tag, so a manual rollback is one line:

```sh
echo "<ECR_URI>:<previous-sha>" | sudo tee /etc/bravo/auth.image
sudo systemctl restart bravo-auth.service
```

### Force a redeploy without a code change

GitHub Actions → workflow → "Run workflow" (workflow_dispatch). Each deploy workflow accepts an `image_tag` input you can leave blank to use the current `main` SHA.

### Pause auto-deploys

Disable the workflow in the GitHub Actions tab. The systemd unit on the host keeps running the current image — nothing breaks, but new commits don't ship.

---

## Why this directory is gitignored carefully

`.env` files (without `.example`) are gitignored. Never commit them. If you ever see a real secret in a `.example` file, treat that secret as compromised and rotate it — the file's commit history is public via `git log`.
