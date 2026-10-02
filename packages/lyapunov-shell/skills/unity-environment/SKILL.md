---
name: unity-environment
description: Deliver scenes to Unity. Determine read/create/preview capabilities from actual MCP connections and tools visible in the current session, then use their actual schemas. When configuration is missing, identify the gap and provide exchange outputs and acceptance conditions. Use for import into Unity, edit in Unity, or deliver a Unity project.
---

# Unity Delivery and Exchange

**Input**: the delivery/operation target: read an existing Unity scene, create/modify in Unity, produce previews, or deliver a project.
**Always inspect the current session's actual tools first**. `list_mcp_servers` reports MCP servers accessible in this scope and their state. Use returned/currently visible tool names; **do not infer capabilities or invent tool names**.

## Branch 1: Unity Capabilities Are Available

Use the returned **actual tools and schemas** to read/create/preview. Read the scene/object inventory first, make changes, then verify with an available preview/screenshot receipt. State the actual process, project, and steps executed. Other-engine MuJoCo/Isaac previews or execution receipts are not Unity evidence. Writing a file does not establish that Unity applied it.

## Branch 2: Not Connected or Only Read-Only Lists Are Available

Identify the actual missing MCP server configuration/connection and provide deliverables and acceptance conditions:

- Blender export directory through `architectural-world`: `source.blend`, `scene.json`, `visuals/*.glb`, `physics/world.xml`, `isaac/architecture.usda`, and `isaac/import.json`. Find library GLB/MJCF/URDF through `asset_list`; `scene_save portable` produces a self-contained project.
- Units/coordinates: internal metres, right-handed Z-up, xyzw quaternions. GLB exports Y-up under glTF. `isaac/import.json` declares `units: m`, `upAxis: Z`, `handedness: right`; collision uses per-entity boxes from `scene.json`.
- Disclose conversion losses: materials/shading may be approximated; collision is component boxes rather than the original mesh; advanced Blender nodes/modifiers remain only in `source.blend`.
- Specify who does what on the Unity side, which replacement parameters to use, and how to verify the result. Return required Unity MCP integration as a gap to the main workflow.

**Do not add MCP servers within the session**. `lyapunov-mcp-extras` only provides read-only `list_mcp_servers`, `list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`, `list_mcp_prompts`, and `get_mcp_prompt`. Host startup assembles MCP connections. Without a connection, use branch 2 without adding permission gates or external credentials.

## File Boundary (ENV-04)

- Use bash/read/write and other file tools for task-workspace scripts, references, intermediate outputs, and exports.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`, etc.). **Do not change product state by editing files on disk**, and do not modify product source. Capabilities come from skill contracts and actual product-tool results.
