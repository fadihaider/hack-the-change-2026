import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).resolve().parents[2] / "tools/aws-security-audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class SecurityAuditTests(unittest.TestCase):
    def args(self, **changes):
        return argparse.Namespace(**{**dict(region="us-east-2", profile=None, expected_account="123456789012", bucket=None, cluster=None, app_id=None, compute_role=None, branch="main"), **changes})

    def test_mutations_are_not_callable(self):
        tool = audit.Audit(self.args(), runner=lambda *a, **k: self.fail("must not execute"))
        with self.assertRaises(ValueError):
            tool.read("s3api", "put-public-access-block")
        with self.assertRaises(ValueError):
            tool.read("secretsmanager", "get-secret-value")

    def test_missing_cli_is_blocked_not_safe(self):
        def missing(*args, **kwargs):
            raise FileNotFoundError()
        report = audit.Audit(self.args(), runner=missing).run()
        self.assertEqual(report["status"], "BLOCKED")
        self.assertNotIn("PASS", [c["status"] for c in report["checks"]])

    def test_api_errors_are_redacted(self):
        def denied(*args, **kwargs):
            return subprocess.CompletedProcess([], 1, "", "An error occurred (AccessDenied) secret-example-not-for-output")
        report = json.dumps(audit.Audit(self.args(), runner=denied).run())
        self.assertIn("AccessDenied", report)
        self.assertNotIn("secret-example-not-for-output", report)

    def test_resource_absence_never_passes(self):
        def identity(*args, **kwargs):
            return subprocess.CompletedProcess([], 0, json.dumps({"Account": "123456789012", "Arn": "arn:aws:sts::123456789012:assumed-role/audit/session"}), "")
        report = audit.Audit(self.args(), runner=identity).run()
        self.assertEqual(report["status"], "BLOCKED")
        self.assertTrue(any(c["check"] == "aurora.resource" and c["status"] == "BLOCKED" for c in report["checks"]))

    def test_wrong_account_stops_before_resource_reads(self):
        calls = []
        def identity(command, **kwargs):
            calls.append(command[1:3])
            return subprocess.CompletedProcess([], 0, json.dumps({"Account": "999999999999", "Arn": "arn:aws:sts::999999999999:assumed-role/audit/session"}), "")
        report = audit.Audit(self.args(bucket="fixture"), runner=identity).run()
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(calls, [["sts", "get-caller-identity"]])

    def test_tagged_lifecycle_does_not_cover_every_upload(self):
        rule = {"Status": "Enabled", "Filter": {"Prefix": "uploads/"}, "Expiration": {"Days": 14}}
        self.assertTrue(audit.bounded_expiry([rule]))
        self.assertFalse(audit.bounded_expiry([{**rule, "Filter": {"Tag": {"Key": "delete", "Value": "yes"}}}]))
        self.assertFalse(audit.bounded_expiry([{**rule, "Expiration": {"Days": 15}}]))
        self.assertFalse(audit.bounded_expiry([{**rule, "Status": "Disabled"}]))

    def test_current_expiry_does_not_claim_version_cleanup(self):
        rule = {"Status": "Enabled", "Prefix": "uploads/", "Expiration": {"Days": 14}}
        self.assertFalse(audit.bounded_expiry([rule], noncurrent=True))
        self.assertTrue(audit.bounded_expiry([{**rule, "NoncurrentVersionExpiration": {"NoncurrentDays": 14}}], noncurrent=True))

    def test_tls_deny_must_cover_bucket_and_objects(self):
        statement = {"Effect": "Deny", "Principal": "*", "Action": "s3:*", "Resource": ["arn:aws:s3:::fixture", "arn:aws:s3:::fixture/*"], "Condition": {"Bool": {"aws:SecureTransport": "false"}}}
        self.assertTrue(audit.denies_plain_http({"Statement": statement}, "fixture"))
        self.assertFalse(audit.denies_plain_http({"Statement": {**statement, "Effect": "Allow"}}, "fixture"))
        self.assertFalse(audit.denies_plain_http({"Statement": {**statement, "Resource": "arn:aws:s3:::fixture"}}, "fixture"))

    def test_internet_ingress_includes_ipv6_and_all_ports(self):
        self.assertTrue(audit.internet_postgres({"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "Ipv6Ranges": [{"CidrIpv6": "::/0"}]}))
        self.assertTrue(audit.internet_postgres({"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}))
        self.assertFalse(audit.internet_postgres({"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}))

    def test_admin_and_global_resources_are_not_runtime_scoping(self):
        self.assertTrue(audit.broad_runtime_grants({"Statement": {"Effect": "Allow", "Action": "*", "Resource": "*"}}))
        self.assertTrue(audit.broad_runtime_grants({"Statement": {"Effect": "Allow", "NotAction": "iam:DeleteUser", "Resource": "*"}}))
        self.assertEqual(audit.broad_runtime_grants({"Statement": {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::fixture/uploads/*"}}), [])

    def test_passrole_requires_exact_role_and_service_condition(self):
        statement = {"Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::123456789012:role/dispatcher", "Condition": {"StringEquals": {"iam:PassedToService": "scheduler.amazonaws.com"}}}
        self.assertEqual(audit.broad_runtime_grants({"Statement": statement}), [])
        self.assertTrue(audit.broad_runtime_grants({"Statement": {**statement, "Resource": "arn:aws:iam::123456789012:role/*"}}))

    def test_compute_trust_binds_account_and_production_branch(self):
        app = "arn:aws:amplify:us-east-2:123456789012:apps/fixture"
        statement = {"Effect": "Allow", "Principal": {"Service": "amplify.amazonaws.com"}, "Action": "sts:AssumeRole", "Condition": {"StringEquals": {"aws:SourceAccount": "123456789012"}, "ArnLike": {"aws:SourceArn": app + "/branches/main"}}}
        self.assertTrue(audit.scoped_amplify_trust({"Statement": statement}, "123456789012", app, "main"))
        self.assertFalse(audit.scoped_amplify_trust({"Statement": {**statement, "Principal": "*"}}, "123456789012", app, "main"))
        self.assertFalse(audit.scoped_amplify_trust({"Statement": statement}, "999999999999", app, "main"))
        self.assertFalse(audit.scoped_amplify_trust({"Statement": statement}, "123456789012", app, "preview"))


if __name__ == "__main__":
    unittest.main()
