#!/usr/bin/env python3
"""Read-only Bubble.io discovery for geoquest app."""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[2]
BUBBLE_FILE = ROOT / "geoquest.bubble"
RAW = ROOT / "discovery" / "raw"
PARSED = ROOT / "discovery" / "parsed"
BASE_URL = os.environ.get("BUBBLE_BASE_URL", "https://geoquest.bubbleapps.io/version-test")
TOKEN = os.environ.get("BUBBLE_API_TOKEN", "")
API_DELAY = float(os.environ.get("API_DELAY_MS", "200")) / 1000


def api_get(path: str) -> dict | list | None:
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        return {"_error": e.code, "_body": body, "_url": url}
    except Exception as e:
        return {"_error": str(e), "_url": url}
    finally:
        time.sleep(API_DELAY)


def load_bubble() -> dict:
    with open(BUBBLE_FILE) as f:
        return json.load(f)


def bubble_type_name(display: str) -> str:
    """Convert display name to likely API typename (Bubble convention)."""
    return re.sub(r"[^a-z0-9_]", "", display.lower().replace(" ", "_"))


def parse_data_types(data: dict) -> list[dict]:
    types = []
    for tid, t in data.get("user_types", {}).items():
        fields = []
        for fid, f in t.get("fields", {}).items():
            fields.append({
                "id": fid,
                "name": f.get("display", f.get("name", fid)),
                "bubble_type": f.get("value", f.get("type", "unknown")),
                "is_list": f.get("is_list", False),
                "deleted": f.get("deleted", False),
            })
        types.append({
            "id": tid,
            "display": t.get("display", t.get("name", tid)),
            "api_typename_guess": bubble_type_name(t.get("display", tid)),
            "fields": [f for f in fields if not f.get("deleted")],
            "privacy_role": t.get("privacy_role", {}),
        })
    return types


def parse_option_sets(data: dict) -> list[dict]:
    result = []
    for oid, o in data.get("option_sets", {}).items():
        values = []
        for vid, v in o.get("values", {}).items():
            values.append({
                "id": vid,
                "display": v.get("display", v.get("name", vid)),
                "db_value": v.get("db_value", v.get("name")),
            })
        result.append({
            "id": oid,
            "display": o.get("display", o.get("name", oid)),
            "values": values,
        })
    return result


def summarize_action(action: dict) -> dict:
    return {
        "type": action.get("type"),
        "id": action.get("id"),
        "properties_keys": list(action.get("properties", {}).keys()),
    }


def parse_workflow(wf: dict) -> dict:
    actions = wf.get("actions", {})
    ordered = []
    for k in sorted(actions.keys(), key=lambda x: int(x) if str(x).isdigit() else x):
        ordered.append(summarize_action(actions[k]))
    return {
        "id": wf.get("id"),
        "type": wf.get("type"),
        "properties": {k: v for k, v in wf.get("properties", {}).items()
                       if k in ("wf_name", "event_name", "workflow_disabled", "expose", "auth_unecessary",
                                "auth_required", "parameters", "parameter_def", "ignore_privacy_rules",
                                "data_trigger_type", "data_type")},
        "actions": ordered,
        "action_count": len(ordered),
    }


def collect_workflows(obj, path="", results=None):
    if results is None:
        results = []
    if isinstance(obj, dict):
        if "type" in obj and "actions" in obj and obj.get("type") not in ("CustomDefinition",):
            evt_type = obj.get("type", "")
            if evt_type.endswith("Event") or evt_type in (
                "ButtonClicked", "PageLoaded", "InputChanged", "CheckboxChanged",
                "DropdownValueChanged", "PopupClosed", "PopupOpened", "ConditionTrue",
                "CustomEvent", "LoggedIn", "LoggedOut", "DoInterval", "ApiCall",
            ):
                wf = parse_workflow(obj)
                wf["source_path"] = path
                results.append(wf)
        for k, v in obj.items():
            if k == "workflows" and isinstance(v, dict):
                for wk, wv in v.items():
                    collect_workflows(wv, f"{path}/workflows/{wk}", results)
            elif k not in ("workflows",):
                collect_workflows(v, f"{path}/{k}" if path else k, results)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            collect_workflows(v, f"{path}[{i}]", results)
    return results


def parse_pages(data: dict) -> list[dict]:
    pages = []
    for pid, p in data.get("pages", {}).items():
        wf_count = len(collect_workflows(p.get("workflows", {}), f"pages/{pid}"))
        pages.append({
            "id": pid,
            "name": p.get("name", p.get("properties", {}).get("name", pid)),
            "properties": {
                k: p.get("properties", {}).get(k)
                for k in ("slug", "title", "description", "friendly_name", "width", "height")
                if p.get("properties", {}).get(k) is not None
            },
            "workflow_count": wf_count,
            "element_count": len(p.get("elements", {})),
        })
    return pages


