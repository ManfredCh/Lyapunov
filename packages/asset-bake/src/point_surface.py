"""测得体素占据并集的外边界。跨 tile 查全表；仅 Isaac 静态 none 适用。"""
import hashlib
import json
import struct
import sys
import time

MAX_PART_QUADS = 150000
MAX_PART_BYTES = 64 * 1024 * 1024
MAX_PARTS = 10000
READ_BYTES = 8 * 1024 * 1024
OBJ_CHUNK_BYTES = 1024 * 1024
DIRECTIONS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))


class PointSurfaceError(ValueError):
    def __init__(self, message, details):
        self.details = {"coverageComplete": False, **details}
        super().__init__(message)


def export_surface(connection, out, pitch, point_info, disk_cap, check_output):
    import numpy as np
    started = time.perf_counter()
    source_cells = connection.execute("SELECT count(*) FROM cells").fetchone()[0]
    nodes, parts, positions, indices, corners = [], [], [], [], {}
    quad_count = 0
    direction_counts = []
    expected_counts = []
    last_progress = 0.0

    def disk_bytes():
        return sum(path.stat().st_size for path in out.iterdir() if path.is_file())

    def ensure_disk(additional=0):
        current = disk_bytes()
        if current + additional > disk_cap:
            raise PointSurfaceError("POINT_CLOUD_SURFACE_DISK_BUDGET", {
                "stage": "full-surface-write", "diskBytes": current,
                "nextWriteBytes": additional, "maxDiskBytes": disk_cap,
                "occupiedVoxels": source_cells, "exteriorQuadsProcessed": quad_count,
                "completedParts": len(nodes),
            })

    def progress(stage, force=False, **facts):
        nonlocal last_progress
        now = time.perf_counter()
        if force or now - last_progress >= .5:
            last_progress = now
            print("LYAPUNOV_PROGRESS=" + json.dumps({
                "stage": stage, "occupiedVoxels": source_cells,
                "exteriorQuadsProcessed": quad_count, "completedParts": len(nodes),
                "elapsedMs": round((now - started) * 1000, 3), **facts,
            }), file=sys.stderr, flush=True)

    progress("full-surface-index", True)
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS xyz ON cells(x,y,z)")
    connection.commit()
    ensure_disk()
    # 外存排序后的整数 cell 身份可与源 XYZ 的独立晶格计数对账；不只声明 verified。
    cell_digest = hashlib.sha256()
    digest_block = bytearray()
    for ordinal, cell in enumerate(connection.execute("SELECT x,y,z FROM cells ORDER BY x,y,z")):
        digest_block.extend(struct.pack("<qqq", *cell))
        if len(digest_block) >= OBJ_CHUNK_BYTES:
            cell_digest.update(digest_block)
            digest_block.clear()
            progress("full-surface-cell-identity", cellsVerified=ordinal + 1)
    cell_digest.update(digest_block)
    cell_sha256 = cell_digest.hexdigest()

    def flush():
        nonlocal positions, indices, corners
        if not indices:
            return
        if len(nodes) >= MAX_PARTS:
            raise PointSurfaceError("POINT_CLOUD_SURFACE_PART_BUDGET", {
                "stage": "full-surface-part", "requiredPartsAtLeast": len(nodes) + 1,
                "maxParts": MAX_PARTS,
            })
        name = "point-cloud-surface-" + str(len(nodes))
        vertices = np.asarray(positions, dtype="<f8").reshape((-1, 3))
        faces = np.asarray(indices, dtype="<u4").reshape((-1, 3))
        if vertices.nbytes + faces.nbytes > MAX_PART_BYTES:
            raise PointSurfaceError("GEOMETRY_NODE_BUDGET_EXCEEDED", {
                "stage": "full-surface-part", "node": name,
                "bytes": vertices.nbytes + faces.nbytes, "maxNodeBytes": MAX_PART_BYTES,
            })

        def binary(array, suffix, dtype):
            path = out / (name + suffix)
            check_output(path)
            view = memoryview(array).cast("B")
            digest = hashlib.sha256()
            with path.open("wb") as stream:
                for start in range(0, len(view), READ_BYTES):
                    block = view[start:start + READ_BYTES]
                    ensure_disk(len(block))
                    stream.write(block)
                    stream.flush()
                    digest.update(block)
                    progress("full-surface-write", node=name)
            return {"path": str(path), "dtype": dtype, "count": int(array.size),
                    "bytes": int(array.nbytes), "sha256": digest.hexdigest()}

        position = binary(vertices, ".position.f64.bin", "f64le")
        index = binary(faces, ".index.u32.bin", "u32le")
        obj = out / (name + ".obj")
        check_output(obj)
        with obj.open("w", encoding="ascii", newline="\n") as stream:
            lines, size = [], 0

            def write_lines():
                nonlocal lines, size
                if lines:
                    ensure_disk(size)
                    stream.write("".join(lines))
                    stream.flush()
                    lines, size = [], 0
                    progress("full-surface-write", node=name)

            for row in vertices:
                line = "v %.17g %.17g %.17g\n" % tuple(row)
                lines.append(line)
                size += len(line)
                if size >= OBJ_CHUNK_BYTES:
                    write_lines()
            write_lines()
            for row in faces:
                line = "f %d %d %d\n" % tuple(int(value) + 1 for value in row)
                lines.append(line)
                size += len(line)
                if size >= OBJ_CHUNK_BYTES:
                    write_lines()
            write_lines()
        info = {**point_info, "processing": "full-spatial-voxel-surface",
                "coverage": "full-measured-sample-voxel-boundary", "representation": "voxel_surface",
                "sourceOccupiedVoxels": source_cells, "voxelSizeM": pitch,
                "consumerSupport": {"isaac": "explicit-static-triangle-mesh-none",
                                    "mujoco": "UNSUPPORTED_VOXEL_SURFACE"}}
        nodes.append({"node": name, "kind": "mesh", "sourceKind": "point_cloud",
                      "pointCloud": info, "watertight": False, "position": position, "index": index})
        parts.append({"path": str(obj), "sourceNode": name, "vertices": len(vertices),
                      "faces": len(faces), "watertight": False, "volumeM3": None,
                      "bounds": [vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist()]})
        positions, indices, corners = [], [], {}
        ensure_disk()
        progress("full-surface-part-complete", True, node=name)

    for direction, (dx, dy, dz) in enumerate(DIRECTIONS):
        join = " FROM cells a LEFT JOIN cells b ON b.x=a.x+? AND b.y=a.y+? AND b.z=a.z+? WHERE b.x IS NULL"
        expected = connection.execute("SELECT count(*)" + join, (dx, dy, dz)).fetchone()[0]
        expected_counts.append(expected)
        emitted = 0
        for x, y, z in connection.execute("SELECT a.x,a.y,a.z" + join, (dx, dy, dz)):
            if direction == 0:
                quad = ((x+1,y,z), (x+1,y+1,z), (x+1,y+1,z+1), (x+1,y,z+1))
            elif direction == 1:
                quad = ((x,y,z), (x,y,z+1), (x,y+1,z+1), (x,y+1,z))
            elif direction == 2:
                quad = ((x,y+1,z), (x,y+1,z+1), (x+1,y+1,z+1), (x+1,y+1,z))
            elif direction == 3:
                quad = ((x,y,z), (x+1,y,z), (x+1,y,z+1), (x,y,z+1))
            elif direction == 4:
                quad = ((x,y,z+1), (x+1,y,z+1), (x+1,y+1,z+1), (x,y+1,z+1))
            else:
                quad = ((x,y,z), (x,y+1,z), (x+1,y+1,z), (x+1,y,z))
            ids = []
            for corner in quad:
                if corner not in corners:
                    corners[corner] = len(positions) // 3
                    positions.extend(value * pitch for value in corner)
                ids.append(corners[corner])
            indices.extend((ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]))
            quad_count += 1
            emitted += 1
            if len(indices) >= MAX_PART_QUADS * 6:
                flush()
            if emitted % 16384 == 0:
                progress("full-surface-extract", direction=direction, expectedDirectionQuads=expected)
        flush()
        direction_counts.append(emitted)
        if emitted != expected:
            raise PointSurfaceError("POINT_CLOUD_SURFACE_COVERAGE_MISMATCH", {
                "stage": "full-surface-verify", "direction": direction,
                "expectedQuads": expected, "emittedQuads": emitted,
            })
    if not nodes or sum(expected_counts) != quad_count or quad_count > source_cells * 6:
        raise PointSurfaceError("POINT_CLOUD_SURFACE_COVERAGE_MISMATCH", {
            "stage": "full-surface-verify", "occupiedVoxels": source_cells,
            "expectedQuads": sum(expected_counts), "emittedQuads": quad_count,
        })
    disk_size = disk_bytes()
    for node in nodes:
        node["pointCloud"].update({
            "exteriorQuads": quad_count, "triangles": quad_count * 2, "meshParts": len(nodes),
            "coverageComplete": True, "occupiedUnionVerified": True,
            "occupiedCellSha256": cell_sha256, "occupiedCellHashEncoding": "sorted-xyz-i64le",
            "boundaryValidation": {"rule": "six-neighbour-occupied-union",
                                   "expectedQuadsByDirection": expected_counts,
                                   "emittedQuadsByDirection": direction_counts},
            "outputDiskBytes": disk_size, "maxPartQuads": MAX_PART_QUADS,
            "maxPartBytes": MAX_PART_BYTES, "maxParts": MAX_PARTS,
            "phaseMs": {"surfaceExport": round((time.perf_counter()-started)*1000, 3)},
        })
    progress("full-surface-verified", True, triangles=quad_count * 2, outputDiskBytes=disk_size)
    return {"surface": True, "nodes": nodes, "parts": parts, "exteriorQuads": quad_count,
            "sourceOccupiedVoxels": source_cells, "outputDiskBytes": disk_size}
