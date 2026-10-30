"""对自包含 Blender GLB 的 PNG IDAT 做一轮无损重压；不改像素、网格、蒙皮或动作。"""
import argparse
import copy
import hashlib
import json
import struct
import zlib
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def png_chunks(data):
    assert data.startswith(b'\x89PNG\r\n\x1a\n'), 'PNG_SIGNATURE_INVALID'
    result = []
    offset = 8
    while offset < len(data):
        size = struct.unpack_from('>I', data, offset)[0]
        end = offset + size + 12
        assert end <= len(data), 'PNG_CHUNK_TRUNCATED'
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + size]
        assert zlib.crc32(kind + payload) & 0xffffffff == struct.unpack_from('>I', data, end - 4)[0], 'PNG_CRC_INVALID'
        result.append((kind, payload, data[offset:end]))
        offset = end
    assert result and result[-1][0] == b'IEND', 'PNG_IEND_MISSING'
    return result


def compress(source, target):
    raw = source.read_bytes()
    magic, version, length = struct.unpack_from('<III', raw)
    assert (magic, version, length) == (0x46546c67, 2, len(raw)), 'GLB_HEADER_INVALID'
    json_length, json_type = struct.unpack_from('<II', raw, 12)
    bin_length, bin_type = struct.unpack_from('<II', raw, 20 + json_length)
    assert json_type == 0x4e4f534a and bin_type == 0x004e4942, 'GLB_CHUNKS_UNSUPPORTED'
    assert 28 + json_length + bin_length == len(raw), 'GLB_CHUNKS_TRUNCATED'
    document = json.loads(raw[20:20 + json_length])
    original = copy.deepcopy(document)
    assert len(document['buffers']) == 1 and 'uri' not in document['buffers'][0], 'SELF_CONTAINED_GLB_REQUIRED'
    assert not set(document.get('extensionsUsed', [])) & {'EXT_meshopt_compression', 'KHR_draco_mesh_compression'}, 'COMPRESSED_GEOMETRY_UNSUPPORTED'
    binary = raw[28 + json_length:]
    image_views = {image['bufferView'] for image in document.get('images', []) if image.get('mimeType') == 'image/png' and 'bufferView' in image}
    output = bytearray()
    images = []
    for index, view in enumerate(document['bufferViews']):
        assert view['buffer'] == 0, 'EXTERNAL_BUFFER_UNSUPPORTED'
        start = view.get('byteOffset', 0)
        assert 0 <= start <= start + view['byteLength'] <= len(binary), 'BUFFER_VIEW_OUT_OF_BOUNDS'
        data = binary[start:start + view['byteLength']]
        replacement = data
        if index in image_views:
            chunks = png_chunks(data)
            scanlines = zlib.decompress(b''.join(payload for kind, payload, _ in chunks if kind == b'IDAT'))
            compressed = zlib.compress(scanlines, 9)
            idat = struct.pack('>I', len(compressed)) + b'IDAT' + compressed + struct.pack('>I', zlib.crc32(b'IDAT' + compressed) & 0xffffffff)
            parts = [b'\x89PNG\r\n\x1a\n']
            inserted = False
            for kind, _, chunk in chunks:
                if kind == b'IDAT':
                    if not inserted:
                        parts.append(idat)
                        inserted = True
                else:
                    parts.append(chunk)
            candidate = b''.join(parts)
            if len(candidate) < len(data):
                replacement = candidate
            checked = png_chunks(replacement)
            assert scanlines == zlib.decompress(b''.join(payload for kind, payload, _ in checked if kind == b'IDAT'))
            assert [(kind, payload) for kind, payload, _ in chunks if kind != b'IDAT'] == [(kind, payload) for kind, payload, _ in checked if kind != b'IDAT']
            images.append({'view': index, 'before': len(data), 'after': len(replacement), 'scanlineSha256': sha(scanlines), 'otherChunksUnchanged': True})
        output.extend(b'\0' * (-len(output) % 4))
        view['byteOffset'] = len(output)
        view['byteLength'] = len(replacement)
        output.extend(replacement)
        if index not in image_views:
            assert output[view['byteOffset']:view['byteOffset'] + view['byteLength']] == data
    output.extend(b'\0' * (-len(output) % 4))
    document['buffers'][0]['byteLength'] = len(output)
    # 只有 bufferViews 的偏移/长度和单一 buffer 长度能改变；保留全部未知字段。
    check = copy.deepcopy(document)
    check['bufferViews'] = original['bufferViews']
    check['buffers'] = original['buffers']
    assert check == original, 'GLTF_OBJECTS_CHANGED'
    encoded = json.dumps(document, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    packed = struct.pack('<III', 0x46546c67, 2, 28 + len(encoded) + len(output)) + struct.pack('<II', len(encoded), 0x4e4f534a) + encoded + struct.pack('<II', len(output), 0x004e4942) + output
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(packed)
    report = {'inputBytes': len(raw), 'outputBytes': len(packed), 'inputSha256': sha(raw), 'outputSha256': sha(packed), 'images': images, 'nonImageBufferViewsUnchanged': True, 'meshSkinNodesAnimationsAccessorsMaterialsUnchanged': True}
    target.with_suffix('.png-lossless.json').write_text(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert args.input.resolve() != args.output.resolve(), 'DISTINCT_DERIVATION_PATH_REQUIRED'
    print(json.dumps(compress(args.input, args.output)))
