#!/usr/bin/env pwsh
# Sets a "ruleset" on `main` so it requires CI green + a PR before merge.
# Uses the rulesets API (free on private repos), not classic branch
# protection (which requires GitHub Pro on private repos).
#
# Requires: gh CLI authenticated (run `gh auth login` first).
#
# What this enforces on `main`:
#   - PR required (no direct pushes)
#   - All listed CI status checks must pass before merge
#   - Branch must be up-to-date before merge (strict)
#   - Force pushes blocked, branch deletion blocked

$ErrorActionPreference = 'Stop'

$repo = 'omnidevxstudiobit/Bravo_Secure'

# Required status check contexts. These must match the *check name* GitHub sees.
# To find names: open a recent run and the job name in the UI is the context.
$requiredChecks = @(
    'TypeScript',
    'ESLint',
    'Jest (app)',
    'Jest (messenger-crypto)',
    'Jest (booking)',
    'Secret Scan (gitleaks)',
    'Bundle size budget',
    'Generate SBOM (CycloneDX)',
    'OSV vulnerability scan'
)

$ruleset = @{
    name = 'main-protection'
    target = 'branch'
    enforcement = 'active'
    conditions = @{
        ref_name = @{
            include = @('refs/heads/main')
            exclude = @()
        }
    }
    rules = @(
        @{ type = 'deletion' }
        @{ type = 'non_fast_forward' } # blocks force push
        @{
            type = 'pull_request'
            parameters = @{
                require_code_owner_review = $false
                require_last_push_approval = $false
                required_approving_review_count = 0
                required_review_thread_resolution = $true
                dismiss_stale_reviews_on_push = $false
            }
        }
        @{
            type = 'required_status_checks'
            parameters = @{
                strict_required_status_checks_policy = $true
                required_status_checks = $requiredChecks | ForEach-Object {
                    @{ context = $_ }
                }
            }
        }
    )
    bypass_actors = @()
}

$body = $ruleset | ConvertTo-Json -Depth 10 -Compress

Write-Host "Applying ruleset 'main-protection' to $repo..." -ForegroundColor Cyan

# Check if ruleset already exists; update vs create.
$existing = gh api "repos/$repo/rulesets" --jq '.[] | select(.name=="main-protection") | .id' 2>$null

if ($existing) {
    Write-Host "Updating existing ruleset id=$existing" -ForegroundColor Yellow
    $body | gh api --method PUT "repos/$repo/rulesets/$existing" --input -
} else {
    Write-Host "Creating new ruleset" -ForegroundColor Green
    $body | gh api --method POST "repos/$repo/rulesets" --input -
}

Write-Host "Done. Verify in GitHub: https://github.com/$repo/rules" -ForegroundColor Green
