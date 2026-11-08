"""Warm Python inference; optional AWS Lambda/S3 hooks, no cloud provisioning."""
from __future__ import annotations
import argparse, hmac, json, os
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import joblib

@lru_cache(maxsize=1)
def classifier():
    path = Path(os.environ.get("CARE_ACCESS_MODEL_PATH", Path(__file__).parent / "artifacts/classifier.joblib"))
    if not path.exists() and os.environ.get("CARE_ACCESS_MODEL_BUCKET"):
        import boto3
        path = Path("/tmp/care-access-classifier.joblib")
        boto3.client("s3").download_file(os.environ["CARE_ACCESS_MODEL_BUCKET"], os.environ.get("CARE_ACCESS_MODEL_KEY", "care-access/classifier.joblib"), str(path))
    # Only load artifacts produced by this notebook or the trusted deployment bucket.
    return joblib.load(path)

def classify(payload):
    texts = payload.get("texts") if isinstance(payload, dict) else None
    if not isinstance(texts, list) or not 1 <= len(texts) <= 20 or any(not isinstance(text, str) or not text.strip() or len(text) > 2000 for text in texts):
        raise ValueError("texts must contain 1–20 nonempty strings, each at most2000 characters")
    model = classifier()
    predictions = model.predict(texts)
    known_tokens = model.named_steps["tfidf"].transform(texts).getnnz(axis=1)
    return {"predictions": [{"category": str(category) if known else "Unknown", "scope": "service type only"} for category, known in zip(predictions, known_tokens)], "limitations": "No claims of effectiveness, quality, availability or eligibility"}

def lambda_handler(event, context):
    try:
        token = os.environ.get("CARE_ACCESS_INFERENCE_TOKEN")
        if token:
            headers = {k.lower(): str(v) for k, v in (event.get("headers") or {}).items()}
            if not hmac.compare_digest(headers.get("authorization", ""), "Bearer " + token):
                return {"statusCode": 401, "body": json.dumps({"error": "unauthorized"})}
        if isinstance(event, dict) and isinstance(event.get("body"), str) and len(event["body"].encode()) > 50_000:
            raise ValueError("invalid_input")
        payload = json.loads(event["body"]) if isinstance(event, dict) and isinstance(event.get("body"), str) else event
        return {"statusCode": 200, "headers": {"Content-Type": "application/json"}, "body": json.dumps(classify(payload))}
    except ValueError:
        return {"statusCode": 400, "body": json.dumps({"error": "invalid_input"})}
    except Exception:
        return {"statusCode": 503, "body": json.dumps({"error": "model_unavailable"})}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/classify": self.send_error(404); return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 50_000: raise ValueError("invalid_input")
            result = lambda_handler({"body": self.rfile.read(size).decode("utf8"), "headers": dict(self.headers)}, None)
        except (ValueError, UnicodeError): result = {"statusCode": 400, "body": '{"error":"invalid_input"}'}
        body = result["body"].encode(); self.send_response(result["statusCode"])
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--port", type=int, default=8091); args = parser.parse_args()
    classifier()  # warm before accepting requests; never spawn/train per request
    print(f"Care-access classifier ready on 127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
