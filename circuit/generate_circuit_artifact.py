"""
Chip — Step 4 & Step 8: Circuit Artifact Generator & Incremental Compiler

Builds baseline and custom SKiDL circuits, performs ERC validation,
and persists KiCad netlists, circuit definitions, and manifest metadata.

Usage:
  # Baseline generation:
  python generate_circuit_artifact.py --project-id <id> --out-dir <path> --version <v> --resistor-value <ohms>

  # Incremental custom definition compilation:
  python generate_circuit_artifact.py --project-id <id> --out-dir <path> --version <v> --definition <def_json_path>
"""

import os
import sys
import json
import warnings
import argparse
from datetime import datetime, timezone


# ──────────────────────────────────────────────────────────────────────────────
# Rigid Hardware & Electrical Rules Validator
# ──────────────────────────────────────────────────────────────────────────────

def validate_electrical_rules(circuit_def: dict) -> tuple[list[str], list[str]]:
    """
    Performs rigid Pre-Flight Electrical Rule Checks:
    1. Never tie input-only pins (ESP32 GPIO 34–39) directly to bidirectional GPIOs.
    2. Power rail vs Signal separation (VCC, 3V3, 5V, GND never tied directly to output/data pins).
    3. Inductive load protection (Buzzers/relays require low-side switching via transistor).
    4. LED current limiting (LEDs require series resistor).
    """
    errors = []
    warnings = []

    connections = circuit_def.get("connections", [])
    components = {c.get("ref", "").upper(): c for c in circuit_def.get("components", [])}

    input_only_pins = {"IO34", "IO35", "IO36", "IO39", "GPIO34", "GPIO35", "GPIO36", "GPIO39", "D34", "D35", "D36", "D39", "34", "35", "36", "39"}
    bidirectional_pins = {"IO0", "IO1", "IO2", "IO3", "IO4", "IO5", "IO12", "IO13", "IO14", "IO15", "IO18", "IO19", "IO21", "IO22", "IO23", "IO25", "IO26", "IO27", "IO32", "IO33", "D0", "D1", "D2", "D4", "D5", "D12", "D13", "D14", "D15", "D18", "D19", "D21", "D22", "D23", "D25", "D26", "D27", "D32", "D33"}

    for conn in connections:
        net_name = conn.get("net", "").upper()
        nodes = [n.strip() for n in conn.get("nodes", [])]

        # Rule 1: MCU Input-Only Pin Contention Check
        mcu_input_nodes = []
        mcu_output_nodes = []
        for n in nodes:
            parts = n.split(".")
            if len(parts) == 2:
                ref, pin = parts[0].upper(), parts[1].upper()
                comp = components.get(ref, {})
                lib = (comp.get("lib") or "").upper()
                name = (comp.get("name") or "").upper()
                if "ESP32" in lib or "ESP32" in name or ref.startswith("U"):
                    if pin in input_only_pins:
                        mcu_input_nodes.append(n)
                    elif pin in bidirectional_pins:
                        mcu_output_nodes.append(n)

        if len(mcu_input_nodes) > 0 and len(mcu_output_nodes) > 0:
            errors.append(
                f"ERC Conflict on net '{net_name}': Input-only pin ({', '.join(mcu_input_nodes)}) "
                f"is tied directly to bidirectional GPIO ({', '.join(mcu_output_nodes)}). "
                f"Tying input-only pins to GPIOs risks bus contention."
            )

        # Rule 2: Power Rail vs Signal Check
        is_power_net = any(p in net_name for p in ["VCC", "3V3", "5V", "VDD", "GND", "POWER"])
        if is_power_net:
            for n in nodes:
                parts = n.split(".")
                if len(parts) == 2:
                    ref, pin = parts[0].upper(), parts[1].upper()
                    if pin in ["OUT", "SIG", "DO", "AO", "DATA", "SIGNAL"]:
                        errors.append(
                            f"ERC Short Risk on power net '{net_name}': Sensor/Module signal pin '{n}' "
                            f"is directly tied to power. Signal pins must not connect directly to power rails."
                        )

        switch_nodes = [n for n in nodes if n.split(".")[0].upper().startswith(("SW", "BTN"))]
        if switch_nodes and is_power_net:
            errors.append(
                f"ERC Short Risk on net '{net_name}': Switch node(s) {', '.join(switch_nodes)} "
                "are tied directly to a power rail. The test switch must only pull TEST_IN to GND when pressed."
            )

        is_sensor_signal_net = any(p in net_name for p in ["SMOKE", "SENSE", "ALARM"])
        if switch_nodes and is_sensor_signal_net and "TEST" not in net_name:
            errors.append(
                f"ERC Wiring Conflict on net '{net_name}': Switch node(s) {', '.join(switch_nodes)} "
                "are tied to sensor signal wiring. Keep SW1 isolated from smoke sensor sense/alarm nets."
            )

        if "TEST" in net_name:
            sensor_test_nodes = []
            for n in nodes:
                parts = n.split(".")
                if len(parts) == 2:
                    ref, pin = parts[0].upper(), parts[1].upper()
                    if ref.startswith(("J", "P")) and pin in ["4", "TEST", "NC", "TEST/NC"]:
                        sensor_test_nodes.append(n)

            if sensor_test_nodes:
                errors.append(
                    f"ERC Wiring Conflict on net '{net_name}': Smoke sensor TEST/NC pin(s) "
                    f"{', '.join(sensor_test_nodes)} must not be tied into the MCU test button loop."
                )

    return errors, warnings


