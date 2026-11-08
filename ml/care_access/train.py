"""Small reproducible grids. Select on training CV, report untouched test metrics once."""
from __future__ import annotations
import hashlib, json, tempfile, time
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from sklearn import __version__ as sklearn_version
from sklearn.cluster import KMeans, DBSCAN
from sklearn.mixture import GaussianMixture
from sklearn.decomposition import TruncatedSVD
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, ConfusionMatrixDisplay, confusion_matrix, silhouette_score, davies_bouldin_score, calinski_harabasz_score, adjusted_rand_score
from sklearn.model_selection import GridSearchCV, StratifiedGroupKFold
from sklearn.neighbors import NearestCentroid
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler, Normalizer

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / "artifacts"
FEATURE_CATEGORIES = ["Pharmacy", "Health Centre", "Hospital", "PHS Clinic", "Social Dev Ctr", "Community Centre", "Library"]

def train_classifiers():
    start = time.perf_counter()
    ARTIFACTS.mkdir(exist_ok=True)
    data = pd.read_csv(ROOT / "data/labels.csv").fillna("")
    outer = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
    train, test = next(outer.split(data.name, data.label, data.group))
    assert not set(data.group.iloc[train]) & set(data.group.iloc[test])
    x, y, groups = data.name.iloc[train], data.label.iloc[train], data.group.iloc[train]
    xt, yt = data.name.iloc[test], data.label.iloc[test]
    cv = list(StratifiedGroupKFold(n_splits=3, shuffle=True, random_state=73).split(x, y, groups))
    families = {
        "Logistic Regression": (LogisticRegression(max_iter=500, random_state=42), {"model__C": [.3, 1., 3.], "model__class_weight": [None, "balanced"]}),
        "Random Forest": (RandomForestClassifier(n_estimators=80, n_jobs=2, random_state=42), {"model__max_depth": [12, None], "model__min_samples_leaf": [1, 3]}),
        "Gradient Boosting": (GradientBoostingClassifier(random_state=42), {"model__n_estimators": [40, 70], "model__max_depth": [1, 2], "model__learning_rate": [.08]}),
    }
    results, fitted, searches = [], {}, []
    cache = joblib.Memory(tempfile.mkdtemp(prefix="care-access-training-"), verbose=0)
    def pipeline(model):
        return Pipeline([("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=5000, min_df=2, sublinear_tf=True)), ("svd", TruncatedSVD(n_components=32, random_state=42)), ("normalize", Normalizer()), ("model", model)], memory=cache)
    for name, (model, grid) in families.items():
        phase = time.perf_counter()
        search = GridSearchCV(pipeline(model), grid, scoring="f1_macro", cv=cv, n_jobs=1, error_score="raise", refit=True)
        search.fit(x, y)
        fitted[name] = search.best_estimator_
        searches.extend({"family": name, "params": str(p), "cv_macro_f1": float(s)} for p, s in zip(search.cv_results_["params"], search.cv_results_["mean_test_score"]))
        predictions = search.predict(xt)
        latencies = []
        for _ in range(20):
            before = time.perf_counter(); search.predict(xt.iloc[:1]); latencies.append((time.perf_counter() - before) * 1000)
        row = {"model": name, "cv_macro_f1": float(search.best_score_), "heldout_accuracy": accuracy_score(yt, predictions), "heldout_macro_f1": f1_score(yt, predictions, average="macro", zero_division=0), "heldout_balanced_accuracy": balanced_accuracy_score(yt, predictions), "parameters": search.best_params_, "seconds": round(time.perf_counter() - phase, 2), "prediction_p50_ms": float(np.percentile(latencies, 50)), "prediction_p95_ms": float(np.percentile(latencies, 95)), "confusion_matrix": confusion_matrix(yt, predictions, labels=search.classes_).tolist(), "labels": search.classes_.tolist()}
        results.append(row)
        fig, ax = plt.subplots(figsize=(11, 9))
        ConfusionMatrixDisplay(np.array(row["confusion_matrix"]), display_labels=row["labels"]).plot(ax=ax, xticks_rotation=90, colorbar=False, cmap="Blues")
        ax.set_title(f"{name}: held-out service-type classification")
        fig.tight_layout(); fig.savefig(ARTIFACTS / (name.lower().replace(" ", "_") + "_confusion.png"), dpi=130); plt.close(fig)
        print(f'{name}: CV F1={row["cv_macro_f1"]:.3f}, heldout accuracy={row["heldout_accuracy"]:.3f}, {row["seconds"]}s', flush=True)
    for name, model in [("Majority baseline", DummyClassifier(strategy="most_frequent")), ("TF-IDF/SVD nearest-centroid baseline", NearestCentroid())]:
        baseline = pipeline(model).fit(x, y); predictions = baseline.predict(xt)
        results.append({"model": name, "heldout_accuracy": accuracy_score(yt, predictions), "heldout_macro_f1": f1_score(yt, predictions, average="macro", zero_division=0)})
    selected = max(results[:3], key=lambda row: row["cv_macro_f1"])
    # Refit chosen hyperparameters on all labelled rows only AFTER holdout reporting.
    final = fitted[selected["model"]].fit(data.name, data.label)
    joblib.dump(final, ARTIFACTS / "classifier.joblib", compress=3)
    pd.DataFrame(searches).to_csv(ARTIFACTS / "classification_grid.csv", index=False)
    report = {"selected_model": selected["model"], "selection_metric": "3-fold training-only macro F1, not test accuracy", "results": results, "rows": len(data), "train_rows": len(train), "test_rows": len(test), "split": "seeded stratified groups of normalized facility names; same-name groups do not cross splits", "features": "facility name only; published type, source_class, geography and IDs excluded", "benchmark_distribution": "max350 unique names per published class; not natural Calgary prevalence", "label_source": "StatCan ODHF v2 harmonized service-type metadata; not outcome or clinical labels", "limitations": ["No independently reviewed Calgary-specific test set", "Name-based service classification does not establish quality, availability or eligibility", "Shared brand wording may remain across different normalized name groups", "Only this small grid was searched; no claim of globally optimal parameters"], "elapsed_seconds": round(time.perf_counter() - start, 2), "sklearn_version": sklearn_version}
    (ARTIFACTS / "classification.json").write_text(json.dumps(report, indent=2))
    return report

def access_features(snapshot):
    coverage = np.array(snapshot["drivingCoverage"])
    routed = coverage == 1
    use_routes = routed.sum() >= 20
    indices = np.flatnonzero(routed) if use_routes else np.arange(len(snapshot["areas"]))
    matrix = np.array(snapshot["drivingMinutes"] if use_routes else snapshot["distanceKm"], dtype=float)[indices]
    categories = np.array([resource["category"] for resource in snapshot["resources"]])
    columns, names = [], []
    for category in FEATURE_CATEGORIES:
        threshold = (20 if category == "Pharmacy" else 30) if use_routes else 3
        columns.append(np.sum((matrix <= threshold) & (categories == category), axis=1))
        names.append(category + (f"_{threshold}min" if use_routes else "_3km"))
    return np.array(columns).T, indices, names, "driving" if use_routes else "proximity"

def train_clusters():
    snapshot = json.loads((ROOT / "data/access.json").read_text())
    features, indices, names, basis = access_features(snapshot)
    scaler = StandardScaler(); x = scaler.fit_transform(np.log1p(features))
    candidates = [("KMeans", {"k": k}, KMeans(n_clusters=k, n_init=10, random_state=42)) for k in range(2, 7)]
    candidates += [("Gaussian Mixture", {"k": k, "covariance": cov}, GaussianMixture(n_components=k, covariance_type=cov, reg_covar=1e-4, random_state=42)) for k in range(2, 6) for cov in ["diag", "full"]]
    candidates += [("DBSCAN", {"eps": eps, "min_samples": count}, DBSCAN(eps=eps, min_samples=count)) for eps in [.5, .8, 1.2] for count in [4, 8]]
    reports, fitted = [], []
    rng = np.random.default_rng(7)
    for name, params, model in candidates:
        labels = model.fit_predict(x); valid = labels >= 0; count = len(set(labels[valid]))
        if count < 2 or count >= valid.sum() or valid.mean() < .7:
            continue
        from sklearn.base import clone
        other = clone(model)
        if "random_state" in other.get_params(): other.set_params(random_state=73)
        # Small feature perturbation: stability is agreement, never ground-truth accuracy.
        perturbed = other.fit_predict(x + rng.normal(0, .01, x.shape))
        result = {"algorithm": name, "parameters": params, "silhouette": float(silhouette_score(x[valid], labels[valid])), "davies_bouldin": float(davies_bouldin_score(x[valid], labels[valid])), "calinski_harabasz": float(calinski_harabasz_score(x[valid], labels[valid])), "coverage": float(valid.mean()), "clusters": count, "perturbation_ari": float(adjusted_rand_score(labels, perturbed))}
        reports.append(result); fitted.append((model, labels))
    if not reports: raise ValueError("No valid multi-cluster result; do not invent clustering accuracy")
    best = max(range(len(reports)), key=lambda i: reports[i]["silhouette"] * reports[i]["coverage"])
    model, labels = fitted[best]
    joblib.dump({"model": model, "scaler": scaler, "features": names, "basis": basis}, ARTIFACTS / "clusters.joblib", compress=3)
    profiles = []
    for label in sorted(set(labels)):
        members = labels == label
        profiles.append({"cluster": int(label), "areas": int(members.sum()), "mean_counts": dict(zip(names, features[members].mean(axis=0).round(2).tolist()))})
    report = {"selected": reports[best], "selection_metric": "silhouette × non-noise coverage", "basis": basis, "areas": len(indices), "features": names, "search": reports, "profiles": profiles, "accuracy": None, "accuracy_reason": "Unsupervised labels have no ground-truth classes. Cluster IDs are unordered.", "transit": "Not computed; stops alone are not travel times", "unknown_features": "No independently verified wheelchair/hours fields; these are not imputed into accessibility evidence."}
    (ARTIFACTS / "clustering.json").write_text(json.dumps(report, indent=2))
    clusters = [None] * len(snapshot["areas"])
    for i, label in zip(indices, labels): clusters[int(i)] = int(label)
    snapshot["clusters"] = clusters
    snapshot["clusterBasis"] = basis
    snapshot["benchmark"] = {"classification": json.loads((ARTIFACTS / "classification.json").read_text()), "clustering": report}
    # Known source categories remain authoritative. Model predictions are a separate inspection field.
    classifier = joblib.load(ARTIFACTS / "classifier.joblib")
    predictions = classifier.predict([resource["name"] for resource in snapshot["resources"]])
    for resource, prediction in zip(snapshot["resources"], predictions): resource["modelCategory"] = str(prediction)
    snapshot["scoreFormula"] = "100 × mean(min(reachable count per selected service category / 5, 1)); an interpretable coverage metric, not ML prediction"
    output = ROOT.parents[1] / "public/care-access/snapshot.json"
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(snapshot, separators=(",", ":")))
    manifest = {"classifier_sha256": hashlib.sha256((ARTIFACTS / "classifier.joblib").read_bytes()).hexdigest(), "sklearn_version": sklearn_version, "selected_classifier": snapshot["benchmark"]["classification"]["selected_model"], "cluster_basis": basis}
    (ARTIFACTS / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"selected_cluster": report["selected"], "basis": basis, "profile_rows": len(indices), "snapshot_bytes": output.stat().st_size}))
    return report
