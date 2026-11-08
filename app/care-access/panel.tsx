"use client";
import { useEffect, useMemo, useState } from "react";
import { compareAreas, SERVICE_CATEGORIES, SERVICE_NAMES, type AccessMode, type AccessSnapshot } from "../../lib/care-access/engine";
import styles from "./style.module.css";

const palette = ["#617b72", "#a97250", "#7b7192", "#7692a3", "#aa8d4a", "#b66d77", "#638681"];
export default function AccessPanel() {
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<AccessMode>("driving");
  const [threshold, setThreshold] = useState(20);
  const [categories, setCategories] = useState<string[]>(["Pharmacy", "Health Centre"]);
  const [stepFree, setStepFree] = useState(false);
  const [selected, setSelected] = useState("");
  const [view, setView] = useState<"metric" | "clusters">("metric");
  useEffect(() => { const controller = new AbortController(); fetch("/care-access/snapshot.json", { signal: controller.signal }).then((r) => { if (!r.ok) throw Error(); return r.json(); }).then((data: AccessSnapshot) => { setSnapshot(data); setSelected(data.areas.find((_, i) => data.drivingCoverage[i] === 1)?.id ?? data.areas[0].id); }).catch(() => { if (!controller.signal.aborted) setError("Access snapshot unavailable. Run the notebook export first."); }); return () => controller.abort(); }, []);
  const comparison = useMemo(() => snapshot ? compareAreas(snapshot, { mode, threshold, categories, stepFree }) : [], [snapshot, mode, threshold, categories, stepFree]);
  const current = comparison.find((row) => row.area.id === selected);
  const map = useMemo(() => {
    if (!snapshot) return [];
    const coords = snapshot.areas.flatMap((area) => area.geometry.coordinates.flatMap((polygon) => polygon.flat()));
    const xs = coords.map(([lon]) => lon * Math.cos(51.05 * Math.PI / 180)), ys = coords.map(([, lat]) => lat);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min(900 / (maxX - minX), 650 / (maxY - minY));
    return snapshot.areas.map((area) => ({ id: area.id, path: area.geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(([lon, lat], i) => `${i ? "L" : "M"}${(30 + (lon * Math.cos(51.05 * Math.PI / 180) - minX) * scale).toFixed(1)},${(25 + (maxY - lat) * scale).toFixed(1)}`).join(" ") + " Z").join(" ")).join(" ") }));
  }, [snapshot]);
  if (!snapshot) return <main className={styles.shell}><h1>Care Access Intelligence</h1><p role="status">{error || "Loading the prepared Calgary access snapshot…"}</p></main>;
  const cluster = current ? snapshot.clusters[current.index] : null;
  const best = snapshot.benchmark.classification.results.find((r) => r.model === snapshot.benchmark.classification.selected_model)!;
  return <main className={styles.shell}>
    <header className={styles.header}><div><a href="/">ReliefReady ↗</a><p className={styles.eyebrow}>CALGARY · CARE ACCESS INTELLIGENCE</p><h1>Find support.<br /><em>Understand the gaps.</em></h1><p>Compare access to known services around a representative point in each community. Every comparison traces back to actual source records.</p></div><aside><strong>{snapshot.resources.length}</strong> known resources<br /><strong>{snapshot.areas.length}</strong> residential communities<br /><span>Prepared {new Date(snapshot.provenance.fetchedAt).toLocaleDateString()}</span></aside></header>
    <div className={styles.layout}>
      <section className={styles.controls} aria-label="Compare access">
        <h2>Your access needs</h2>
        <label>Transportation<select value={mode} onChange={(e) => { const next = e.target.value as AccessMode; setMode(next); setThreshold(next === "proximity" ? 3 : 20); }}><option value="driving">Driving · cached road routes</option><option value="proximity">Geographic proximity · distance only</option><option value="transit">Public transit · not routed yet</option></select></label>
        <label>{mode === "proximity" ? "Radius" : "Travel window"}<strong>{threshold} {mode === "proximity" ? "km" : "minutes"}</strong><input type="range" min={mode === "proximity" ? 1 : 10} max={mode === "proximity" ? 10 : 45} step={mode === "proximity" ? .5 : 5} value={threshold} disabled={mode === "transit"} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
        <fieldset><legend>Services to compare</legend>{SERVICE_CATEGORIES.map((category) => <label className={styles.check} key={category}><input type="checkbox" checked={categories.includes(category)} onChange={(e) => setCategories((old) => e.target.checked ? [...old, category] : old.filter((x) => x !== category))} />{SERVICE_NAMES[category]}</label>)}</fieldset>
        <label className={styles.check}><input type="checkbox" checked={stepFree} onChange={(e) => setStepFree(e.target.checked)} />Require verified step-free access</label>
        {stepFree && <p className={styles.notice}>The source snapshot has no verified step-free fields. Unknown resources are excluded, not labelled inaccessible.</p>}
        <label>Inspect community<select value={selected} onChange={(e) => setSelected(e.target.value)}>{snapshot.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
        <p className={styles.small}>Not medical quality, treatment advice, service eligibility or live availability.</p>
      </section>
      <section className={styles.card} aria-label="Calgary access map">
        <div className={styles.mapHeader}><h2>{view === "metric" ? "Access comparison" : "Unordered ML groups"}</h2><div><button aria-pressed={view === "metric"} onClick={() => setView("metric")}>Access metric</button><button aria-pressed={view === "clusters"} onClick={() => setView("clusters")}>ML groups</button></div></div>
        {mode === "transit" && <p className={styles.notice}>Transit durations are unavailable. This map does not turn nearby stops into travel-time estimates. Choose driving or distance.</p>}
        <svg viewBox="0 0 960 720" className={styles.map} role="group" aria-label="Calgary residential communities. Select a region to inspect its supporting resources.">
          <defs><pattern id="unknown" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#eeebe6" /><path d="M0 7L7 0" stroke="#d3cbc2" /></pattern></defs>
          {map.map((shape, i) => { const row = comparison[i], c = snapshot.clusters[i]; const fill = view === "clusters" ? c === null || c < 0 ? "url(#unknown)" : palette[c % palette.length] : row.score === null ? "url(#unknown)" : `hsl(${25 + row.score * 1.1} 23% ${91 - row.score * .43}%)`; return <path key={shape.id} d={shape.path} fill={fill} fillRule="evenodd" stroke={shape.id === selected ? "#3e251a" : "#fff"} strokeWidth={shape.id === selected ? 2.5 : .6} tabIndex={0} role="button" aria-label={`${row.area.name}: ${row.score === null ? "routing unknown" : `${row.score} access metric`}`} onClick={() => setSelected(shape.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(shape.id); } }}><title>{row.area.name} · {view === "clusters" ? `Group ${c ?? "unknown"}` : row.score === null ? "Routing incomplete" : `${row.score}/100 coverage metric`}</title></path>; })}
        </svg>
        <p className={styles.small}>{view === "metric" ? "Light → dark: fewer → more known reachable resources. Hatching means missing routing, not low access." : `Fixed offline ${snapshot.clusterBasis} profiles; cluster numbers have no ranking. The sliders change the access metric, not this fitted partition.`}</p>
        <p className={styles.small}>Boundaries: City of Calgary · Routing © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors (ODbL)</a> / OSRM · No live traffic or transit routing.</p>
      </section>
      <section className={styles.detail} aria-live="polite"><p className={styles.eyebrow}>INSPECT THE EVIDENCE</p><h2>{current?.area.name}</h2><div className={styles.score}>{current?.score === null ? "—" : current?.score}<span>/100 access metric</span></div><p>{current?.score === null ? "Complete route data is unavailable for this mode/community. No score is assigned." : `${current?.resources.length} matching known resources within ${threshold} ${mode === "proximity" ? "km" : "minutes"}.`}</p><p className={styles.small}>ML group: {cluster === null ? "not fitted for this community" : cluster === -1 ? "noise / unassigned" : cluster}. Step-free details unknown for {current?.unknownStepFree ?? 0} nearby resources.</p>
        <dl>{Object.entries(current?.counts ?? {}).map(([category, count]) => <div key={category}><dt>{SERVICE_NAMES[category]}</dt><dd>{count}</dd></div>)}</dl>
        <h3>Supporting resources</h3><div className={styles.resources}>{current?.resources.slice(0, 25).map(({ resource, cost }) => <article key={resource.id}><strong>{resource.name}</strong><p>{resource.category} · {cost.toFixed(1)} {mode === "proximity" ? "km straight-line" : "routed min"}</p><p>{resource.address}</p><p>Step-free access, hours and availability unknown</p><a href={resource.sourceUrl} target="_blank" rel="noreferrer">{resource.source} ↗</a>{resource.modelCategory !== resource.category && <p>Model suggestion: {resource.modelCategory}. Published category retained.</p>}</article>)}</div>
      </section>
    </div>
    <section className={styles.methods}><h2>Understand the model</h2><div className={styles.methodGrid}><article><h3>Service classification</h3><strong>{snapshot.benchmark.classification.selected_model}</strong><p>{(best.heldout_accuracy * 100).toFixed(1)}% held-out accuracy · macro F1 {best.heldout_macro_f1.toFixed(3)}</p><p>Balanced national sample of published service categories. Facility names only; not an independent Calgary validation.</p><table><thead><tr><th>Model</th><th>Accuracy</th><th>Macro F1</th></tr></thead><tbody>{snapshot.benchmark.classification.results.map((r) => <tr key={r.model}><td>{r.model}</td><td>{(r.heldout_accuracy * 100).toFixed(1)}%</td><td>{r.heldout_macro_f1.toFixed(3)}</td></tr>)}</tbody></table></article><article><h3>Accessibility clustering</h3><strong>{snapshot.benchmark.clustering.selected.algorithm}</strong><p>Silhouette {snapshot.benchmark.clustering.selected.silhouette.toFixed(3)} · perturbation ARI {snapshot.benchmark.clustering.selected.perturbation_ari.toFixed(3)}</p><p>{snapshot.benchmark.clustering.accuracy_reason}</p><h3>Transparent metric</h3><p>{snapshot.scoreFormula}</p><p>Directory incompleteness can lower counts. No neighborhood demographics infer a person&apos;s needs.</p></article></div><details><summary>Sources and limitations</summary><ul>{snapshot.provenance.limitations.map((text) => <li key={text}>{text}</li>)}</ul>{Object.entries(snapshot.provenance.sources).map(([name, url]) => <p key={name}><a href={url}>{name} source</a></p>)}</details></section>
  </main>;
}