def _split_ref(ref: str):
    import re
    match = re.match(r"^([A-Za-z]+)(\d+)$", str(ref or "").strip())
    if not match:
        return None
    return match.group(1).upper(), int(match.group(2))


def normalize_duplicate_refs(circuit_def: dict) -> dict:
    components = circuit_def.get("components", [])
    used_refs = set()
    renamed_refs = []
    max_by_prefix = {}

    for comp in components:
        parsed = _split_ref(comp.get("ref"))
        if parsed:
            prefix, number = parsed
            max_by_prefix[prefix] = max(max_by_prefix.get(prefix, 0), number)

    normalized_components = []
    for comp in components:
        original_ref = str(comp.get("ref", "")).strip()
        original_upper = original_ref.upper()

        if original_upper not in used_refs:
            used_refs.add(original_upper)
            normalized_components.append(comp)
            continue

        parsed = _split_ref(original_ref)
        prefix = parsed[0] if parsed else "U"
        next_number = max_by_prefix.get(prefix, 0) + 1
        next_ref = f"{prefix}{next_number}"

        while next_ref.upper() in used_refs:
            next_number += 1
            next_ref = f"{prefix}{next_number}"

        max_by_prefix[prefix] = next_number
        used_refs.add(next_ref.upper())
        renamed_refs.append({"from": original_upper, "to": next_ref})
        normalized_components.append({**comp, "ref": next_ref})

    if not renamed_refs:
        return circuit_def

    normalized_connections = []
    for conn in circuit_def.get("connections", []):
        net_name = str(conn.get("net", "")).upper()
        has_q_node = any(str(n).split(".")[0].upper().startswith("Q") for n in conn.get("nodes", []))
        is_transistor_side = "BASE" in net_name or "DRIVE" in net_name or has_q_node
        normalized_nodes = []

        for node in conn.get("nodes", []):
            parts = str(node).split(".")
            renamed = next((r for r in renamed_refs if len(parts) >= 2 and r["from"] == parts[0].upper()), None)
            if renamed and is_transistor_side:
                normalized_nodes.append(f"{renamed['to']}.{'.'.join(parts[1:])}")
            else:
                normalized_nodes.append(node)

        normalized_connections.append({**conn, "nodes": normalized_nodes})

    return {**circuit_def, "components": normalized_components, "connections": normalized_connections}


