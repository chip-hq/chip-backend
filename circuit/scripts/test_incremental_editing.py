"""
Chip — Step 8 Incremental Circuit Editing Test Suite
Tests fine-grained editing APIs: add_component, connect_pins, update_component, disconnect_pins, remove_component.
"""

import sys
import json
import urllib.request

BASE_URL = "http://localhost:3000"

def post(url, data):
    req = urllib.request.Request(f"{BASE_URL}{url}",
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))

def delete(url, data=None):
    req = urllib.request.Request(f"{BASE_URL}{url}",
        data=json.dumps(data or {}).encode("utf-8") if data else None,
        headers={"Content-Type": "application/json"},
        method="DELETE")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))

def patch(url, data):
    req = urllib.request.Request(f"{BASE_URL}{url}",
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="PATCH")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))

def get(url):
    with urllib.request.urlopen(f"{BASE_URL}{url}") as r:
        return json.loads(r.read().decode("utf-8"))

def run_tests():
    print("=== Step 8: Incremental Circuit Editing Test Suite ===")
    pId = "project-1"

    # 1. Start baseline
    print("1. Generating baseline circuit...")
    base = post(f"/api/projects/{pId}/circuit/generate", {"resistorValue": "220"})
    print(f"   -> Created v{base.get('version')} (parts: {len(base.get('components', []))}, nets: {len(base.get('connections', []))})")

    # 2. Add Capacitor C1
    print("2. Adding capacitor C1 (100nF)...")
    add_c1 = post(f"/api/projects/{pId}/circuit/components", {
        "ref": "C1",
        "lib": "Device",
        "part": "C",
        "value": "100nF"
    })
    assert add_c1.get("success"), f"Failed to add C1: {add_c1}"
    print(f"   -> Added C1, new version: v{add_c1.get('version')}")

    # 3. Connect C1 to 3V3 and GND
    print("3. Connecting C1.1 to U1.3V3...")
    conn_3v3 = post(f"/api/projects/{pId}/circuit/connections", {
        "net": "3V3",
        "fromNode": "U1.3V3",
        "toNode": "C1.1"
    })
    assert conn_3v3.get("success"), f"Failed to connect 3V3: {conn_3v3}"
    print(f"   -> Connected 3V3, new version: v{conn_3v3.get('version')}")

    print("4. Connecting C1.2 to GND...")
    conn_gnd = post(f"/api/projects/{pId}/circuit/connections", {
        "net": "GND",
        "fromNode": "C1.2"
    })
    assert conn_gnd.get("success"), f"Failed to connect GND: {conn_gnd}"
    print(f"   -> Connected GND, new version: v{conn_gnd.get('version')}")

    # 5. Update Resistor R1
    print("5. Updating R1 value to 470...")
    upd_r1 = patch(f"/api/projects/{pId}/circuit/components/R1", {
        "value": "470"
    })
    assert upd_r1.get("success"), f"Failed to update R1: {upd_r1}"
    print(f"   -> Updated R1, new version: v{upd_r1.get('version')}")

    # 6. Validate (ERC)
    print("6. Validating circuit (ERC)...")
    val = post(f"/api/projects/{pId}/circuit/validate", {})
    print(f"   -> ERC Valid: {val.get('valid')}, errors: {val.get('ercErrors')}")

    # 7. Check Active Circuit Definition
    print("7. Inspecting active circuit...")
    active = get(f"/api/projects/{pId}/circuit")
    def_data = active.get("definition", {})
    comp_refs = [c.get("ref") for c in def_data.get("components", [])]
    print(f"   -> Current version: v{active.get('currentVersion')}, components: {comp_refs}")
    assert "C1" in comp_refs
    assert "R1" in comp_refs
    assert "U1" in comp_refs

    # 8. Disconnect C1.1
    print("8. Disconnecting C1.1 from 3V3...")
    disc = delete(f"/api/projects/{pId}/circuit/connections", {
        "net": "3V3",
        "node": "C1.1"
    })
    assert disc.get("success"), f"Failed to disconnect C1.1: {disc}"
    print(f"   -> Disconnected C1.1, new version: v{disc.get('version')}")

    # 9. Remove C1
    print("9. Removing component C1...")
    rem_c1 = delete(f"/api/projects/{pId}/circuit/components/C1")
    assert rem_c1.get("success"), f"Failed to remove C1: {rem_c1}"
    print(f"   -> Removed C1, new version: v{rem_c1.get('version')}")

    # 10. Final validation
    print("10. Final circuit check...")
    final_active = get(f"/api/projects/{pId}/circuit")
    final_refs = [c.get("ref") for c in final_active.get("definition", {}).get("components", [])]
    print(f"   -> Final components: {final_refs}")
    assert "C1" not in final_refs
    print("=== All Step 8 Incremental Editing Tests PASSED! ===")

if __name__ == "__main__":
    run_tests()
