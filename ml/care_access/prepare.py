"""Download public labels/geometry and optionally cache genuine driving durations."""
from __future__ import annotations
import argparse, hashlib, io, json, math, os, re, time, urllib.parse, urllib.request, zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely.geometry import shape, mapping

ROOT = Path(__file__).resolve().parent
SOURCES = {
    "odhf": "https://www150.statcan.gc.ca/n1/pub/13-26-0001/2020001/zip/odhf_v2_geojson.zip",
    "services": "https://data.calgary.ca/resource/x34e-bcjz.json?$limit=5000",
    "communities": "https://data.calgary.ca/resource/surr-xmvs.json?$limit=5000",
}

def canonical_name(value):
    return re.sub(r"[^a-z]+", " ", str(value).lower()).strip()

def read_source(name):
    cache = ROOT / "data/raw" / (name + (".zip" if name == "odhf" else ".json"))
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        with urllib.request.urlopen(SOURCES[name], timeout=40) as response:
            cache.write_bytes(response.read())
    raw = cache.read_bytes()
    if name == "odhf":
        archive = zipfile.ZipFile(io.BytesIO(raw))
        raw_json = archive.read(next(n for n in archive.namelist() if n.endswith(".geojson")))
    else:
        raw_json = raw
    return json.loads(raw_json), hashlib.sha256(raw).hexdigest()

def distances(areas, resources):
    a = np.radians([[p["lat"], p["lon"]] for p in areas])
    b = np.radians([[p["lat"], p["lon"]] for p in resources])
    dlat, dlon = a[:, None, 0] - b[None, :, 0], a[:, None, 1] - b[None, :, 1]
    h = np.sin(dlat / 2) ** 2 + np.cos(a[:, None, 0]) * np.cos(b[None, :, 0]) * np.sin(dlon / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))

def driving_matrix(areas, resources, seconds=90):
    """No inferred speeds, no walking/transit aliases. Nulls remain unknown/no-route."""
    path = ROOT / "data/driving.json"
    signature = hashlib.sha256(json.dumps([[p["lon"], p["lat"]] for p in areas + resources]).encode()).hexdigest()
    if path.exists():
        previous = json.loads(path.read_text())
        if previous.get("signature") == signature:
            return previous
    durations = [[None] * len(resources) for _ in areas]
    queried = np.zeros((len(areas), len(resources)), dtype=bool)
    start = time.monotonic()
    base = os.environ.get("CARE_ACCESS_OSRM_URL", "https://router.project-osrm.org").rstrip("/")
    failures = 0
    for first in range(0, len(areas), 15):
        for dest in range(0, len(resources), 80):
            if time.monotonic() - start >= seconds:
                break
            origin_batch, resource_batch = areas[first:first + 15], resources[dest:dest + 80]
            coords = ";".join(f'{p["lon"]:.6f},{p["lat"]:.6f}' for p in origin_batch + resource_batch)
            query = urllib.parse.urlencode({"sources": ";".join(map(str, range(len(origin_batch)))), "destinations": ";".join(map(str, range(len(origin_batch), len(origin_batch) + len(resource_batch)))), "annotations": "duration"})
            try:
                with urllib.request.urlopen(f"{base}/table/v1/driving/{coords}?{query}", timeout=8) as response:
                    result = json.load(response)
                if result.get("code") != "Ok" or len(result["durations"]) != len(origin_batch):
                    raise ValueError("invalid routing response")
                for i, row in enumerate(result["durations"]):
                    if len(row) != len(resource_batch):
                        raise ValueError("invalid matrix width")
                    durations[first + i][dest:dest + len(row)] = [round(x / 60, 2) if x is not None else None for x in row]
                    queried[first + i, dest:dest + len(row)] = True
            except Exception:
                failures += 1
                if failures >= 3:
                    break
            time.sleep(1)  # public demo server: do not burst requests
        if failures >= 3 or time.monotonic() - start >= seconds:
            break
    result = {"signature": signature, "provider": base, "profile": "driving", "minutes": durations, "coverage": queried.mean(axis=1).round(3).tolist(), "fetchedAt": datetime.now(timezone.utc).isoformat(), "failures": failures}
    path.write_text(json.dumps(result))
    return result

