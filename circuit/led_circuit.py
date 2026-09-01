"""
Chip — Step 3 Circuit: ESP32 GPIO2 → 220Ω Resistor → LED → GND

Uses the real KiCad identifiers resolved during Step 2:
  Resistor : lib='R',              part='R'              (pins: 1, 2)
  LED      : lib='LED',            part='LED'            (pins: A=anode, K=cathode)
  ESP32    : lib='ESP32-PICO-D4',  part='ESP32-PICO-D4'  (pin: IO2)

Library path comes exclusively from KICAD_SYMBOL_DIR (no hard-coded Windows paths).
"""

import os
import sys
import json
import warnings

# ──────────────────────────────────────────────────────────────────────────────
# Helper: set up SKiDL search paths from KICAD_SYMBOL_DIR
# ──────────────────────────────────────────────────────────────────────────────
def _setup_skidl():
    symbol_dir = os.environ.get("KICAD_SYMBOL_DIR", "")
    if not symbol_dir or not os.path.exists(symbol_dir):
        raise EnvironmentError(
            f"KICAD_SYMBOL_DIR is not set or does not exist: {symbol_dir!r}"
        )

    # Must be set BEFORE importing skidl so it reads them on import
    os.environ.setdefault("KICAD8_SYMBOL_DIR", symbol_dir)
    os.environ.setdefault("KICAD7_SYMBOL_DIR", symbol_dir)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from skidl import KICAD, lib_search_paths, set_default_tool, reset
        reset()  # fresh circuit state

        # Root dir
        if symbol_dir not in lib_search_paths[KICAD]:
            lib_search_paths[KICAD].insert(0, symbol_dir)

        # All .kicad_symdir subdirectories (KiCad 8 layout)
        for root, dirs, _ in os.walk(symbol_dir):
            for d in dirs:
                if d.endswith(".kicad_symdir"):
                    full = os.path.join(root, d)
                    if full not in lib_search_paths[KICAD]:
                        lib_search_paths[KICAD].append(full)

        set_default_tool(KICAD)

    return symbol_dir


# ──────────────────────────────────────────────────────────────────────────────
# Main circuit builder
# ──────────────────────────────────────────────────────────────────────────────
def build_led_circuit():
    result = {
        "circuitName": "ESP32 GPIO2 → R 220Ω → LED → GND",
        "components": [],
        "connections": [],
        "ercWarnings": [],
        "ercErrors": [],
        "success": False,
        "error": None,
        "libraryPath": os.environ.get("KICAD_SYMBOL_DIR"),
    }

    try:
        symbol_dir = _setup_skidl()
        result["libraryPath"] = symbol_dir

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from skidl import Part, Net, ERC, KICAD, reset
            import io, contextlib

            # ── 1. Create parts using REAL KiCad identifiers ─────────────────
            esp32 = Part("ESP32-PICO-D4", "ESP32-PICO-D4", value="ESP32-PICO-D4")
            r1    = Part("R",             "R",             value="220")
            d1    = Part("LED",           "LED",           value="LED")

            result["components"] = [
                {
                    "ref":   esp32.ref,
                    "name":  esp32.name,
                    "lib":   "ESP32-PICO-D4",
                    "value": esp32.value,
                    "pins":  [p.name for p in esp32.pins],
                },
                {
                    "ref":   r1.ref,
                    "name":  r1.name,
                    "lib":   "R",
                    "value": r1.value,
                    "pins":  [p.name for p in r1.pins],
                },
                {
                    "ref":   d1.ref,
                    "name":  d1.name,
                    "lib":   "LED",
                    "value": d1.value,
                    "pins":  [p.name for p in d1.pins],
                },
            ]

            # ── 2. Create nets ────────────────────────────────────────────────
            gpio2_net = Net("GPIO2")
            mid_net   = Net("MID")    # resistor output → LED anode
            gnd_net   = Net("GND")

            # ── 3. Wire the circuit ───────────────────────────────────────────
            #   ESP32.IO2 → GPIO2 net
            gpio2_net += esp32["IO2"]

            #   GPIO2 net → R1 pin 1
            gpio2_net += r1[1]

            #   R1 pin 2 → MID net → LED anode (A)
            mid_net += r1[2]
            mid_net += d1["A"]

            #   LED cathode (K) → GND
            gnd_net += d1["K"]

            result["connections"] = [
                {
                    "net":   "GPIO2",
                    "nodes": [f"{esp32.ref}.IO2", f"{r1.ref}.1"],
                },
                {
                    "net":   "MID",
                    "nodes": [f"{r1.ref}.2", f"{d1.ref}.A"],
                },
                {
                    "net":   "GND",
                    "nodes": [f"{d1.ref}.K"],
                },
            ]

            # ── 4. ERC ────────────────────────────────────────────────────────
            erc_buf = io.StringIO()
            with contextlib.redirect_stderr(erc_buf):
                ERC()

            erc_output = erc_buf.getvalue()
            for line in erc_output.splitlines():
                line = line.strip()
                if not line:
                    continue
                if line.upper().startswith("ERC ERROR") or "error" in line.lower():
                    result["ercErrors"].append(line)
                elif line.upper().startswith("ERC WARNING") or "warning" in line.lower():
                    result["ercWarnings"].append(line)

            result["success"] = True

    except Exception as exc:
        result["error"] = str(exc)
        result["success"] = False

    return result


if __name__ == "__main__":
    output = build_led_circuit()
    print(json.dumps(output, indent=2))
