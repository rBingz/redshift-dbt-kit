# Prints the part of a dbt manifest.json that one model's card needs, as a small manifest of the
# same shape: the model, the names of its parents and children, and its child_map entry.
# The mod reads files of 4 MiB at most; a big project's manifest is larger.
# Usage: model_card.py <manifest.json> <model name>
import json
import sys

path, name = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    manifest = json.load(f)

nodes = manifest.get("nodes", {})
out = {"metadata": {"generated_at": manifest.get("metadata", {}).get("generated_at")}, "nodes": {}, "child_map": {}}
found = next((uid for uid, n in nodes.items() if n.get("resource_type") == "model" and n.get("name") == name), None)
if found is not None:
    node = nodes[found]
    parents = node.get("depends_on", {}).get("nodes", [])
    children = manifest.get("child_map", {}).get(found, [])
    for uid in parents + children:
        if uid in nodes:
            out["nodes"][uid] = {"name": nodes[uid].get("name"), "resource_type": nodes[uid].get("resource_type")}
    out["nodes"][found] = {
        "name": node.get("name"),
        "resource_type": "model",
        "description": node.get("description"),
        "relation_name": node.get("relation_name"),
        "config": {"materialized": node.get("config", {}).get("materialized")},
        "tags": node.get("tags", []),
        "depends_on": {"nodes": parents},
        "columns": {c: {"description": v.get("description")} for c, v in node.get("columns", {}).items()},
    }
    out["child_map"][found] = children

json.dump(out, sys.stdout)