def parse_api_events(data: dict) -> list[dict]:
    events = []
    for aid, a in data.get("api", {}).items():
        entry = parse_workflow(a) if "actions" in a else {"id": aid, "type": a.get("type")}
        entry["api_id"] = aid
        props = a.get("properties", {})
        entry["wf_name"] = props.get("wf_name") or props.get("event_name")
        entry["expose"] = props.get("expose")
        entry["auth"] = props.get("auth_unecessary") or props.get("auth_required")
        entry["data_trigger_type"] = props.get("data_trigger_type")
        entry["data_type"] = props.get("data_type")
        events.append(entry)
    return events


def parse_element_definitions(data: dict) -> list[dict]:
    defs = []
    for eid, e in data.get("element_definitions", {}).items():
        if not isinstance(e, dict):
            continue
        defs.append({
            "id": eid,
            "name": e.get("name"),
            "type": e.get("type"),
            "group_type": e.get("properties", {}).get("group_type"),
            "workflow_count": len(e.get("workflows", {}) or {}),
            "custom_states": list((e.get("custom_states") or {}).keys()),
        })
    return defs


def infer_field_type(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "number"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        if "address" in value and "lat" in value:
            return "geo_address"
        return "object"
    if isinstance(value, str):
        if re.match(r"^\d+x\d+$", value):
            return "thing_ref"
        if value.startswith("//") or value.startswith("http"):
            return "url"
        if "T" in value and value.endswith("Z"):
            return "date"
        return "text"
    return "unknown"


def probe_data_type(typename: str) -> dict:
    result = api_get(f"/api/1.1/obj/{typename}?limit=5&cursor=0")
    out = {"typename": typename, "accessible": False}
    if isinstance(result, dict) and "_error" in result:
        out["error"] = result["_error"]
        out["body"] = result.get("_body", "")[:300]
        return out
    response = result.get("response", result) if isinstance(result, dict) else {}
    results = response.get("results", [])
    out["accessible"] = True
    out["count"] = response.get("count", len(results))
    out["remaining"] = response.get("remaining", None)
    if results:
        sample = results[0]
        out["fields"] = {k: infer_field_type(v) for k, v in sample.items()}
        out["sample_id"] = sample.get("_id")
    return out


def probe_workflow(name: str) -> dict:
    result = api_get(f"/api/1.1/wf/{name}")
    return {"name": name, "response": result}


def main():
    PARSED.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "data-api").mkdir(exist_ok=True)

    print("Loading bubble file...")
    data = load_bubble()

    indexes = {
        "app": {
            "id": data.get("_id"),
            "version": data.get("app_version"),
            "creation_date": data.get("creation_date"),
            "last_change_date": data.get("last_change_date"),
        },
        "data_types": parse_data_types(data),
        "option_sets": parse_option_sets(data),
        "pages": parse_pages(data),
        "api_events": parse_api_events(data),
        "element_definitions": parse_element_definitions(data),
    }

    all_workflows = collect_workflows(data)
    indexes["workflows_total"] = len(all_workflows)
    wt = defaultdict(int)
    for w in all_workflows:
        wt[w["type"]] += 1
    indexes["workflows_by_type"] = dict(sorted(wt.items(), key=lambda x: -x[1]))

    for name, obj in indexes.items():
        if name.startswith("workflows"):
            continue
        out = PARSED / f"{name}.json"
        with open(out, "w") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
        print(f"Wrote {out}")

    with open(PARSED / "workflows_sample.json", "w") as f:
        json.dump(all_workflows[:100], f, indent=2, ensure_ascii=False)
    with open(PARSED / "workflows_all.json", "w") as f:
        json.dump(all_workflows, f, indent=2, ensure_ascii=False)
    print(f"Wrote workflows: {len(all_workflows)} total")

    if TOKEN:
        print("\nProbing Data API (read-only)...")
        api_results = []
        typenames = set()
        for dt in indexes["data_types"]:
            typenames.add(dt["api_typename_guess"])
            typenames.add(dt["id"])
        typenames.add("user")
        for tn in sorted(typenames):
            r = probe_data_type(tn)
            api_results.append(r)
            status = "OK" if r.get("accessible") else f"ERR {r.get('error')}"
            print(f"  {tn}: {status}")
        with open(RAW / "data-api" / "probe_results.json", "w") as f:
            json.dump(api_results, f, indent=2)

        print("\nProbing Workflow API (GET only)...")
        wf_names = [e["wf_name"] for e in indexes["api_events"] if e.get("wf_name")]
        wf_probes = []
        for name in wf_names:
            wf_probes.append(probe_workflow(name))
            print(f"  wf/{name}: probed")
        (RAW / "workflow-api").mkdir(parents=True, exist_ok=True)
        wf_path = RAW / "workflow-api" / "probe_results.json"
        with open(wf_path, "w") as f:
            json.dump(wf_probes, f, indent=2)
    else:
        print("No API token — skipping live probes")

    print("\nDone.")


if __name__ == "__main__":
    main()