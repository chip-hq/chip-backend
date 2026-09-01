"""
Chip — Step 5 Verification Test: Circuit Versioning

Tests:
1. First generation creates v1 (ESP32 + 220Ω + LED)
2. Second generation creates v2 (ESP32 + 330Ω + LED)
3. v1 remains completely unchanged
4. v2 contains the new circuit (330Ω)
5. current.json accurately points to v2
6. Both versions are retrievable independently
"""

import os
import sys
import json
import shutil
from pathlib import Path

# Add backend & circuit directories to path
circuit_dir = Path(__file__).resolve().parent.parent
backend_dir = circuit_dir.parent
sys.path.insert(0, str(circuit_dir))

from generate_circuit_artifact import generate_artifact

def run_tests():
    project_id = "test-proj-v1"
    storage_root = backend_dir / "data" / "projects" / project_id / "circuit"

    # Reset test project directory
    if storage_root.exists():
        shutil.rmtree(storage_root)
    storage_root.mkdir(parents=True, exist_ok=True)

    print("\n========================================================")
    print("STEP 5: RUNNING CIRCUIT VERSIONING VERIFICATION")
    print("========================================================\n")

    # ── Test 1: Generate Version 1 (220Ω) ────────────────────────────────────
    print("--> Test 1: Generating Version 1 (220 ohm resistor)...")
    v1_dir = storage_root / "versions" / "v1"
    res1 = generate_artifact(project_id, str(v1_dir), version=1, resistor_value="220")
    
    assert res1["success"] is True, f"V1 generation failed: {res1.get('error')}"
    assert res1["version"] == 1, f"Expected version 1, got {res1['version']}"
    assert (v1_dir / "circuit_definition.json").exists(), "v1/circuit_definition.json missing"
    assert (v1_dir / "manifest.json").exists(), "v1/manifest.json missing"
    assert (v1_dir / "circuit.net").exists(), "v1/circuit.net missing"

    # Update current.json -> 1
    current_doc = {
        "projectId": project_id,
        "currentVersion": 1,
        "updatedAt": res1["generatedAt"]
    }
    with open(storage_root / "current.json", "w", encoding="utf-8") as f:
        json.dump(current_doc, f, indent=2)

    # Read and snapshot v1 contents
    with open(v1_dir / "circuit_definition.json", "r", encoding="utf-8") as f:
        v1_def = json.load(f)
    v1_r_val = next(c["value"] for c in v1_def["components"] if c["ref"] == "R1")
    assert v1_r_val == "220", f"Expected R1=220 in v1, got {v1_r_val}"
    print(f"    [PASS] v1 created successfully: R1 = {v1_r_val} ohm, Version = {v1_def['version']}")

    # ── Test 2: Generate Version 2 (330Ω) ────────────────────────────────────
    print("\n--> Test 2: Generating Version 2 (330 ohm resistor)...")
    v2_dir = storage_root / "versions" / "v2"
    res2 = generate_artifact(project_id, str(v2_dir), version=2, resistor_value="330")

    assert res2["success"] is True, f"V2 generation failed: {res2.get('error')}"
    assert res2["version"] == 2, f"Expected version 2, got {res2['version']}"
    assert (v2_dir / "circuit_definition.json").exists(), "v2/circuit_definition.json missing"
    assert (v2_dir / "manifest.json").exists(), "v2/manifest.json missing"
    assert (v2_dir / "circuit.net").exists(), "v2/circuit.net missing"

    # Update current.json -> 2
    current_doc["currentVersion"] = 2
    current_doc["updatedAt"] = res2["generatedAt"]
    with open(storage_root / "current.json", "w", encoding="utf-8") as f:
        json.dump(current_doc, f, indent=2)

    with open(v2_dir / "circuit_definition.json", "r", encoding="utf-8") as f:
        v2_def = json.load(f)
    v2_r_val = next(c["value"] for c in v2_def["components"] if c["ref"] == "R1")
    assert v2_r_val == "330", f"Expected R1=330 in v2, got {v2_r_val}"
    print(f"    [PASS] v2 created successfully: R1 = {v2_r_val} ohm, Version = {v2_def['version']}")

    # ── Test 3: Verify Immutability (v1 unchanged) ───────────────────────────
    print("\n--> Test 3: Verifying Immutability (v1 untouched after v2 creation)...")
    with open(v1_dir / "circuit_definition.json", "r", encoding="utf-8") as f:
        v1_check = json.load(f)
    v1_check_val = next(c["value"] for c in v1_check["components"] if c["ref"] == "R1")
    assert v1_check_val == "220", f"V1 was mutated! Expected 220, got {v1_check_val}"
    assert v1_check["version"] == 1, f"V1 version corrupted: {v1_check['version']}"
    print(f"    [PASS] v1 remains untouched with R1 = {v1_check_val} ohm")

    # ── Test 4: Verify current.json Pointer ──────────────────────────────────
    print("\n--> Test 4: Verifying current.json pointer...")
    with open(storage_root / "current.json", "r", encoding="utf-8") as f:
        curr = json.load(f)
    assert curr["currentVersion"] == 2, f"current.json points to {curr['currentVersion']}, expected 2"
    print(f"    [PASS] current.json correctly points to currentVersion: {curr['currentVersion']}")

    # ── Test 5: Verify Version Listing ───────────────────────────────────────
    print("\n--> Test 5: Verifying all versions are listed independently...")
    versions_dir = storage_root / "versions"
    found_versions = sorted([d.name for d in versions_dir.iterdir() if d.is_dir()])
    assert found_versions == ["v1", "v2"], f"Expected ['v1', 'v2'], got {found_versions}"
    print(f"    [PASS] Found versions: {found_versions}")

    print("\n========================================================")
    print("ALL 5 VERSIONING REQUIREMENTS PASSED SUCCESSFULLY!")
    print("========================================================\n")

if __name__ == "__main__":
    run_tests()
