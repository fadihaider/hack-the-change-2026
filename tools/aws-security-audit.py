#!/usr/bin/env python3
"""Read-only checks. No GetSecretValue calls, raw env output or AWS mutations."""
import argparse
import datetime
import json
import re
import subprocess

READ_OPERATIONS = {
    ("sts", "get-caller-identity"),
    ("s3api", "get-public-access-block"), ("s3api", "get-bucket-policy-status"),
    ("s3api", "get-bucket-acl"), ("s3api", "get-bucket-encryption"),
    ("s3api", "get-bucket-policy"), ("s3api", "get-bucket-lifecycle-configuration"),
    ("s3api", "get-bucket-versioning"),
    ("rds", "describe-db-clusters"), ("rds", "describe-db-instances"),
    ("rds", "describe-db-cluster-snapshots"), ("rds", "describe-db-cluster-snapshot-attributes"),
    ("ec2", "describe-security-groups"),
    ("iam", "get-role"), ("iam", "list-attached-role-policies"),
    ("iam", "list-role-policies"), ("iam", "get-role-policy"),
    ("iam", "get-policy"), ("iam", "get-policy-version"),
    ("amplify", "get-app"), ("amplify", "list-branches"),
}


def values(value):
    return value if isinstance(value, list) else [value] if value is not None else []


def statements(document):
    return values(document.get("Statement", [])) if isinstance(document, dict) else []


def uploads_rule(rule):
    """A tag-constrained rule cannot establish retention for every upload."""
    if rule.get("Status") != "Enabled":
        return False
    filt = rule.get("Filter", {})
    if "Tag" in filt or "And" in filt or any(k not in ("Prefix",) for k in filt):
        return False
    prefix = filt.get("Prefix", rule.get("Prefix", ""))
    return isinstance(prefix, str) and "uploads/".startswith(prefix)


def bounded_expiry(rules, noncurrent=False):
    field = "NoncurrentVersionExpiration" if noncurrent else "Expiration"
    day_field = "NoncurrentDays" if noncurrent else "Days"
    return any(uploads_rule(r) and isinstance(r.get(field, {}).get(day_field), int)
               and 0 < r[field][day_field] <= 14 for r in rules)


