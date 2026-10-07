"""只读 GLB 携带事实；可在独立 Blender 进程中额外执行真实重载。"""
import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path


def inspect_glb(path):
    path = Path(path).resolve()
    data = path.read_bytes()
    if len(data) < 20 or struct.unpack_from('<III', data) != (0x46546C67, 2, len(data)):
        raise ValueError('GLB_HEADER_INVALID: Expected a complete glTF 2 binary file.')
    offset = 12
    document = None
    binary = b''
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError('GLB_CHUNK_TRUNCATED')
        length, kind = struct.unpack_from('<II', data, offset)
        start, end = offset + 8, offset + 8 + length
        if length % 4 or end > len(data):
            raise ValueError('GLB_CHUNK_INVALID')
        if kind == 0x4E4F534A:
            if document is not None or offset != 12:
                raise ValueError('GLB_JSON_CHUNK_INVALID')
            document = json.loads(data[start:end].decode('utf-8'))
        elif kind == 0x004E4942:
            if binary:
                raise ValueError('GLB_BIN_CHUNK_DUPLICATE')
            binary = data[start:end]
        offset = end
    if not isinstance(document, dict) or document.get('asset', {}).get('version') != '2.0':
        raise ValueError('GLB_DOCUMENT_INVALID')
    primitives = [p for mesh in document.get('meshes', []) for p in mesh.get('primitives', [])]
    uv_primitives = sum('TEXCOORD_0' in p.get('attributes', {}) for p in primitives)
    images = document.get('images', [])
    views = document.get('bufferViews', [])
    embedded, external, missing = 0, 0, 0
    for image in images:
        if 'bufferView' in image:
            index = image['bufferView']
            if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(views):
                raise ValueError('GLB_IMAGE_BUFFER_VIEW_INVALID')
            view = views[index]
            start, size = view.get('byteOffset', 0), view.get('byteLength', 0)
            if view.get('buffer', 0) != 0 or not isinstance(start, int) or not isinstance(size, int) or start < 0 or size <= 0 or start + size > len(binary):
                raise ValueError('GLB_IMAGE_BYTES_INVALID')
            embedded += 1
        elif isinstance(image.get('uri'), str) and image['uri'].startswith('data:image/'):
            # A URI is declared, but decoding/Blender import remains an independent check.
            embedded += 1
        elif isinstance(image.get('uri'), str):
            external += 1
        else:
            missing += 1
    textures = document.get('textures', [])
    def collect(value, target):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.endswith('Texture') and isinstance(item, dict) and isinstance(item.get('index'), int):
                    target.add(item['index'])
                collect(item, target)
        elif isinstance(value, list):
            for item in value:
                collect(item, target)
    material_textures = []
    for material in document.get('materials', []):
        refs = set()
        collect(material, refs)
        material_textures.append(refs)
    used_textures = set().union(*material_textures) if material_textures else set()
    if any(index < 0 or index >= len(textures) for index in used_textures):
        raise ValueError('GLB_MATERIAL_TEXTURE_REFERENCE_INVALID')
    used_images = set()
    for index in used_textures:
        texture = textures[index]
        source = texture.get('source')
        if source is None:
            extensions = texture.get('extensions', {})
            for name in ('KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'):
                if name in extensions:
                    source = extensions[name].get('source')
                    break
        if not isinstance(source, int) or isinstance(source, bool) or source < 0 or source >= len(images):
            raise ValueError('GLB_TEXTURE_IMAGE_REFERENCE_INVALID')
        used_images.add(source)
    textured_primitives = [p for p in primitives if isinstance(p.get('material'), int)
                           and 0 <= p['material'] < len(material_textures) and material_textures[p['material']]]
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'meshes': len(document.get('meshes', [])), 'primitives': len(primitives),
            'uvPrimitives': uv_primitives, 'images': len(images), 'textures': len(textures),
            'materialTextureReferences': len(used_textures), 'embeddedImages': embedded,
            'referencedImages': len(used_images),
            'texturedPrimitives': len(textured_primitives),
            'texturedPrimitivesWithoutUv': sum('TEXCOORD_0' not in p.get('attributes', {}) for p in textured_primitives),
            'externalImages': external, 'missingImages': missing,
            'evidence': 'glb-container-read', 'visualMatch': 'not-evaluated', 'roundtrip': 'not-performed'}


def blender_roundtrip(path):
    import bpy
    # Never clear or replace a live MCP/editor project. Use a dedicated factory-startup process.
    if not bpy.app.background or bpy.data.filepath or '--factory-startup' not in sys.argv:
        raise ValueError('GLB_ROUNDTRIP_REQUIRES_FACTORY_BACKGROUND: Use a separate Blender --background --factory-startup process.')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    status = bpy.ops.import_scene.gltf(filepath=str(Path(path).resolve()))
    if 'FINISHED' not in status:
        raise RuntimeError('GLB_ROUNDTRIP_IMPORT_FAILED')
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    textures = {}
    for obj in meshes:
        for mat in obj.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or node.image is None:
                    continue
                image = node.image
                # Blender's importer decodes images lazily; reading pixels is the actual decode check.
                pixels = image.pixels
                if len(pixels) and image.size[0] > 0 and image.size[1] > 0 and image.has_data:
                    textures[image.name] = [int(image.size[0]), int(image.size[1])]
    return {'evidence': 'blender-gltf-import', 'meshObjects': len(meshes),
            'uvMeshObjects': sum(bool(obj.data.uv_layers) for obj in meshes),
            'loadedImageTextures': len(textures), 'visualMatch': 'not-evaluated'}


def main(argv):
    parser = argparse.ArgumentParser(description='Read GLB facts without modifying the artifact. Counts do not establish visual quality.')
    parser.add_argument('path')
    parser.add_argument('--require-textures', action='store_true', help='Use only when the task requires portable image textures.')
    parser.add_argument('--roundtrip', action='store_true', help='Additionally import with a dedicated factory-startup background Blender process.')
    args = parser.parse_args(argv)
    try:
        report = inspect_glb(args.path)
        if args.roundtrip:
            report['roundtrip'] = blender_roundtrip(args.path)
        failures = []
        if not report['primitives']:
            failures.append('GLB_VISIBLE_GEOMETRY_MISSING')
        if args.require_textures:
            if not report['embeddedImages'] or not report['materialTextureReferences']:
                failures.append('GLB_PORTABLE_TEXTURES_MISSING')
            if report['externalImages'] or report['missingImages']:
                failures.append('GLB_TEXTURES_NOT_SELF_CONTAINED')
            if report['texturedPrimitivesWithoutUv']:
                failures.append('GLB_UV_MISSING')
            if args.roundtrip and not report['roundtrip']['loadedImageTextures']:
                failures.append('GLB_ROUNDTRIP_TEXTURES_MISSING')
        report.update(status='FAILED' if failures else 'FACTS_VERIFIED', failures=failures)
        print(json.dumps(report, ensure_ascii=False))
        return 2 if failures else 0
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'error': str(error), 'visualMatch': 'not-evaluated'}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]))
