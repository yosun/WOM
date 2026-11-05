"""Plot the completed registered study; uv run --with matplotlib scripts/report-model-study.py DIR."""
import collections
import base64
import json
import statistics
from pathlib import Path
import shutil
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

study = Path(sys.argv[1]).resolve()
protocol = json.loads((study / "protocol.json").read_text())
result = json.loads((study / "results.json").read_text())
analysis = result["analysis"]
models = protocol["models"]
labels = ["Meta Spark 1.3", "Meta Wonder 1.0", "GPT-6.1 Terra", "GPT-6.1 Sol"]
colours = ["#287b61", "#287b61", "#336caa", "#336caa"]
summaries = {s["model"]: s for s in analysis["summaries"]}
fig, axes = plt.subplots(2, 2, figsize=(13, 9))
fig.patch.set_facecolor("#faf9f6")
for ax in axes.flat:
    ax.set_facecolor("#faf9f6")
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="y", alpha=.15)
ax = axes[0, 0]
means = [summaries[m]["photoWeightedIou"] * 100 for m in models]
ax.bar(range(4), means, color=colours, alpha=.7, width=.6)
photos = [p["photo"] for p in summaries[models[0]]["perPhoto"]]
for photo in photos:
    ys = [next(p["iou"] for p in summaries[m]["perPhoto"] if p["photo"] == photo) * 100 for m in models]
    ax.plot(range(4), ys, "o-", color="#454c54", alpha=.45, linewidth=.8, markersize=4)
for i, value in enumerate(means):
    ax.text(i, value + 2.3, f"{value:.2f}%", ha="center", fontsize=10, weight="bold")
ax.set(ylim=(0, 103), ylabel="Success-adjusted silhouette IoU (%)", title="Placement quality: bars = equal-photo means")
ax.set_xticks(range(4), labels, rotation=16, ha="right")
ax.text(.02, .03, "Dots/lines = the four photograph means", transform=ax.transAxes, fontsize=9)

ax = axes[0, 1]
pair_labels = ["Spark − Terra", "Wonder − Sol"]
for i, pair in enumerate(analysis["pairs"]):
    values = [p["delta"] * 100 for p in pair["perPhoto"]]
    ax.scatter(values, [i + (j - 1.5) * .05 for j in range(len(values))], s=35, color="#5a616b", zorder=3)
    center = pair["deltaMetaMinusOpenai"] * 100
    lo, hi = [v * 100 for v in pair["descriptiveBootstrap95"]]
    ax.errorbar(center, i, xerr=[[max(0, center-lo)], [max(0, hi-center)]], fmt="D", color="#b96b22", capsize=5, markersize=7, zorder=4)
ax.axvline(0, color="#777", linewidth=.8)
ax.set_yticks(range(2), pair_labels)
ax.set(xlabel="Meta minus OpenAI (IoU percentage points)", title="Paired differences at photograph level", ylim=(-.5, 1.5))
ax.text(.02, .03, "Bars: descriptive photo-bootstrap intervals\nFour clusters cannot establish broad superiority.", transform=ax.transAxes, fontsize=9)

ax = axes[1, 0]
costs = [summaries[m]["totalUsd"] for m in models]
ax.bar(range(4), costs, color=colours, alpha=.8, width=.6)
for i, value in enumerate(costs):
    ax.text(i, value + max(costs) * .02, f"${value:.3f}", ha="center", fontsize=10)
ax.set(ylabel="Total token-accounted cost (USD)", title="Cost across all registered attempts", ylim=(0, max(costs) * 1.17))
ax.set_xticks(range(4), labels, rotation=16, ha="right")

ax = axes[1, 1]
times = [[r["row"]["wallMs"] / 1000 for r in result["receipts"] if r["row"]["model"] == model] for model in models]
bp = ax.boxplot(times, tick_labels=labels, patch_artist=True, showfliers=True)
for patch, colour in zip(bp["boxes"], colours):
    patch.set_facecolor(colour)
    patch.set_alpha(.65)
ax.tick_params(axis="x", rotation=16)
ax.set(ylabel="Wall time per attempt (seconds)", title="Observed latency, including tools and scoring")
fig.suptitle("WOM: controlled placement-agent comparison", fontsize=19, weight="bold", x=.05, ha="left")
fig.text(.05, .92, f"{analysis['photos']} photographs · {analysis['cases']} object cases · {protocol['trials']} fresh trials/model/case · {analysis['rows']} attempts", fontsize=11)
fig.text(.05, .025, "Existing development course; fixed tools, prompts and limits. Failures score zero. This is not a Global WOMPar preference ranking.", fontsize=10)
fig.subplots_adjust(top=.85, bottom=.13, hspace=.65, wspace=.34, left=.08, right=.98)
fig.savefig(study / "comparison.png", dpi=170, facecolor=fig.get_facecolor())
fig.savefig(study / "comparison.svg", facecolor=fig.get_facecolor())

# Retain the observed tool timelines alongside the report, independently of later world edits.
copied = 0
for world in {c["id"].split("/")[0] for c in protocol["cases"]}:
    for record in (Path("data/worlds") / world / "agent-runs").glob("*/record.json"):
        value = json.loads(record.read_text())
        if value.get("benchmarkRunId") == protocol["id"]:
            target = study / "timelines" / record.parent.name
            shutil.copytree(record.parent, target, dirs_exist_ok=True)
            copied += 1
