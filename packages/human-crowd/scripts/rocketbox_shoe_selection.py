"""显式离线鞋分量选择：保原网格/权重，仅从高 foot/toe 权重候选中选择最低拓扑分量。"""
import hashlib
import json


def lowest_shoe_component(positions, triangles, candidates, neutral_world_positions):
    """位置量化只缝合导出造成的 UV/法线重复点；不按高度直接裁掉鞋顶点。"""
    candidates = sorted(set(int(index) for index in candidates))
    assert candidates, 'SHOE_WEIGHTED_CANDIDATES_EMPTY'
    parents = {index: index for index in candidates}

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(a, b):
        a, b = root(a), root(b)
        if a != b:
            parents[max(a, b)] = min(a, b)

    seams = {}
    for index in candidates:
        key = tuple(round(float(value) * 1e6) for value in positions[index][:3])
        if key in seams:
            union(index, seams[key])
        else:
            seams[key] = index
    for triangle in triangles:
        selected = [int(index) for index in triangle if int(index) in parents]
        for index in selected[1:]:
            union(selected[0], index)
    components = {}
    for index in candidates:
        components.setdefault(root(index), []).append(index)
    rows = []
    for indices in components.values():
        heights = [float(neutral_world_positions[index][2]) for index in indices]
        rows.append({'vertices': indices, 'count': len(indices), 'minNeutralWorldZM': min(heights), 'maxNeutralWorldZM': max(heights)})
    rows.sort(key=lambda row: (row['minNeutralWorldZM'], row['vertices'][0]))
    # 相同最低点的 UV 缝合后仍有多个独立部件时，身份有歧义，交由来源审查处理。
    if len(rows) > 1 and abs(rows[1]['minNeutralWorldZM'] - rows[0]['minNeutralWorldZM']) < 1e-6:
        raise AssertionError(('SHOE_LOWEST_COMPONENT_AMBIGUOUS', [(row['count'], row['minNeutralWorldZM']) for row in rows]))
    selected = rows[0]['vertices']
    assert len(selected) >= 8, ('SHOE_COMPONENT_TOO_SMALL', len(selected))
    report = {
        'method': 'explicit-lowest-connected-weighted-component',
        'positionSeamQuantizationInMeshUnits': 1e-6,
        'candidateVertices': len(candidates),
        'selectedVertices': selected,
        'selectedVertexIndicesSha256': hashlib.sha256(json.dumps(selected, separators=(',', ':')).encode()).hexdigest(),
        'components': rows,
    }
    return selected, report