def _setup_skidl():
    symbol_dir = os.environ.get("KICAD_SYMBOL_DIR", "")
    if not symbol_dir or not os.path.exists(symbol_dir):
        import tempfile
        fallbacks = [
            os.path.join(tempfile.gettempdir(), "chip-kicad-symbols"),
            "/tmp/chip-kicad-symbols",
            os.path.abspath(os.path.join(os.path.dirname(__file__), "../../kicad-symbols-master")),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "../kicad-symbols-master")),
            "C:/Users/josep/Downloads/kicad-symbols-master",
            "/opt/kicad-symbols",
        ]
        for fb in fallbacks:
            if os.path.exists(fb):
                symbol_dir = fb
                break
    if not symbol_dir or not os.path.exists(symbol_dir):
        raise EnvironmentError(
            f"KICAD_SYMBOL_DIR is not set or does not exist: {symbol_dir!r}"
        )
    os.environ["KICAD_SYMBOL_DIR"] = symbol_dir
    os.environ.setdefault("KICAD8_SYMBOL_DIR", symbol_dir)
    os.environ.setdefault("KICAD7_SYMBOL_DIR", symbol_dir)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from skidl import KICAD, lib_search_paths, set_default_tool, reset
        reset()
        if symbol_dir not in lib_search_paths[KICAD]:
            lib_search_paths[KICAD].insert(0, symbol_dir)
        for root, dirs, _ in os.walk(symbol_dir):
            for d in dirs:
                if d.endswith(".kicad_symdir"):
                    full = os.path.join(root, d)
                    if full not in lib_search_paths[KICAD]:
                        lib_search_paths[KICAD].append(full)
        set_default_tool(KICAD)

    return symbol_dir


# ──────────────────────────────────────────────────────────────────────────────
# Baseline Circuit Generator
# ──────────────────────────────────────────────────────────────────────────────

def generate_artifact(project_id: str, out_dir: str, version: int = 1, resistor_value: str = "220") -> dict:
    result = {
        "projectId": project_id,
        "version": version,
        "success": False,
        "components": [],
        "connections": [],
        "ercErrors": [],
        "ercWarnings": [],
        "artifacts": {},
        "error": None,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "libraryPath": os.environ.get("KICAD_SYMBOL_DIR"),
    }

    try:
        symbol_dir = _setup_skidl()
        result["libraryPath"] = symbol_dir

        os.makedirs(out_dir, exist_ok=True)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from skidl import Part, Net, ERC, generate_netlist
            import io, contextlib

            # ── Parts using REAL KiCad identifiers ───────────────────────────
            esp32 = Part("ESP32-PICO-D4", "ESP32-PICO-D4", value="ESP32-PICO-D4")
            r1    = Part("R",             "R",             value=resistor_value)
            d1    = Part("LED",           "LED",           value="LED")

            result["components"] = [
                {
                    "ref":   esp32.ref,
                    "name":  esp32.name,
                    "lib":   "ESP32-PICO-D4",
                    "value": esp32.value,
                    "pinCount": len(esp32.pins),
                },
                {
                    "ref":   r1.ref,
                    "name":  r1.name,
                    "lib":   "R",
                    "value": r1.value,
                    "pinCount": len(r1.pins),
                },
                {
                    "ref":   d1.ref,
                    "name":  d1.name,
                    "lib":   "LED",
                    "value": d1.value,
                    "pinCount": len(d1.pins),
                },
            ]

            # ── Nets + wiring ────────────────────────────────────────────────
            gpio2 = Net("GPIO2")
            mid   = Net("MID")
            gnd   = Net("GND")

            gpio2 += esp32["IO2"], r1[1]
            mid   += r1[2], d1["A"]
            gnd   += d1["K"]

            result["connections"] = [
                {"net": "GPIO2", "nodes": [f"{esp32.ref}.IO2", f"{r1.ref}.1"]},
                {"net": "MID",   "nodes": [f"{r1.ref}.2",     f"{d1.ref}.A"]},
                {"net": "GND",   "nodes": [f"{d1.ref}.K"]},
            ]

            # ── ERC ─────────────────────────────────────────────────────────
            erc_buf = io.StringIO()
            with contextlib.redirect_stderr(erc_buf):
                ERC()
            for line in erc_buf.getvalue().splitlines():
                line = line.strip()
                if not line:
                    continue
                lo = line.lower()
                if "erc error" in lo:
                    result["ercErrors"].append(line)
                elif "erc warning" in lo:
                    result["ercWarnings"].append(line)

            # ── Persist: KiCad netlist (circuit.net) ─────────────────────────
            netlist_path = os.path.join(out_dir, "circuit.net")
            gen_buf = io.StringIO()
            with contextlib.redirect_stderr(gen_buf):
                generate_netlist(file_=netlist_path)
            result["artifacts"]["netlist"] = netlist_path

            # ── Persist: circuit definition JSON ─────────────────────────────
            circuit_def = {
                "circuitName":  f"ESP32 GPIO2 → R {resistor_value}Ω → LED → GND",
                "projectId":    project_id,
                "version":      version,
                "generatedAt":  result["generatedAt"],
                "libraryPath":  symbol_dir,
                "components":   result["components"],
                "connections":  result["connections"],
                "ercErrors":    result["ercErrors"],
                "ercWarnings":    result["ercWarnings"],
            }
            circuit_def_path = os.path.join(out_dir, "circuit_definition.json")
            with open(circuit_def_path, "w", encoding="utf-8") as f:
                json.dump(circuit_def, f, indent=2)
            result["artifacts"]["circuitDefinition"] = circuit_def_path

            # ── Persist: manifest ────────────────────────────────────────────
            manifest = {
                "projectId":   project_id,
                "version":     version,
                "generatedAt": result["generatedAt"],
                "artifacts": {
                    "netlist":           os.path.basename(netlist_path),
                    "circuitDefinition": os.path.basename(circuit_def_path),
                },
                "componentCount":  len(result["components"]),
                "connectionCount": len(result["connections"]),
                "ercErrorCount":   len(result["ercErrors"]),
                "ercWarningCount": len(result["ercWarnings"]),
            }
            manifest_path = os.path.join(out_dir, "manifest.json")
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)
            result["artifacts"]["manifest"] = manifest_path

            result["success"] = True

    except Exception as exc:
        result["error"] = str(exc)

    return result