def prepare(route_seconds=90):
    raw, hashes = {}, {}
    for name in SOURCES:
        raw[name], hashes[name] = read_source(name)
    odhf = raw["odhf"]
    crs = odhf.get("crs", {}).get("properties", {}).get("name", "EPSG:4326")
    transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    labels, resources, seen = [], [], set()
    odhf_url = "https://www150.statcan.gc.ca/n1/pub/13-26-0001/132600012020001-eng.htm"
    for feature in odhf["features"]:
        p = feature["properties"]
        name, label = str(p.get("name") or "").strip(), str(p.get("type") or "").strip()
        group = canonical_name(name)
        if name and label and group not in seen:
            labels.append({"name": name, "label": label, "group": group, "source": "StatCan ODHF v2", "source_id": p["id"]})
            seen.add(group)
        if str(p.get("csdname", "")).lower() != "calgary" or not feature.get("geometry"):
            continue
        lon, lat = transformer.transform(*feature["geometry"]["coordinates"][:2])
        if not (-115 < lon < -113 and 50 < lat < 52):
            continue
        resources.append({"id": "odhf-" + p["id"], "name": name, "category": label, "lat": lat, "lon": lon, "address": p.get("address") or "", "sourceUrl": odhf_url, "source": "StatCan ODHF v2", "wheelchair": None, "hours": None})
    keep = {"Community Centre", "Library", "PHS Clinic", "Social Dev Ctr"}
    for i, p in enumerate(raw["services"]):
        if p.get("type") not in keep:
            continue
        lon, lat = p["point"]["coordinates"]
        resources.append({"id": f"city-{i}", "name": p["name"], "category": p["type"], "lat": lat, "lon": lon, "address": p.get("address", ""), "sourceUrl": "https://data.calgary.ca/d/x34e-bcjz", "source": "City of Calgary", "wheelchair": None, "hours": None})
    areas = []
    for p in raw["communities"]:
        if p.get("class") != "Residential":
            continue
        polygon = shape(p["multipolygon"])
        origin = polygon.representative_point()
        areas.append({"id": p["comm_code"], "name": p["name"].title(), "lat": origin.y, "lon": origin.x, "sector": p.get("sector"), "geometry": mapping(polygon.simplify(.0007, preserve_topology=True))})
    areas.sort(key=lambda x: (x["sector"] or "", x["name"]))
    frame = pd.DataFrame(labels)
    counts = frame.label.value_counts()
    frame = frame[frame.label.isin(counts[counts >= 30].index)]
    # Keep preparation/training fast and prevent one class dominating this benchmark.
    frame = frame.groupby("label", group_keys=False).apply(lambda x: x.sample(min(len(x), 350), random_state=42), include_groups=True).reset_index(drop=True)
    (ROOT / "data").mkdir(exist_ok=True)
    frame.to_csv(ROOT / "data/labels.csv", index=False)
    route = driving_matrix(areas, resources, route_seconds) if route_seconds > 0 else {"minutes": [[None] * len(resources) for _ in areas], "coverage": [0] * len(areas), "provider": None}
    result = {"areas": areas, "resources": resources, "distanceKm": distances(areas, resources).round(3).tolist(), "drivingMinutes": route["minutes"], "drivingCoverage": route["coverage"], "provenance": {"fetchedAt": datetime.now(timezone.utc).isoformat(), "sources": SOURCES, "sha256": hashes, "odhfSourceCrs": crs, "routingProvider": route["provider"], "routingProfile": "driving only; no live traffic", "licences": ["Open Government Licence – Canada", "City of Calgary Open Data terms", "Routing © OpenStreetMap contributors, ODbL"], "limitations": ["Representative community origins, not individual home routes", "Facility directory coverage is incomplete", "Accessibility, opening hours and current service availability are unknown", "Transit/walking not routed; no invented travel times", "Community centres are not assumed to offer caregiver-specific services"]}}
    (ROOT / "data/access.json").write_text(json.dumps(result, separators=(",", ":")))
    print(json.dumps({"training_rows": len(frame), "classes": frame.label.value_counts().to_dict(), "areas": len(areas), "resources": len(resources), "fully_routed_areas": sum(c == 1 for c in route["coverage"])}))
    return result, frame

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--route-seconds", type=int, default=90)
    prepare(parser.parse_args().route_seconds)
