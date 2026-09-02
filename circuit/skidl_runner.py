"""
Chip — SKiDL Circuit Runner
Initializes SKiDL with KiCad symbol libraries located via KICAD_SYMBOL_DIR.
"""

import os
import sys
import json
import argparse
from pathlib import Path

def get_kicad_symbol_dir():
    """
    Resolve the KiCad symbols directory from environment or default locations.
    """
    env_dir = os.environ.get("KICAD_SYMBOL_DIR")
    if env_dir and os.path.exists(env_dir):
        return os.path.abspath(env_dir)
    # Common local and system fallback paths
    fallbacks = [
        # Relative to project root
        Path(__file__).resolve().parent.parent.parent / "kicad-symbols-master",
        Path(__file__).resolve().parent.parent / "kicad-symbols-master",
        Path(__file__).resolve().parent.parent.parent / "kicad-libraries" / "kicad-symbols",
        # Production container path
        Path("/opt/kicad-symbols"),
        # Windows KiCad 8 / 7 default installation
        Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "KiCad" / "8.0" / "share" / "kicad" / "symbols",
        Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "KiCad" / "7.0" / "share" / "kicad" / "symbols",
        # Linux / macOS standard paths
        Path("/usr/share/kicad/symbols"),
        Path("/Library/Application Support/kicad/symbols"),
    ]

    for p in fallbacks:
        if p.exists():
            return str(p)

    return env_dir or "/opt/kicad-symbols"

def configure_skidl():
    """
    Configures SKiDL library search paths with KICAD_SYMBOL_DIR.
    """
    try:
        symbol_dir = get_kicad_symbol_dir()
        if symbol_dir and os.path.exists(symbol_dir):
            os.environ.setdefault("KICAD_SYMBOL_DIR", symbol_dir)
            os.environ.setdefault("KICAD8_SYMBOL_DIR", symbol_dir)
            os.environ.setdefault("KICAD7_SYMBOL_DIR", symbol_dir)

        from skidl import KICAD, lib_search_paths, set_default_tool
        
        if symbol_dir and os.path.exists(symbol_dir):
            if symbol_dir not in lib_search_paths[KICAD]:
                lib_search_paths[KICAD].insert(0, symbol_dir)
            
            # Recursively add all .kicad_symdir directories for KiCad v8+ directory format
            for root, dirs, _ in os.walk(symbol_dir):
                for d in dirs:
                    if d.endswith('.kicad_symdir'):
                        full_dir = os.path.join(root, d)
                        if full_dir not in lib_search_paths[KICAD]:
                            lib_search_paths[KICAD].append(full_dir)
        
        set_default_tool(KICAD)
        return True, symbol_dir
    except ImportError as e:
        return False, f"SKiDL not installed: {str(e)}"
    except Exception as e:
        return False, f"Error configuring SKiDL: {str(e)}"

def test_part_load(lib_name="R", part_name="R"):
    """
    Attempts to load a real part from the configured KiCad libraries using SKiDL.
    Returns a JSON-serialisable result dict.

    With the KiCad 8 .kicad_symdir layout the search path already contains
    'Device.kicad_symdir', so calling Part('R', 'R') finds R.kicad_sym inside
    that directory — equivalent to the traditional 'Device:R' reference.
    """
    configured, result = configure_skidl()
    if not configured:
        return {
            "skidlAvailable": False,
            "libraryPath": None,
            "componentLoaded": False,
            "componentName": f"{lib_name}:{part_name}",
            "pins": [],
            "error": result,
        }

    symbol_dir = result
    try:
        import warnings
        # Suppress SKiDL's noisy warnings for this test
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from skidl import Part, KICAD, reset

            # Start with a clean circuit so repeated calls don't accumulate parts
            reset()

            part = None
            extra_libs = ['RF_Module', 'MCU_Espressif', 'MCU_Module', 'Device', 'Sensor', 'Sensor_Optical', 'Regulator_Linear', 'Connector_Generic', 'Switch']
            candidates = [
                (lib_name, part_name),
                (part_name, part_name),
                (lib_name, lib_name),
                (part_name, lib_name),
            ]
            for el in extra_libs:
                candidates.append((el, part_name))

            last_err = None
            for l_cand, n_cand in candidates:
                if not l_cand or not n_cand:
                    continue
                try:
                    part = Part(l_cand, n_cand, dest=2)
                    break
                except Exception as ex:
                    last_err = ex

            if part is None:
                raise last_err or Exception(f"Unable to load symbol {lib_name}:{part_name}")

            pins = [str(p.num) for p in part.pins]
            return {
                "skidlAvailable": True,
                "libraryPath": symbol_dir,
                "componentLoaded": True,
                "componentName": f"{lib_name}:{part_name}",
                "pins": pins,
                "error": None,
            }
    except Exception as e:
        return {
            "skidlAvailable": True,
            "libraryPath": symbol_dir,
            "componentLoaded": False,
            "componentName": f"{lib_name}:{part_name}",
            "pins": [],
            "error": str(e),
        }


