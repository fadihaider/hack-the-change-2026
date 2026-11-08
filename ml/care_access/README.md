# Care Access Intelligence MVP

**Branch held unmerged at Ali's request.** This is an additive module: it does not
change the current app navigation, backend runtime, database schema or AI services.
Open `/care-access` in this branch to use the map. No Python server, cloud account
or model training is required for the map: its 1 MB public snapshot is included.

## Recorded notebook results

The executed [notebook](../../notebooks/care_access.ipynb) ran 14 small classifier
parameter combinations with three training-only CV folds in **50.55 seconds**.
It uses 3,150 unique normalized facility names, at most350 per published class,
with 2,520 training and 630 held-out examples. Normalized-name groups do not cross
the split. Features are name-only TF-IDF/SVD; published categories, geography,
source classes and identifiers are excluded. Related brand wording can still
overlap, and this national balanced benchmark is not a Calgary validation set.

| Model | Held-out accuracy | Macro F1 |
|---|---:|---:|
| Random Forest — selected by training CV macro F1 | 70.95% | 0.704 |
| Gradient Boosting | 66.98% | 0.662 |
| Logistic Regression | 65.87% | 0.652 |
| TF-IDF/SVD nearest-centroid baseline | 60.95% | 0.612 |
| Majority baseline | 8.25% | 0.017 |

Confusion matrices for all three requested models, every grid result and selected
hyperparameters are saved in the notebook and `artifacts/`. The winning parameters
are refitted on all labelled rows only after held-out reporting. This is the best
model in this small search, not a claim of globally optimal parameters.

The clustering search compares K-means, Gaussian Mixture and DBSCAN on standardized
log resource-count profiles. It selected **K-means, k=2**, on 150 communities with
completely queried driving matrices: silhouette **0.666**, Davies–Bouldin **0.621**,
and perturbation ARI **1.000**. These are internal diagnostics, not clustering
accuracy. ARI compares a 1% feature perturbation, not independently labelled
ground truth. Cluster numbers have no better/worse ordering. The full cluster
profiles and candidate results are in `artifacts/clustering.json`.

## Data and honest scope

