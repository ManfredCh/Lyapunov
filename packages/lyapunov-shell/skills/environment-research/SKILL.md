---
name: environment-research
description: Search and verify sources for environment/architecture tasks. Organize web searches and image/document retrieval around specific gaps, check sources against the physical subject, record adopted evidence and decisions in a short task-local reference index, and register public model assets in the resource library. Use for finding references, researching a building, missing side views/details, or obtaining assets.
---

# Environment research

## SimReady 与 USD 来源优先

未指定来源时，先检查 `asset_list` 的本地资源，再用 `simready_search` 检查已登记/已选择厂商库（含旧 Warehouse 固定 CSV 源）；选定候选后 `simready_detail` 核对固定 revision、许可、root USD 和 BOM，再用 `simready_import` 取得完整原生包。确实没有合适候选后才使用其他结构化库或 `web_search` / `web_fetch` 补缺。`BLOCKED` / `PARTIAL` 的来源失败不等于 `NO_MATCH`。用户明确指定来源/生成方式时仍遵从其要求。

旧 Warehouse 使用独立 `warehouse-csv-v1`：目录缓存命中不代表当次镜像成功，`refresh:true` 的失败单独报告；它没有新版 BOM/验证记录。旧 CSV 的 mass 未标明单位时不猜 kg。缩略图必须由受控镜像获取成功后展示，不将原文官方 URL 直接用于浏览器图片。

USD、USDA、USDC、USDZ 是主资产，不能为了入库强制转 GLB。Viewer 保留源身份，支持默认时刻几何、UsdPreviewSurface 基础色/粗糙度/金属度与 UsdUVTexture+st 纹理；MDL、任意shader、细分与蒙皮/动画未渲染。源网络、关节/驱动和碰撞保留在 USD，原生物理按具体 Provider 复验。实例变体用 `scene_usd_instance`，变换用 `scene_edit`，保存重开沿现有 Scene/Resource 操作。计划-only 阶段只读 search/detail，不导入或启动物理。


**Input:** The subject to build/verify and the current gap: a viewpoint, dimension, asset, or supporting evidence.

**Completion:** Evidence fills the gap needed for the current decision and supports or revises dimensions, layout, or production choices; alternatively, report established findings and remaining gaps under current constraints. A keyword match or collection of images is not completion.

## 1. Tools and available paths

Determine availability from the tools actually visible in the current session.

- `web_search` (native DSH): supply a `queries` array, at most four queries per call according to the current schema. Results contain source titles, URLs, and summaries. A per-call limit is not a whole-task search limit. Do not mechanically repeat a query without new information.
- **Invest according to the current gap and user budget:** Proceed once evidence supports key decisions. Continue when important gaps remain and research brings new information. If progress stalls, change queries or sources. On exhausting an agreed budget, report known results and continuation requirements without silently overspending. Download budgets and query counts are separate. `reference_image_fetch` is limited by its own and Host attachment limits, reported as `limits`; use separate GLB and 3DGS budgets from `asset-generation`, rather than applying 64 MiB to all images and models.
- `web_fetch` (native DSH) reads page **text** (html/xhtml, `text/*`, and JSON/XML families). **Images and other binary content raise `WEB_UNSUPPORTED_CONTENT_TYPE`**; do not fetch images through it.
- **Retrieve images/originals yourself:** This is a core capability, not a reason to ask the user to upload every image.
  1. Prefer visible `reference_image_fetch`. Supply an **HTTPS direct original-image URL** discovered on a source page. It returns the actual image as a viewable attachment, byte sha256, measured pixels, and a possible-thumbnail signal for excluding thumbnails/reposts. It fetches one direct URL without searching, redirects, or credentials; follow its current parameter schema.
  2. If unavailable, use existing task-workspace file/HTTP capabilities (`bash` with `curl`/`python`, for example) to retrieve **lawfully public** images and documents, then inspect PNG/JPEG/WebP/GIF with native `read_image`. For authenticated/dynamic pages, stay within an authorized, currently available controlled browser (`desktop-automation`); do not escalate automatically to the entire desktop. Appearance details need clear, verifiable images. Thumbnails/reposted screenshots support only their visible content, not original detail or measurement precision. Download volume does not establish reliability.
  3. The two integrity constraints are: do not modify product source (record missing capability and return it to the main workflow), and do not write directly to the resource library (model assets use `scene_environment_*` / `scene_import_url`).