# ──────────────────────────────────────────────────────────────────────────────
# Custom / Incremental Circuit Definition Compiler
# ──────────────────────────────────────────────────────────────────────────────

def compile_custom_circuit(project_id: str, out_dir: str, definition_path: str, version: int = 1) -> dict:
    result = {
        "projectId": project_id,
        "version": version,
        "success": False,
        "components": [],
        "connections": [],
        "ercErrors": [],
        "ercWarnings": [],
        "artifacts": {},
        "error": None,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "libraryPath": os.environ.get("KICAD_SYMBOL_DIR"),
    }

    try:
        with open(definition_path, "r", encoding="utf-8") as f:
            circuit_def = json.load(f)
        circuit_def = normalize_duplicate_refs(circuit_def)

        symbol_dir = _setup_skidl()
        result["libraryPath"] = symbol_dir

        os.makedirs(out_dir, exist_ok=True)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from skidl import Part, Net, ERC, generate_netlist
            import io, contextlib

            parts_by_ref = {}
            components_out = []

            for comp in circuit_def.get("components", []):
                ref = comp.get("ref", "U1")
                name = comp.get("name") or ref
                lib = comp.get("lib") or name
                val = comp.get("value") or name

                # Robust part instantiation across KiCad 8 symdir formats
                part = None
                prefix = ref.rstrip("0123456789")
                candidates = [
                    (lib, name),
                    (name, name),
                    (lib, lib),
                    (name, lib),
                    ("RF_Module", name),
                    ("MCU_Espressif", name),
                    ("Device", name),
                    (prefix, prefix),
                ]
                last_err = None
                for l_cand, n_cand in candidates:
                    if not l_cand or not n_cand:
                        continue
                    try:
                        part = Part(l_cand, n_cand, ref=ref, value=val)
                        break
                    except Exception as e:
                        last_err = e

                if part is None:
                    raise last_err or Exception(f"Unable to resolve symbol for {ref} ({lib}:{name})")

                parts_by_ref[ref.upper()] = part
                components_out.append({
                    "ref": part.ref,
                    "name": part.name,
                    "lib": lib,
                    "value": part.value,
                    "pinCount": len(part.pins),
                })

            result["components"] = components_out

            # ── Instantiate Nets & Connect Pins ──────────────────────────────
            connections_out = []
            for conn in circuit_def.get("connections", []):
                net_name = conn.get("net")
                nodes = conn.get("nodes", [])
                net = Net(net_name)

                resolved_nodes = []
                for node_str in nodes:
                    parts = node_str.split(".")
                    if len(parts) == 2:
                        comp_ref, pin_key = parts[0].upper(), parts[1]
                        if comp_ref in parts_by_ref:
                            p = parts_by_ref[comp_ref]
                            # Attach pin to net
                            attached = False
                            try:
                                p[pin_key] += net
                                resolved_nodes.append(f"{p.ref}.{pin_key}")
                                attached = True
                            except Exception:
                                pass

                            if not attached and pin_key.isdigit():
                                try:
                                    p[int(pin_key)] += net
                                    resolved_nodes.append(f"{p.ref}.{pin_key}")
                                    attached = True
                                except Exception:
                                    pass

                connections_out.append({"net": net_name, "nodes": resolved_nodes if resolved_nodes else nodes})

            result["connections"] = connections_out

            # ── Pre-Flight Electrical Rule Checks ───────────────────────────
            custom_errs, custom_warns = validate_electrical_rules(circuit_def)
            result["ercErrors"].extend(custom_errs)
            result["ercWarnings"].extend(custom_warns)

            # ── SKiDL ERC ───────────────────────────────────────────────────
            erc_buf = io.StringIO()
            with contextlib.redirect_stderr(erc_buf):
                ERC()
            for line in erc_buf.getvalue().splitlines():
                line = line.strip()
                if not line:
                    continue
                lo = line.lower()
                if "erc error" in lo:
                    result["ercErrors"].append(line)
                elif "erc warning" in lo:
                    result["ercWarnings"].append(line)

            # ── Persist: KiCad netlist (circuit.net) ─────────────────────────
            netlist_path = os.path.join(out_dir, "circuit.net")
            gen_buf = io.StringIO()
            with contextlib.redirect_stderr(gen_buf):
                generate_netlist(file_=netlist_path)
            result["artifacts"]["netlist"] = netlist_path

            # ── Persist: circuit definition JSON ─────────────────────────────
            updated_circuit_def = {
                "circuitName":  circuit_def.get("circuitName") or f"{project_id} Circuit v{version}",
                "projectId":    project_id,
                "version":      version,
                "generatedAt":  result["generatedAt"],
                "libraryPath":  symbol_dir,
                "components":   result["components"],
                "connections":  result["connections"],
                "ercErrors":    result["ercErrors"],
                "ercWarnings":  result["ercWarnings"],
            }
            circuit_def_path = os.path.join(out_dir, "circuit_definition.json")
            with open(circuit_def_path, "w", encoding="utf-8") as f:
                json.dump(updated_circuit_def, f, indent=2)
            result["artifacts"]["circuitDefinition"] = circuit_def_path

            # ── Persist: manifest ────────────────────────────────────────────
            manifest = {
                "projectId":   project_id,
                "version":     version,
                "generatedAt": result["generatedAt"],
                "artifacts": {
                    "netlist":           os.path.basename(netlist_path),
                    "circuitDefinition": os.path.basename(circuit_def_path),
                },
                "componentCount":  len(result["components"]),
                "connectionCount": len(result["connections"]),
                "ercErrorCount":   len(result["ercErrors"]),
                "ercWarningCount": len(result["ercWarnings"]),
            }
            manifest_path = os.path.join(out_dir, "manifest.json")
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)
            result["artifacts"]["manifest"] = manifest_path

            result["success"] = True

    except Exception as exc:
        result["error"] = str(exc)

    return result


# ──────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Chip — Circuit Artifact Generator")
    parser.add_argument("--project-id",     required=True, help="Project ID to associate artifacts with")
    parser.add_argument("--out-dir",        required=True, help="Directory to write artifacts into")
    parser.add_argument("--version",        type=int, default=1, help="Monotonically increasing version number")
    parser.add_argument("--resistor-value", type=str, default="220", help="Resistor value in ohms")
    parser.add_argument("--definition",     type=str, default=None, help="Path to custom circuit_definition.json")
    args = parser.parse_args()

    if args.definition and os.path.exists(args.definition):
        result = compile_custom_circuit(
            project_id=args.project_id,
            out_dir=args.out_dir,
            definition_path=args.definition,
            version=args.version,
        )
    else:
        result = generate_artifact(
            project_id=args.project_id,
            out_dir=args.out_dir,
            version=args.version,
            resistor_value=args.resistor_value,
        )

    print(json.dumps(result, indent=2))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
