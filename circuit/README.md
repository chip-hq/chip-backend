# Chip — Circuit Generation Module

This module handles programmatic circuit design, SKiDL script execution, and netlist/schematic generation.

## Structure
- [`index.js`](file:///backend/circuit/index.js): Module export interface.
- [`circuit-runner.js`](file:///backend/circuit/circuit-runner.js): Node.js service for executing SKiDL scripts in Python.
- [`skidl_runner.py`](file:///backend/circuit/skidl_runner.py): Python bridge that initializes SKiDL and configures the KiCad symbol search paths.

## Configuration
Set the `KICAD_SYMBOL_DIR` environment variable to point to your KiCad symbol library:

- **Local:** `KICAD_SYMBOL_DIR=../kicad-libraries/kicad-symbols`
- **Production / Docker:** `KICAD_SYMBOL_DIR=/opt/kicad-symbols`

## Dependencies
- Python 3.10+
- `skidl` (Install via `pip install skidl`)
- KiCad Symbol Library (.kicad_sym files)
