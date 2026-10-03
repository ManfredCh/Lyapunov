---
name: cad-import
description: Read CAD drawings and blueprints and reconstruct a 3D scene. Use cad_inspect for actual DXF units/layers/coordinates, read drawing images/PDFs for dimensions and topology, and map CAD symbols to interior assets. Use for requests such as build scene from floor plan, import CAD drawing, or model from blueprint.
---

# CAD Drawing-to-Scene Workflow

**Input**: drawings (DXF/DWG files, drawing images/PDFs/screenshots, or a combination), intended use, and site information.
**Completion**: every component has traceable dimension/topology evidence (annotation, contour, or derivation), and render comparison passes. Drawings remain read-only.

CAD input is a **special case of scene construction**: understand the drawing, reconstruct to scale, then follow scene-construction. **Plan first**: for a new scene or major reconstruction, write a short plan through `environment-planning`; this skill turns drawings into dimensions and topology. Do not invent structures or dimensions absent from the drawing.

**Cross-check photos separately**: drawings provide checkable dimensions, topology, and elevations; photos provide appearance, perspective, material appearance, and **calibrated dimension estimates** when scale references or camera pose are known (grading and derivation chains are in `photo-reconstruction`). When elevations/sections/details are missing, supplement with photos and public sources through `environment-research`; maps/public dimensions can also calibrate estimates. Identify adopted sources and affected components. Resolve conflicts by checking the object, date, and drawing version rather than treating drawings as unconditionally correct. **Separate annotations from estimates**: label annotated values as annotated, and explain derivations/estimates instead of mixing them with measurements.

## 1. DXF: Read Actual Coordinates and Units with `cad_inspect`

When `cad_inspect` is **visible in the current session**, use it first. The product Blender plugin registers it with an **isolated** interpreter explicitly configured by `LYAPUNOV_CAD_PYTHON`, independent of Blender/Isaac Python.

- Read actual DXF (ASCII and Binary): original/unknown units, layers, block definitions/references (including space and parent block for nested references), actual curve parameters (endpoints/vertices and bulge, circle centres/radii/angles, SPLINE knots/weights), dimensions, and unreadable entities.
- **Do not guess units**: an undeclared unit means `units.known=false` and `metresPerUnit=null`. Specify a unit explicitly for conversion; the result records caller provenance and warns when it conflicts with the file declaration.
- Two consumption surfaces: structured reports for modelling scripts and a default bounded summary. Request full explicitly for raw data; detail counts and per-curve point limits still apply. **Only counts are complete**.
- **Read-only**: do not write drawings back, perform Boolean/solid modelling, or invent CAD data from images.

**Interpret actual configuration errors**: an unconfigured interpreter means this deployment has not supplied the isolated interpreter (see development docs; initial installation does not require an offline cache). Missing ezdxf means dependencies are absent. A missing converter for DWG means conversion to DXF is required, not that the file is bad DXF. Converter configuration uses plugin `dwgConverter`, `LYAPUNOV_DWG_CONVERTER` (with `_KIND`/`_ARGS`), or GNU LibreDWG `dwg2dxf` on PATH. **ODA File Converter operates on directories; this implementation has not verified that branch and explicitly rejects it with `DWG_CONVERTER_UNSUPPORTED`**. Do not present it as available; see `docs/DRAWING_INPUT.md`. Follow actual errors to alternatives (image reading, research, or requesting a DXF version). Do not install these dependencies into Blender/Isaac Python, and do not infer that the product cannot read DXF merely because one machine lacks configuration. Record actual unresolved capability gaps in delivery notes.

### DWG/PDF Use the Same Native Routing: `drawing_inspect` and `cad_convert`

When `drawing_inspect` is visible, route by **file header**, not extension, without manually guessing the format first.

