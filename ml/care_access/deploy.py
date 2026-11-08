"""Optional artifact upload only. Existing IAM credentials; never provisions resources."""
import argparse, json
from pathlib import Path

def upload(bucket, prefix):
    import boto3
    client = boto3.client("s3")
    artifacts = Path(__file__).parent / "artifacts"
    for name in ["classifier.joblib", "clusters.joblib", "manifest.json", "classification.json", "clustering.json"]:
        client.upload_file(str(artifacts / name), bucket, prefix.rstrip("/") + "/" + name,
                           ExtraArgs={"ServerSideEncryption": "AES256"})
    print(json.dumps({"bucket": bucket, "prefix": prefix, "artifacts_uploaded": 5}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="care-access")
    args = parser.parse_args()
    upload(args.bucket, args.prefix)