base_report = study / "report-base.html"
if not base_report.exists():
    shutil.copyfile(study / "report.html", base_report)
html = base_report.read_text()
by_photo = collections.defaultdict(list)
for case in protocol["cases"]:
    by_photo[case["photo"]].append(case)
grounded_iou = statistics.mean(statistics.mean(c["baselineIou"] for c in cases) for cases in by_photo.values())
tool_iou = statistics.mean(statistics.mean(c["toolIou"] for c in cases) for cases in by_photo.values())
html = html.replace("<h2>Results</h2>", f'<h2>Results</h2><p>Equal-photo geometric reference IoU: <strong>{grounded_iou * 100:.2f}%</strong>. The stronger auto-fit tool available to every agent: <strong>{tool_iou * 100:.2f}%</strong>. These reference placements require no language-model calls.</p>')
figure_data = base64.b64encode((study / "comparison.png").read_bytes()).decode("ascii")
html = html.replace("<h2>Results</h2>", '<figure><a href="comparison.svg"><img src="data:image/png;base64,' + figure_data + '" alt="Placement quality, paired photograph differences, cost and latency" style="width:100%;height:auto"></a><figcaption>Every dot represents an actual photograph mean. <a href="comparison.svg">Download vector figure</a>.</figcaption></figure><h2>Results</h2>')
html = html.replace("<h2>Audit and reproduction</h2>", f'<h2>Audit and reproduction</h2><p><a href="audit.json">Independent evidence audit</a> · <a href="environment.json">Environment and source snapshot</a> · {copied} copied WOMAgent execution timelines.</p>')
secondary = []
def metric_for(model, key, absolute=False):
    per_photo = collections.defaultdict(list)
    measured = 0
    for case in protocol["cases"]:
        values = [r.get("scores", {}).get(key) for r in result["receipts"] if r["row"]["model"] == model and r["row"]["caseId"] == case["id"]]
        valid = [abs(v) if absolute else v for v in values if isinstance(v, (int, float))]
        measured += len(valid)
        if len(valid) == protocol["trials"]:
            per_photo[case["photo"]].append(statistics.mean(valid))
    complete = all(len(per_photo[photo]) == len(cases) for photo, cases in by_photo.items())
    return {"photoWeightedMean": statistics.mean(statistics.mean(v) for v in per_photo.values()) if complete else None, "measured": measured}
for model in models:
    receipts = [r for r in result["receipts"] if r["row"]["model"] == model]
    tools = collections.Counter(step["tool"] for r in receipts for step in r.get("details", {}).get("steps", []))
    secondary.append({"model": model, "colourError": metric_for(model, "colorErr"), "depthError": metric_for(model, "depthErr"), "absoluteSupportGapCm": metric_for(model, "gapCm", True), "tiltDegrees": metric_for(model, "tiltDeg"), "modelCalls": sum(r["row"]["calls"] for r in receipts), "tools": dict(tools)})
(study / "secondary.json").write_text(json.dumps(secondary, indent=2))
def display(value):
    mean = value["photoWeightedMean"]
    return f"{mean:.4f} ({value['measured']})" if mean is not None else f"Unavailable ({value['measured']})"
secondary_rows = "".join(f"<tr><td>{s['model']}</td><td>{display(s['colourError'])}</td><td>{display(s['depthError'])}</td><td>{display(s['absoluteSupportGapCm'])}</td><td>{s['modelCalls']}</td><td>{sum(s['tools'].values())}</td></tr>" for s in secondary)
html = html.replace("<h2>Reference evidence</h2>", '<h2>Secondary measurements</h2><p>Errors use the same equal-photo weighting. Parentheses show measured trial counts. Missing evidence stays unavailable. Tool calls exclude the final submission.</p><table><tr><th>Model</th><th>Colour error</th><th>Depth error</th><th>Absolute support gap (cm)</th><th>API calls</th><th>Tool calls</th></tr>' + secondary_rows + '</table><p><a href="secondary.json">Secondary measurements and tool counts</a></p><h2>Reference evidence</h2>')
html = html.replace("</html>", '<h2>Measurement boundaries</h2><p>Every model starts with the same geometric auto-fit tool, so this study measures the model’s use of that tool and any subsequent refinement. Deterministic fits are memoized equally across trials. Timing excludes initial asset loading, input rendering and precomputation; it is not total world-generation latency. Costs cover the live language-model requests only, using configured standard token rates, and exclude the already purchased common 3D assets. Provider-side prompt caching is allowed and returned cached-token counts are retained. Output-response caching is bypassed. The same named reasoning level does not imply identical internal computation across vendors.</p><p>All four photographs were available during project development. These results establish behavior on this fixed course, not performance on unseen photographs. The Opus and Sonnet Kiro coding sessions are not treated as measured runtime subjects here. A separate Kiro harness comparison would need the same evidence and tool restrictions.</p></html>')
(study / "report.html").write_text(html)
environment = json.loads((study / "environment.json").read_text())
environment["reportPython"] = sys.version
environment["matplotlib"] = matplotlib.__version__
(study / "environment.json").write_text(json.dumps(environment, indent=2))
print(json.dumps({"figure": str(study / "comparison.png"), "timelines": copied, "attempts": len(result["receipts"])}))
