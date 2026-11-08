"""Generate and execute the benchmark notebook; all reported results are real outputs."""
from pathlib import Path
import os
import nbformat
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[2]

def run():
    md, code = nbformat.v4.new_markdown_cell, nbformat.v4.new_code_cell
    notebook = nbformat.v4.new_notebook(cells=[
        md("# ReliefReady Care Access Intelligence\nFast MVP grids on published **service types**, never effectiveness. Classification uses a grouped held-out split; clustering uses internal/stability metrics, not invented accuracy. Exports keep training and routing off the application request path."),
        code('''from pathlib import Path
import sys, json, pandas as pd
ROOT = next(p for p in [Path.cwd(), *Path.cwd().parents] if (p / "ml/care_access").exists())
sys.path.insert(0, str(ROOT))
from ml.care_access.train import train_classifiers, train_clusters, ARTIFACTS
from IPython.display import display, Image
data = pd.read_csv(ROOT / "ml/care_access/data/labels.csv")
display(data.groupby("label").size().rename("published_examples").to_frame())
snapshot = json.loads((ROOT / "ml/care_access/data/access.json").read_text())
print({"areas": len(snapshot["areas"]), "resources": len(snapshot["resources"]), "fully_routed_areas": sum(x == 1 for x in snapshot["drivingCoverage"])})'''),
        md("## Supervised grids\nTF-IDF → SVD32 → classifier stays inside training CV. Logistic Regression:6 combinations; Random Forest:4; Gradient Boosting:4; three folds each. Choose by training CV macro F1, then report the untouched test. Type/source_class/location/IDs are excluded from input. Same normalized names stay together; related brand wording may still overlap. Balanced national sampling does not estimate natural Calgary prevalence."),
        code('''classification = train_classifiers()
columns = ["model", "cv_macro_f1", "heldout_accuracy", "heldout_macro_f1", "prediction_p50_ms", "prediction_p95_ms", "seconds"]
display(pd.DataFrame(classification["results"]).reindex(columns=columns))
print("Selected:", classification["selected_model"], "| seconds:", classification["elapsed_seconds"])
display(pd.read_csv(ARTIFACTS / "classification_grid.csv").sort_values("cv_macro_f1", ascending=False))'''),
        code('''for family in ["logistic_regression", "random_forest", "gradient_boosting"]:
    display(Image(filename=str(ARTIFACTS / f"{family}_confusion.png")))'''),
        md("## Unsupervised access profiles\nCompare K-means, Gaussian Mixture and DBSCAN across small grids. Standardize log resource-count features, **not latitude/longitude**. Use actual driving durations only for completely queried areas, otherwise label proximity explicitly. Reject degenerate/mostly-noise partitions. Silhouette, Davies–Bouldin, Calinski–Harabasz and perturbation ARI are diagnostics, not clinical validation or accuracy. Cluster IDs are unordered."),
        code('''clustering = train_clusters()
display(pd.DataFrame(clustering["search"]).sort_values("silhouette", ascending=False))
print("Selected:", clustering["selected"], "| basis:", clustering["basis"])
display(pd.DataFrame(clustering["profiles"]))
print(clustering["accuracy_reason"])'''),
        code('''import matplotlib.pyplot as plt
profiles = pd.DataFrame([{"cluster": p["cluster"], **p["mean_counts"]} for p in clustering["profiles"]]).set_index("cluster")
ax = profiles.plot.bar(figsize=(12,5))
ax.set_title("Unordered clusters: mean known reachable resource counts")
ax.set_ylabel("Resource count")
plt.tight_layout(); plt.show()'''),
        md("## Export and instant interaction\nThe fitted models are serialized once. The public snapshot holds real records, source dates/hashes, cached matrices, cluster labels and metrics. Browser filtering does not call Python, routing or training. The access score is a capped resource-coverage formula, **not an ML prediction**. Unknown hours, step-free access and current availability stay unknown. Transit requires a real GTFS routing adapter; nearby stops are not travel times. No demographics infer a person's health/mobility."),
        code('''from ml.care_access.inference import classify
print(classify({"texts": ["Community pharmacy", "Public health clinic"]}))
print("Artifacts:", [p.name for p in ARTIFACTS.iterdir() if p.is_file()])
print("Snapshot:", ROOT / "public/care-access/snapshot.json")'''),
    ], metadata={"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}})
    path = ROOT / "notebooks/care_access.ipynb"
    path.parent.mkdir(exist_ok=True)
    nbformat.write(notebook, path)
    # The selected environment already contains the required sklearn/notebook packages.
    os.environ.setdefault("MPLCONFIGDIR", "/tmp/care-access-matplotlib")
    client = NotebookClient(notebook, timeout=300, kernel_name="python3", resources={"metadata": {"path": str(ROOT)}})
    try:
        client.execute()
    finally:
        nbformat.write(notebook, path)
    print(path)

if __name__ == "__main__": run()