- **DWG**: use the configured converter to create a **new** DXF, preserving the source. Compare source sha256 before/after; `sourceUnchanged` must be true. Parse with the same ezdxf path. Report actual losses through `conversion.losses` / `lossCategories` and delivery notes. An unreadable converted result returns `DWG_CONVERTED_UNREADABLE` and is not published. Use `cad_convert` for a separately reusable DXF; it defaults to `<workspace>/cad-converted/<name>.dxf` and does not overwrite unless `overwrite=true`.
- **Vector PDF**: return actual path operators including CTM transforms, text/page coordinates, and page dimensions. **Page units are 1/72-inch drawing points, not metres**. Metric output requires an explicit `scale`, such as `1:100`; otherwise `metresKnown=false` and no metric dimensions are returned.
- **Scanned/mixed PDF**: export embedded images as PNG and deliver them **directly as images in context**. Pages with `/Rotate` or CropBox prefer a full-page preview; original image pixels are not equivalent in these cases, and the receipt explains why. This remains image reading, with dimensions graded as below.

## 2. Build Geometry in Task Scripts

`scene_import` **does not support** dxf/dwg; it supports glb/splat/mjcf/urdf/blend/usd. Build geometry in **task scripts**, using `blender_run` `python_script` or connected `mcp__blender__*`. See `architectural-world` for modelling/export contracts.

- **Metres = drawing-unit value multiplied by `units.metresPerUnit`**. With unknown units, retain relative proportions and disclose them, or convert using explicitly supplied units.
- DXF model space lies in XY with thickness along Z, matching Lyapunov/Blender Z-up; **no axis swap is needed**. Convert `coordinates:"ocs"` with an extrusion direction other than (0,0,1) to WCS first.
- `closed=true` `LWPOLYLINE`/`POLYLINE` vertex order defines a closed boundary with the last point returning to the first. Interpret wall/plot/other boundaries using layers and annotations; 2D base elevation is in `elevation`. **Do not use `bounds` as a rectangular wall contour**: it loses an L-shaped recess.
- Bulge segments are circular arcs with `bulge = tan(θ/4)`. Transform block instances back to world coordinates through the reference chain using **row-major right multiplication** (v' = v*M); model a repeatedly referenced block once.
- Dimension measurements can be cross-checked in drawing units. Manually overridden annotation text does not change the measured value; explicitly state which source governs.

## 3. Drawing Images, PDFs, and Screenshots

Read supplied images for room contours/zones, door/window positions and opening directions, wall thickness, key dimensions, fixed furniture, and symbols. Reconstruct in Blender using the dimensions read. Choose the execution surface by task: **batch/reproducible** work uses `blender_run`; interactive iteration uses connected `mcp__blender__*` with `execute_blender_code` and `get_viewport_screenshot`. If MCP is unavailable, fall back to `blender_run` instead of waiting indefinitely. See `architectural-world` for metric Z-up, component collision, hollow interiors, and export.

**Vector PDF can also provide parsed evidence**: `drawing_inspect` returns actual operators and text/coordinates, but no metric values without `scale`. Scanned/mixed PDF full-page PNGs enter image context; grade dimensions from image reading and explain the pixel-to-metre chain. Bitmap drawings (photos/screenshots) likewise use image reading regardless of extension.

## 4. Map CAD Symbols to Interior Assets

Determine symbols from legends, layers, and context before finding matching doors/windows/furniture/equipment/vegetation in built-in or public assets. If none exists, create it to confirmed dimensions. Placement/orientation follows the drawing; do not move walls/openings or change annotated dimensions on your own.

## Evidence and Capability Boundaries

- Grade dimensions: explicit drawing annotations, then scale-derived values labelled as derived, then customary defaults labelled as modelling assumptions. State the grade of each value. **Cross-check CAD against photos, maps, and public dimensions**; resolve conflicts by object/date/drawing version, without unconditional source-category priority.
- Report only visible rooms/doors/windows/clearances. List hidden gaps and supplement with photos (`photo-reconstruction`), focused research (`environment-research`), or map/public-dimension calibration before asking the user.
- Compare reconstruction renders side by side with the original drawing, checking walls/openings/proportions/furniture layout; list and correct differences.
- Structural calculations, building-code compliance review, and formal construction documents are **outside this capability**. Deliver a scene model, not a construction document. Requests to turn a drawing into an illustrative rendering use image generation; verify currently configured service availability through `asset-generation`.

## File Boundary (ENV-04)

- Use bash/read/write and other file tools for task-workspace scripts, references, intermediate outputs, and exports.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`, etc.). **Do not change product state by editing files on disk**, and do not modify product source. Capabilities come from skill contracts and actual product-tool results.
