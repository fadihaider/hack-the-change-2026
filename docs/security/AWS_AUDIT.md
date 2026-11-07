# AWS security review

Requested by Haris on 2026-11-07. This is a configuration review with explicit evidence gaps, not a certification that the application or account is safe.

## Current evidence

- The local AWS audit is **BLOCKED**: this Mac has no AWS CLI, profile or credentials. No live resource was marked as checked. The local JSON result is in ignored `.board/aws-security-local.json`.
- The tracked-text and Git-history credential-pattern scan returned **NO_MATCHES**. This heuristic does not inspect untracked/private env files and cannot prove the absence of secrets.
- The production dependency advisory check (`npm audit --omit=dev`) returned zero known vulnerabilities at the time of review.
- The read-only audit has offline regression coverage for missing/denied access, redacted errors, public database ingress, broad permissions, trust scoping, TLS policies and upload-version retention. Those tests do not inspect AWS.
- Existing token encryption, owner-bound AAD, exact-item approval revisions and mocked authorization tests are useful code controls. Live SQL authorization, OAuth, HTTP route composition and runtime secret loading are still pending their owners' deployment evidence.

## Run with existing AWS access

Fadi owns deployed infrastructure. Run this on the authenticated machine using an existing profile with the required read permissions. Do not create a key or share credentials for this audit.

```bash
python3 tools/aws-security-audit.py \
  --region us-east-2 \
  --profile EXISTING_PROFILE \
  --expected-account DEPLOYMENT_ACCOUNT_ID \
  --bucket ACTUAL_UPLOADS_BUCKET \
  --cluster ACTUAL_CLUSTER_ID \
  --app-id ACTUAL_AMPLIFY_APP_ID \
  --compute-role ACTUAL_RUNTIME_ROLE_NAME
```

Omit `--profile` when the existing AWS credential chain already selects the correct session. Resource identifiers above are placeholders; the expected account must be the deployment account's 12-digit ID. No value is inferred from development defaults. Resource reads stop if the declared account is missing, mismatched, or the session is root. The tool performs allowlisted read operations only; it cannot change permissions, expose a resource, provision infrastructure or call Secrets Manager `GetSecretValue`. Amplify metadata can contain env values, so raw AWS output is processed in memory and never printed by the tool. Reports contain check status and fixed explanations, not provider payloads or credentials.

Exit 0 means the selected checks passed; exit 1 means **FAIL** or **BLOCKED**. Missing resources, inaccessible APIs and unknown fields are not success. A FAIL is a conservative baseline finding for owner review, not proof that an exploit is possible. The runtime-policy lint does not calculate effective IAM permissions or prove least privilege.

The selected baseline checks cover:

- S3: all four public-access blocks, public policy/ACL grants, default encryption, non-TLS denial for bucket and objects, upload expiry within 14 days, and noncurrent-version expiry when versioning is enabled or suspended.
- Aurora: encryption, private instances, no internet PostgreSQL ingress over IPv4/IPv6, deletion protection, automated backups, and no public restore permission on manual cluster snapshots.
- Amplify/IAM: no secret-like env names at app/branch level, no privileged preview/non-production branches, exact audited runtime role ARN, Amplify trust scoped to the account and production branch, and obvious broad/admin/Marketplace runtime grants.

Fadi should fix failed baseline checks in the infrastructure change, rerun the audit and post the summarized result on issue #29. Keep full reports local if they contain internal resource context. Haris reviews the evidence before security sign-off. Do not remove a provisioning administrator's access blindly: establish and test the scoped runtime role and an account-owner recovery path first, then remove unneeded administrator grants and persistent credentials through the owner.

## Checks still requiring live or manual evidence

Verify temporary/federated credentials and MFA for humans; root protection; runtime use of temporary role credentials; scoped secret/KMS access; logging and monitoring; no secret material in build artifacts, client bundles or application logs; owner-scoped SQL and response-token access; authenticated/origin-checked routes; rate limits and cost controls. The tool does not verify these. Do not use real medical records or claim regulatory compliance from this review.

Current provisioning `AdministratorAccess` was reported on the team board; it is not proof of current effective permissions and must never be assumed suitable for app runtime. Runtime role policy and live account protections remain unverified until Fadi provides read-only evidence.

## Repeatable local checks

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/security -v
python3 tools/scan-tracked-secrets.py --history
npm audit --omit=dev
```

The scanner reports paths/rule names only. A match needs review; never paste the matched value into an issue. If a real exposed credential is confirmed, revoke/rotate it through the account owner and remove it from history as a separately reviewed change.

## Official guidance used

- [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html): temporary credentials, MFA and least privilege.
- [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html): account/bucket protection and all four settings.
- [Aurora security best practices](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_BestPractices.Security.html): limited privileges, secrets and monitoring.
- [Amplify SSR compute roles](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html): separate least-privilege runtime access.
- [Amplify confused-deputy prevention](https://docs.aws.amazon.com/amplify/latest/userguide/cross-service-confused-deputy-prevention.html): account and branch ARN trust conditions.