def denies_plain_http(policy, bucket):
    resources = {f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"}
    for s in statements(policy):
        condition = s.get("Condition", {}).get("Bool", {})
        principal = s.get("Principal")
        if (s.get("Effect") == "Deny" and principal in ("*", {"AWS": "*"})
                and any(a in ("*", "s3:*") for a in values(s.get("Action")))
                and condition.get("aws:SecureTransport") in (False, "false")
                and ("*" in values(s.get("Resource")) or resources.issubset(set(values(s.get("Resource")))))):
            return True
    return False


def internet_postgres(rule):
    protocol = str(rule.get("IpProtocol"))
    port = protocol == "-1" or (protocol in ("tcp", "6")
                              and rule.get("FromPort", 65536) <= 5432 <= rule.get("ToPort", -1))
    return port and (any(r.get("CidrIp") == "0.0.0.0/0" for r in rule.get("IpRanges", []))
                     or any(r.get("CidrIpv6") == "::/0" for r in rule.get("Ipv6Ranges", [])))


def broad_runtime_grants(document):
    """Conservative lint, not an effective-permissions or least-privilege proof."""
    findings = []
    for s in statements(document):
        if s.get("Effect") != "Allow":
            continue
        actions = values(s.get("Action"))
        if "NotAction" in s or "NotResource" in s or not actions:
            findings.append("Allow uses a complement or lacks explicit actions")
        for action in actions:
            if not isinstance(action, str):
                findings.append("Unrecognized action format")
            elif "*" in action or "?" in action:
                findings.append("Wildcard Allow action")
            elif action.startswith(("iam:", "organizations:", "account:", "aws-marketplace:")):
                if not (action == "iam:PassRole" and values(s.get("Resource")) and not any("*" in r or "?" in r for r in values(s.get("Resource")))
                        and s.get("Condition", {}).get("StringEquals", {}).get("iam:PassedToService") == "scheduler.amazonaws.com"):
                    findings.append("Runtime provisioning, identity or Marketplace permission")
        if "*" in values(s.get("Resource")):
            findings.append("Unscoped Allow resource requires explicit review")
    return sorted(set(findings))


def scoped_amplify_trust(document, account, app_arn, branch):
    allowed = [s for s in statements(document) if s.get("Effect") == "Allow"]
    if not account or not app_arn or not allowed:
        return False
    expected_arn = f"{app_arn}/branches/{branch}"
    for s in allowed:
        principal = s.get("Principal", {})
        if not isinstance(principal, dict) or set(principal) != {"Service"}:
            return False
        if set(values(principal["Service"])) != {"amplify.amazonaws.com"}:
            return False
        if set(values(s.get("Action"))) != {"sts:AssumeRole"}:
            return False
        conditions = {}
        for op, entries in s.get("Condition", {}).items():
            if op in ("StringEquals", "ArnEquals", "ArnLike"):
                conditions.update(entries)
        if values(conditions.get("aws:SourceAccount")) != [account]:
            return False
        if values(conditions.get("aws:SourceArn")) != [expected_arn]:
            return False
    return True


class Audit:
    def __init__(self, args, runner=subprocess.run):
        self.args, self.runner, self.checks = args, runner, []
        self.expected_compute_arn = None

    def add(self, name, verdict, detail):
        self.checks.append({"check": name, "status": "BLOCKED" if verdict is None else "PASS" if verdict else "FAIL", "detail": detail})

    def read(self, service, operation, *parameters, absent=()):
        if (service, operation) not in READ_OPERATIONS:
            raise ValueError("Mutation or unknown operation is forbidden")
        cmd = ["aws", service, operation, *parameters, "--region", self.args.region, "--output", "json", "--no-cli-pager"]
        if self.args.profile:
            cmd += ["--profile", self.args.profile]
        try:
            result = self.runner(cmd, capture_output=True, text=True, timeout=45)
        except (OSError, subprocess.TimeoutExpired):
            self.add(f"{service}.{operation}.read", None, "CLI unavailable or read timed out; no raw error output retained")
            return None
        if result.returncode:
            match = re.search(r"An error occurred \(([A-Za-z0-9_.-]+)\)", result.stderr)
            code = match.group(1) if match else "unavailable"
            if code in absent:
                return {}
            self.add(f"{service}.{operation}.read", None, f"Read unverified: {code}; provider text omitted")
            return None
        try:
            data = json.loads(result.stdout)
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, TypeError):
            self.add(f"{service}.{operation}.read", None, "Unexpected response; raw output omitted")
            return None

    def bucket(self):
        if not self.args.bucket:
            self.add("s3.resource", None, "Supply the actual uploads bucket name")
            return
        params = ("--bucket", self.args.bucket)
        block = self.read("s3api", "get-public-access-block", *params)
        if block is not None:
            keys = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]
            self.add("s3.public_access_block", all(block.get("PublicAccessBlockConfiguration", {}).get(k) is True for k in keys), "All four bucket-level public access blocks must be true")
        status = self.read("s3api", "get-bucket-policy-status", *params, absent=("NoSuchBucketPolicy",))
        if status is not None:
            public = status.get("PolicyStatus", {}).get("IsPublic")
            self.add("s3.nonpublic_policy", True if status == {} else public is False if isinstance(public, bool) else None, "Policy must not be public; ACLs are checked separately")
        acl = self.read("s3api", "get-bucket-acl", *params)
        if acl is not None:
            grants = acl.get("Grants")
            self.add("s3.nonpublic_acl", not any(g.get("Grantee", {}).get("URI", "").endswith(("/AllUsers", "/AuthenticatedUsers")) for g in grants) if isinstance(grants, list) else None, "No public or all-AWS-user ACL grants")
        enc = self.read("s3api", "get-bucket-encryption", *params)
        if enc is not None:
            rules = enc.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
            self.add("s3.default_encryption", bool(rules) and all(r.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm") in ("AES256", "aws:kms", "aws:kms:dsse") for r in rules), "Default server-side encryption must be configured")
        policy = self.read("s3api", "get-bucket-policy", *params, absent=("NoSuchBucketPolicy",))
        if policy is not None:
            try:
                document = json.loads(policy.get("Policy", "{}"))
                self.add("s3.tls_required", denies_plain_http(document, self.args.bucket), "Explicitly deny non-TLS access to the bucket and objects")
            except (TypeError, ValueError):
                self.add("s3.tls_required", None, "Bucket policy could not be evaluated")
        lifecycle = self.read("s3api", "get-bucket-lifecycle-configuration", *params, absent=("NoSuchLifecycleConfiguration",))
        versioning = self.read("s3api", "get-bucket-versioning", *params)
        if lifecycle is not None:
            rules = lifecycle.get("Rules", [])
            self.add("s3.uploads_retention", bounded_expiry(rules), "An enabled, untagged rule must expire uploads/ within 14 days")
            if versioning is None:
                self.add("s3.old_versions_retention", None, "Versioning status unavailable")
            elif versioning.get("Status") in ("Enabled", "Suspended"):
                self.add("s3.old_versions_retention", bounded_expiry(rules, True), "Noncurrent upload versions must expire within 14 days too")

    def database(self):
        if not self.args.cluster:
            self.add("aurora.resource", None, "Supply the actual Aurora cluster identifier")
            return
        response = self.read("rds", "describe-db-clusters", "--db-cluster-identifier", self.args.cluster)
        clusters = response.get("DBClusters", []) if response is not None else []
        if not clusters:
            self.add("aurora.exists", None, "Cluster not returned; absence is not a security pass")
            return
        cluster = clusters[0]
        self.add("aurora.encrypted", cluster.get("StorageEncrypted"), "Cluster storage and backups must be encrypted")
        self.add("aurora.deletion_protection", cluster.get("DeletionProtection"), "Deletion protection required until deliberate teardown")
        retention = cluster.get("BackupRetentionPeriod")
        self.add("aurora.backups", retention >= 1 if isinstance(retention, int) else None, "At least one day of automated backups")
        members = cluster.get("DBClusterMembers", [])
        if not members:
            self.add("aurora.private_instances", None, "No instances returned; do not treat an empty list as private")
        for member in members:
            instance = self.read("rds", "describe-db-instances", "--db-instance-identifier", member["DBInstanceIdentifier"])
            rows = instance.get("DBInstances", []) if instance is not None else []
            public = rows[0].get("PubliclyAccessible") if rows else None
            self.add("aurora.private_instance", public is False if isinstance(public, bool) else None, "Every database instance must disable public accessibility")
        groups = [g["VpcSecurityGroupId"] for g in cluster.get("VpcSecurityGroups", [])]
        if not groups:
            self.add("aurora.security_groups", None, "No database security groups returned")
        else:
            response = self.read("ec2", "describe-security-groups", "--group-ids", *groups)
            if response is not None:
                rows = response.get("SecurityGroups", [])
                self.add("aurora.no_internet_postgres", not any(internet_postgres(r) for g in rows for r in g.get("IpPermissions", [])) if len(rows) == len(groups) else None, "No IPv4/IPv6 internet ingress to PostgreSQL or all ports")
        response = self.read("rds", "describe-db-cluster-snapshots", "--db-cluster-identifier", self.args.cluster, "--snapshot-type", "manual")
        if response is not None:
            snapshots = response.get("DBClusterSnapshots")
            if not isinstance(snapshots, list):
                self.add("aurora.private_snapshots", None, "Snapshot inventory unavailable")
            elif not snapshots:
                self.add("aurora.private_snapshots", True, "No manual snapshots returned for this cluster")
            for snapshot in snapshots if isinstance(snapshots, list) else []:
                attrs = self.read("rds", "describe-db-cluster-snapshot-attributes", "--db-cluster-snapshot-identifier", snapshot["DBClusterSnapshotIdentifier"])
                if attrs is not None:
                    rows = attrs.get("DBClusterSnapshotAttributesResult", {}).get("DBClusterSnapshotAttributes")
                    self.add("aurora.private_snapshot", not any(r.get("AttributeName") == "restore" and "all" in r.get("AttributeValues", []) for r in rows) if isinstance(rows, list) else None, "Manual snapshots must not allow public restore")

    def amplify(self):
        if not self.args.app_id:
            self.add("amplify.resource", None, "Supply the actual Amplify app identifier")
            return None
        response = self.read("amplify", "get-app", "--app-id", self.args.app_id)
        app = response.get("app") if response is not None else None
        if not app:
            self.add("amplify.exists", None, "App not returned")
            return None
        response = self.read("amplify", "list-branches", "--app-id", self.args.app_id)
        branches = response.get("branches", []) if response is not None else []
        sensitive = re.compile(r"SECRET|PASSWORD|TOKEN|APP_ENC_KEY|ELEVENLABS_API_KEY|AWS_ACCESS_KEY|AWS_SESSION|DATABASE_URL", re.I)
        for label, item in [("app", app), *((b.get("branchName", "branch"), b) for b in branches)]:
            env = item.get("environmentVariables", {})
            suspect = [key for key in env if sensitive.search(key)]
            self.add(f"amplify.{label}.no_secret_env_names", not suspect, "No secret-like env key names; values are never included in this report")
        if response is None:
            self.add("amplify.branch_role_scope", None, "Could not enumerate branches")
        else:
            main = [b for b in branches if b.get("branchName") == self.args.branch]
            previews = app.get("enableAutoBranchCreation", False) or any(b.get("enablePullRequestPreview") for b in branches)
            other_roles = any(b.get("computeRoleArn") or app.get("computeRoleArn") for b in branches if b.get("branchName") != self.args.branch)
            self.add("amplify.branch_role_scope", bool(main) and not other_roles and not (previews and app.get("computeRoleArn")), "No runtime role for non-production branches; app-wide role disallowed with previews")
            expected = main[0].get("computeRoleArn") or app.get("computeRoleArn") if main else None
            self.expected_compute_arn = expected
        return app.get("appArn")

    def role(self, account, app_arn):
        if not self.args.compute_role:
            self.add("iam.runtime_role", None, "Supply the actual SSR compute role name")
            return
        response = self.read("iam", "get-role", "--role-name", self.args.compute_role)
        role = response.get("Role") if response is not None else None
        if role:
            self.add("iam.scoped_compute_trust", scoped_amplify_trust(role.get("AssumeRolePolicyDocument", {}), account, app_arn, self.args.branch) if account and app_arn else None, "AssumeRole trust restricted to Amplify and the account's production branch ARN")
            self.add("amplify.expected_compute_role", role.get("Arn") == self.expected_compute_arn if self.expected_compute_arn and role.get("Arn") else None, "Full runtime role ARN must match the role whose policies were audited")
        else:
            self.add("iam.runtime_role_metadata", None, "Runtime role metadata not returned")
        documents = []
        complete = True
        attached = self.read("iam", "list-attached-role-policies", "--role-name", self.args.compute_role)
        inline = self.read("iam", "list-role-policies", "--role-name", self.args.compute_role)
        if attached is None or inline is None:
            complete = False
        for policy in (attached or {}).get("AttachedPolicies", []):
            metadata = self.read("iam", "get-policy", "--policy-arn", policy["PolicyArn"])
            version = (metadata or {}).get("Policy", {}).get("DefaultVersionId")
            result = self.read("iam", "get-policy-version", "--policy-arn", policy["PolicyArn"], "--version-id", version) if version else None
            document = (result or {}).get("PolicyVersion", {}).get("Document")
            if document is None:
                complete = False
            else:
                documents.append(document)
        for name in (inline or {}).get("PolicyNames", []):
            result = self.read("iam", "get-role-policy", "--role-name", self.args.compute_role, "--policy-name", name)
            document = (result or {}).get("PolicyDocument")
            if document is None:
                complete = False
            else:
                documents.append(document)
        findings = sorted(set(f for doc in documents for f in broad_runtime_grants(doc)))
        self.add("iam.runtime_policy_lint", not findings if complete and documents else None, "; ".join(findings) if findings else "No obvious broad grants found; effective permissions still require review")

    def run(self):
        identity = self.read("sts", "get-caller-identity")
        if identity is None:
            self.add("audit.credentials", None, "Authenticate with an existing read-only profile; never paste credentials into reports")
        else:
            arn = identity.get("Arn", "")
            self.add("audit.not_root", not arn.endswith(":root") if arn else None, "Audit must not run as root")
            expected = self.args.expected_account
            self.add("audit.expected_account", identity.get("Account") == expected if expected else None, "Caller must match the declared deployment account; no resource reads on mismatch or missing target")
            if expected and identity.get("Account") == expected and arn and not arn.endswith(":root"):
                self.bucket()
                self.database()
                app_arn = self.amplify()
                self.role(identity.get("Account"), app_arn)
        statuses = {check["status"] for check in self.checks}
        status = "FAIL" if "FAIL" in statuses else "BLOCKED" if "BLOCKED" in statuses else "PASS"
        return {"status": status, "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "region": self.args.region, "checks": self.checks,
                "limits": "Selected configuration checks only, not a safety certification. No GetSecretValue calls; environment values and raw responses are not emitted. Does not prove SQL authorization, MFA, CloudTrail, KMS policies, effective IAM, artifact secrecy, or runtime behavior."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-account")
    parser.add_argument("--bucket")
    parser.add_argument("--cluster")
    parser.add_argument("--app-id")
    parser.add_argument("--compute-role")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()
    if args.expected_account and not re.fullmatch(r"[0-9]{12}", args.expected_account):
        parser.error("expected account must contain 12 digits")
    report = Audit(args).run()
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
