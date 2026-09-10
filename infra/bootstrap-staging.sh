#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# bootstrap-staging.sh — one-shot setup for the staging EC2 host.
#
# Run this ONCE on the EC2 host (13.126.64.19) as a user with sudo:
#   curl -fsSLO https://raw.githubusercontent.com/<org>/<repo>/main/infra/bootstrap-staging.sh
#   chmod +x bootstrap-staging.sh
#   sudo AWS_REGION=ap-south-1 ./bootstrap-staging.sh
#
# What it does:
#   1. Verifies Docker + AWS CLI are installed (installs them if not).
#   2. Creates /etc/bravo/ with the right perms (0750 root:root).
#   3. Copies the systemd unit files into /etc/systemd/system/.
#   4. Reloads systemd. Does NOT start the services — env files are
#      empty until you fill them.
#   5. Reminds you to fill /etc/bravo/auth.env and /etc/bravo/messenger.env
#      then `systemctl enable --now` both services.
#
# What it does NOT do:
#   - Create ECR repos (we do that from CI / your laptop, not the host)
#   - Fill in any secrets
#   - Start the services
#   - Open firewall rules (nginx / Caddy on the host handles ingress;
#     check that 443 → 127.0.0.1:3001 and :3100 routing is configured)
#
# Idempotent — safe to re-run. Updates the unit files in place but
# never touches /etc/bravo/auth.env if it already exists.
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETC_DIR="/etc/bravo"
SYSTEMD_DIR="/etc/systemd/system"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "must run as root (use sudo)" >&2
    exit 1
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "[ok] docker present: $(docker --version)"
    return
  fi
  echo "[install] docker"
  # Debian / Ubuntu — the EC2 host is Ubuntu per the EAS env URL.
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
}

ensure_aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    echo "[ok] aws cli present: $(aws --version 2>&1)"
    return
  fi
  echo "[install] aws cli v2"
  curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update
  rm -rf /tmp/aws /tmp/awscliv2.zip
}

ensure_etc_bravo() {
  install -d -m 0750 -o root -g root "$ETC_DIR"
  # Image-tag files (one per service). The deploy workflows write the
  # fresh image tag here before `systemctl restart`. Touch with restrictive
  # perms so a non-root user can't substitute a malicious image.
  for f in auth.image messenger.image; do
    if [[ ! -e "$ETC_DIR/$f" ]]; then
      install -m 0640 -o root -g root /dev/null "$ETC_DIR/$f"
      echo "[create] $ETC_DIR/$f"
    fi
  done
  # Env-file slots — copy the example if and only if the real file
  # doesn't already exist (don't clobber filled-in secrets).
  for svc in auth messenger; do
    if [[ ! -e "$ETC_DIR/$svc.env" ]]; then
      if [[ -e "$REPO_ROOT/infra/env/$svc.env.example" ]]; then
        install -m 0640 -o root -g root "$REPO_ROOT/infra/env/$svc.env.example" "$ETC_DIR/$svc.env"
        echo "[seed] $ETC_DIR/$svc.env (from template — fill in secrets before starting the service)"
      else
        echo "[skip] $ETC_DIR/$svc.env — template not found at $REPO_ROOT/infra/env/$svc.env.example"
      fi
    else
      echo "[ok] $ETC_DIR/$svc.env exists (not overwritten)"
    fi
  done
}

install_unit() {
  local name="$1"
  local src="$REPO_ROOT/infra/systemd/$name"
  local dst="$SYSTEMD_DIR/$name"
  if [[ ! -e "$src" ]]; then
    echo "[error] systemd unit source missing: $src" >&2
    exit 1
  fi
  install -m 0644 -o root -g root "$src" "$dst"
  echo "[install] $dst"
}

reload_systemd() {
  systemctl daemon-reload
  echo "[ok] systemd daemon-reload"
}

print_next_steps() {
  cat <<'TXT'

──────────────────────────────────────────────────────────────────────
Next steps (must be done by an operator with the secrets):

  1. Fill /etc/bravo/auth.env       (see infra/env/auth.env.example)
  2. Fill /etc/bravo/messenger.env  (see infra/env/messenger.env.example)
  3. Verify Redis is running on this host (default REDIS_URL points at
     redis://127.0.0.1:6379/0). If not, install:
        sudo apt-get install -y redis-server
        sudo systemctl enable --now redis-server
  4. Configure the AWS CLI on this host so `docker pull` from ECR works:
        sudo aws configure                        # access key + region
     OR attach an EC2 instance profile with AmazonEC2ContainerRegistryReadOnly
     and remove the systemd unit's `aws ecr get-login-password` step.
  5. Run the FIRST deploy workflow from GitHub Actions:
        - deploy-migrations  (applies new Supabase migrations)
        - deploy-auth        (builds + pushes image, restarts unit)
        - deploy-messenger
        - deploy-ops-console
        - build-mobile
  6. Once the deploy workflow has written /etc/bravo/auth.image and
     /etc/bravo/messenger.image, enable the units:
        sudo systemctl enable --now bravo-auth.service
        sudo systemctl enable --now bravo-messenger.service
  7. Tail the journals to confirm clean boot:
        sudo journalctl -u bravo-auth.service -f
        sudo journalctl -u bravo-messenger.service -f
  8. Run the 5 smoke checks from DEPLOY_PLAN.md §F.
──────────────────────────────────────────────────────────────────────
TXT
}

main() {
  require_root
  ensure_docker
  ensure_aws_cli
  ensure_etc_bravo
  install_unit "bravo-auth.service"
  install_unit "bravo-messenger.service"
  reload_systemd
  print_next_steps
}

main "$@"