- Statistics Canada [ODHF v2](https://www150.statcan.gc.ca/n1/pub/13-26-0001/132600012020001-eng.htm),
  released September24,2026: 22,154 national records; 152 Calgary facilities.
  Its published service types supply labels. This does not establish medical
  quality, effectiveness, current availability or eligibility.
- Calgary [Community Services](https://data.calgary.ca/d/x34e-bcjz) adds public-health
  clinics, libraries, social development and community centres. These are not
  assumed to provide caregiver-specific respite or other unspecified services.
- Calgary [Community Boundaries](https://data.calgary.ca/d/surr-xmvs): 223 residential
  communities. Origins are interior representative points, not individual home
  locations; simplified boundaries are for display.
- 299 known resource records in the combined snapshot. StatCan projected geometry
  is transformed from EPSG3347 to WGS84 before mapping or routing.
- Actual OSRM driving-table durations were fetched for 150/223 communities within
  a 75-second preparation budget. Incomplete rows are hatched and unscored. No
  straight-line-to-speed conversion is used. No live traffic or transit routing.
- All step-free, opening-hour and current-availability fields are unknown. Requiring
  verified step-free access excludes unknown records rather than marking them
  inaccessible. No demographics infer individual medical needs or mobility.
- The app's score is `100 × mean(min(reachable count / 5, 1))` across selected
  categories. It is a transparent coverage metric, **not** an ML prediction or
  clinical/accessibility certification. Categories receive equal weights.
- Interactive filters recalculate the metric from cached route/distance matrices.
  The ML groups remain the fixed offline 20/30-minute profile partition, labelled
  as such. No retraining, routing or Python process launches happen per interaction.

The data snapshot includes source URLs, fetch dates, raw-source hashes, route
coverage and limitations. Public source data and fitted models are checked in;
raw downloads and Python caches are ignored. Treat `.joblib` files as executable
artifacts: load only this trusted notebook's outputs or your own deployment bucket.

## Run locally

```sh
# In the repository root; the map works from the committed snapshot.
npm ci
npm run dev
# Open http://127.0.0.1:3000/care-access

# Optional Python service for classifying NEW resource names.
python3 -m venv .venv-care-access
.venv-care-access/bin/pip install -r ml/care_access/requirements.txt
.venv-care-access/bin/python -m ml.care_access.inference --port 8091
```

Set `CARE_ACCESS_INFERENCE_URL=http://127.0.0.1:8091/classify` in ignored
`.env.local` to enable `POST /api/care-access/classify`. The Python server loads the
fitted classifier once; it does not train on requests. Unknown vocabulary returns
`Unknown`. Use only resource names/service descriptions, not personal care records.
The map never needs this optional server.

The local lookup smoke measured **2.43ms median / 5.63ms p95** for comparing
all223 communities against299 records. This measures cached filter computation
on this machine, not network loading, React rendering or a latency guarantee.

```sh
# Public aggregate access/RAG hook; response contains sourced resource IDs.
curl 'http://127.0.0.1:3000/api/care-access?mode=driving&threshold=20&categories=Pharmacy,Health%20Centre'

# Optional warm classifier hook, 1–20 texts, at most2000 chars each.
curl -X POST http://127.0.0.1:3000/api/care-access/classify \
  -H 'Content-Type: application/json' -d '{"texts":["Community pharmacy"]}'
```

`GET /api/care-access` accepts `area` (community code), `mode` (`driving` or
`proximity`), `threshold` (minutes or km), comma-separated `categories`, and
`stepFree=true`. Unknown areas return404; unsupported transit returns422 rather
than fabricated times. This is an additive integration point for existing RAG:
use returned resource IDs/source URLs as candidate evidence, then keep existing
authorization and citation guards. No existing retrieval contract is changed.

## Reproduce the notebook

```sh
python -m ml.care_access.prepare --route-seconds 75
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python -m ml.care_access.notebook
```

The notebook generator writes and executes `notebooks/care_access.ipynb`, retaining
real cell outputs. It expects prepared data; the preceding command downloads it
when the raw cache is absent. Routing snapshots are cached by coordinate signature.
Delete only your own generated `data/driving.json` if you explicitly want to refresh
that cache. `CARE_ACCESS_OSRM_URL` can point to your own OSRM deployment. Route
failure/partial coverage remains visible; no cloud-routing fallback is invented.

## AWS hooks — optional, not deployed

The current team MVP runs locally. These hooks satisfy the requested AWS option
without provisioning accounts, roles, endpoints or resources:

```sh
# Uses the caller's existing AWS profile/role. Uploads five artifacts to an existing
# private bucket with SSE-S3; no bucket/policy/IAM changes.
python -m ml.care_access.deploy --bucket YOUR_EXISTING_BUCKET --prefix care-access
```

- Lambda handler: `ml.care_access.inference.lambda_handler`. Package compatible
  Linux Python3.12/scikit-learn1.6.1 wheels and the artifact, or set
  `CARE_ACCESS_MODEL_BUCKET` / `CARE_ACCESS_MODEL_KEY` to load from an existing S3
  bucket on a cold start. The fitted model is cached in the warm process. This
  repository's macOS virtual environment is not a Lambda deployment package.
- Set `CARE_ACCESS_MODEL_PATH` to select a trusted local model file. Model and
  scikit-learn versions are recorded in `artifacts/manifest.json`.
- Point `CARE_ACCESS_INFERENCE_URL` at the full Lambda Function URL/API Gateway
  endpoint instead of the local `/classify` URL. `CARE_ACCESS_INFERENCE_TOKEN`,
  when configured on both services, supplies/verifies a bearer header. Keep it
  server-side and out of GitHub. AWS-side roles/network/auth stay with infra owner.
- No AWS upload, invocation, account/security verification or production deployment
  was run. Cold starts and network calls are not instantaneous; browser map filters
  avoid them entirely. No hosted free-text classifier is required for the MVP map.

## Review hold

All changes are under new additive paths. There is no top-nav edit or automatic
integration into `mvp-local`. The branch must remain separate from `main`; Ali
requested a completed board handoff and a hold, without a merge request or merge.