def get_part_details(lib_name, part_name):
    """
    Loads a component via SKiDL and returns complete details including pin map.
    """
    configured, result = configure_skidl()
    if not configured:
        return {
            "success": False,
            "error": result,
            "library": lib_name,
            "part": part_name,
        }

    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from skidl import Part, reset
            reset()

            part = None
            extra_libs = ['RF_Module', 'MCU_Espressif', 'MCU_Module', 'Device', 'Sensor', 'Sensor_Optical', 'Regulator_Linear', 'Connector_Generic', 'Switch']
            candidates = [
                (lib_name, part_name),
                (part_name, part_name),
                (lib_name, lib_name),
                (part_name, lib_name),
            ]
            for el in extra_libs:
                candidates.append((el, part_name))
            last_err = None
            for l_cand, n_cand in candidates:
                if not l_cand or not n_cand:
                    continue
                try:
                    part = Part(l_cand, n_cand, dest=2)
                    break
                except Exception as ex:
                    last_err = ex

            if part is None:
                raise last_err or Exception(f"Unable to load symbol {lib_name}:{part_name}")

            pins = []
            for p in part.pins:
                pins.append({
                    "num": str(p.num),
                    "name": str(p.name),
                    "func": str(getattr(p, "func", "PASSIVE")),
                })

            return {
                "success": True,
                "library": lib_name,
                "part": part_name,
                "refPrefix": getattr(part, "ref_prefix", "U"),
                "description": getattr(part, "description", ""),
                "pinCount": len(pins),
                "pins": pins,
                "error": None,
            }
    except Exception as e:
        return {
            "success": False,
            "library": lib_name,
            "part": part_name,
            "pinCount": 0,
            "pins": [],
            "error": str(e),
        }


def search_symbols(query, max_results=30):
    """
    Searches the KiCad symbol libraries for symbols matching query.
    """
    symbol_dir = get_kicad_symbol_dir()
    if not symbol_dir or not os.path.exists(symbol_dir):
        return {"success": False, "error": "KICAD_SYMBOL_DIR not found", "results": []}

    query_lower = query.lower().strip()
    results = []

    for root, dirs, files in os.walk(symbol_dir):
        lib_name = os.path.basename(root).replace(".kicad_symdir", "")
        for f in files:
            if f.endswith(".kicad_sym"):
                symbol_name = f[:-10]  # remove .kicad_sym
                if not query_lower or query_lower in symbol_name.lower() or query_lower in lib_name.lower():
                    results.append({
                        "library": lib_name,
                        "symbol": symbol_name,
                        "identifier": f"{lib_name}:{symbol_name}",
                        "file": f,
                    })
                    if len(results) >= max_results:
                        break
        if len(results) >= max_results:
            break

    return {
        "success": True,
        "query": query,
        "count": len(results),
        "results": results,
    }


def check_environment():
    """
    Checks SKiDL and KiCad symbol availability and returns a status JSON.
    """
    configured, result = configure_skidl()
    status = {
        "skidlAvailable": configured,
        "symbolDir": result if configured else None,
        "error": None if configured else result,
        "kicadSymbolDirEnv": os.environ.get("KICAD_SYMBOL_DIR"),
    }
    print(json.dumps(status))
    return 0 if configured else 1


def main():
    parser = argparse.ArgumentParser(description="Chip Circuit SKiDL Runner")
    parser.add_argument("--check", action="store_true", help="Check SKiDL and KiCad library configuration")
    parser.add_argument("--test-part", action="store_true", help="Load Device:R and report result as JSON")
    parser.add_argument("--search", type=str, help="Search KiCad symbols matching query")
    parser.add_argument("--details", action="store_true", help="Get part details for --lib and --part")
    parser.add_argument("--lib", type=str, default="R", help="Library name for part query")
    parser.add_argument("--part", type=str, default="R", help="Part name for part query")
    parser.add_argument("--script", type=str, help="Path to SKiDL python script to execute")
    parser.add_argument("--out", type=str, help="Output directory for generated artifacts (netlist, SVG, etc.)")

    args = parser.parse_args()

    if args.check:
        return check_environment()

    if args.search is not None:
        res = search_symbols(args.search)
        print(json.dumps(res, indent=2))
        return 0

    if args.details:
        res = get_part_details(args.lib, args.part)
        print(json.dumps(res, indent=2))
        return 0 if res["success"] else 1

    if args.test_part:
        result = test_part_load(args.lib, args.part)
        print(json.dumps(result, indent=2))
        return 0 if result["componentLoaded"] else 1

    if args.script:
        configured, msg = configure_skidl()
        if not configured:
            sys.stderr.write(f"SKiDL configuration error: {msg}\n")
            sys.exit(1)
        # Execute the targeted script
        with open(args.script, "r", encoding="utf-8") as f:
            code = f.read()
        exec_globals = {
            "__file__": args.script,
            "__name__": "__main__",
            "OUTPUT_DIR": args.out or os.getcwd(),
        }
        exec(code, exec_globals)
        return 0

    parser.print_help()
    return 0

if __name__ == "__main__":
    sys.exit(main() or 0)