- **Public model assets, including individual objects such as stone lions or gate piers:** Use `scene_environment_search/detail/import` for the PolyHaven catalog, following `environment-assets`. Use controlled `scene_import_url` for self-contained GLB files from other sources. Unpack and organize dependency-bearing packages in the task workspace, then register them with local `scene_import` (glb/splat/mjcf/urdf/blend/usd supported). **Verify source and license yourself** against the source page: author, license, redistribution rights, and attribution. Record the findings in `asset_edit` tags. Ask the user only when new charges or unclear rights actually apply.

## 2. Organize queries around gaps

Research is iterative, not a one-time prerequisite to production. **Address the currently missing item:** state the research question, then search English and Chinese aliases as useful. Chinese terms do not match the local asset catalog described in `environment-assets`.

Consider layout/site plan, massing/proportion, sides/back, details such as arches/roofs/railings/ornament, components/furniture, materials/colors, historical alterations, location, and neighboring landmarks.

After each check, **identify remaining gaps before the next round**. Object identity, dimensions, licensing, route feasibility, or a concrete render/reference difference may create a new question. Fix UV/script/naming issues with a known remedy directly instead of searching merely to complete a process. Record findings that affect decisions and reasons to continue/stop. Advance when current decision evidence is sufficient; research itself is not delivery.

## 3. A short task-local reference index

Keep a short index in the task workspace, such as `references.md`. Each entry records **object/component, finding or value, source title + URL, adopted or excluded, and the decision it changed**.

- This is delivery/audit documentation. **Planning, progress, and todo facts remain in native Todo/session state.** Do not create another planning-state file, reference repository, or indexing service.
- Associate entries with specific components and decisions. Keep a one-line reason for excluded entries. Images/assets retain native storage (session attachments and `asset_list` records); do not duplicate asset directories.
- Resolve conflicts explicitly. Recheck object/period/location mismatches rather than treating one source category as unconditionally correct. Neither photos nor generated images become measurement evidence by assumption; dimension tiers are in `photo-reconstruction`.

## 4. Failures, next steps, and delivery

- If a page or original image cannot be retrieved, change sources or label it an unverified appearance reference. Do not stall waiting for the user or interpret one failure as total product incapability.
- **Judge evidence sufficiency by the current decision.** Real-world reconstruction needs verification of the subject and references affecting appearance/dimensions; asset use/distribution needs appropriate license/author verification. Existing user material, text-driven creation, and local edits do not require collecting an original image, hash, and source page as a mandatory trio first. Tool-returned sha256/pixels support identity/quality checks but are not universal startup gates. Resolve license, authorization, and critical-fact gaps that actually block work; continue other authorized work with stated assumptions.
- If `reference_image_fetch` is not wired, use the general path in section 1, step 2, and record that gap.
- **Do not invent tools or services from names.** Refer only to tools actually visible. Unverified generative entry points, such as image3.0 image generation discussed in `asset-generation`, are not established capabilities and must not receive invented tool names.
- Report what was checked, what was adopted, which dimensions/layout/production methods changed, and what remains unverified. If research changed no decision, say so.

## File boundaries (ENV-04)

- Allowed: task-workspace scripts, references, intermediate artifacts, and exports, using bash/read/write and other file tools.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`). **Do not change product state by editing stored files**, and do not modify product source. Capability is established by skill contracts and product-tool results.
