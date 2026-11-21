import hashlib
import json
import math
import urllib.request
from pathlib import Path

from PIL import Image, ImageEnhance

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'source/materials'
OUTPUT = HERE.parent.parent / 'assets/city/materials'
ASSETS = {
    'granite': {
        'asset': 'granite_tile_04', 'author': 'Amal Kumar', 'repeatMeters': 2,
        'files': {
            'color': ('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/granite_tile_04/granite_tile_04_diff_1k.jpg', '595d91a7ea4a3c4f9ba63186b070a2a4'),
            'normal': ('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/granite_tile_04/granite_tile_04_nor_gl_1k.jpg', '93cbb06b6a7a9fad7771589964b3c282'),
            'arm': ('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/granite_tile_04/granite_tile_04_arm_1k.jpg', 'c59a9a86eedb2ecc97e3356b92860bd3'),
        },
    },
    'asphalt': {
        'asset': 'asphalt_02', 'author': 'Rob Tuytel', 'repeatMeters': 3,
        'files': {
            'color': ('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/asphalt_02/asphalt_02_diff_1k.jpg', 'fa19772d4817754c3efab708c651f5a8'),
            'normal': ('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/asphalt_02/asphalt_02_nor_gl_1k.jpg', '338da8de636ea36133170578cac82e8e'),
            'arm': ('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/asphalt_02/asphalt_02_arm_1k.jpg', '33820445f43af5e5ee484674b6939271'),
        },
    },
}


def build():
    SOURCE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {'license': 'CC0-1.0', 'provider': 'Poly Haven', 'materials': {}}
    for key, asset in ASSETS.items():
        material = {'source': 'https://polyhaven.com/a/' + asset['asset'],
                    'author': asset['author'], 'repeatMeters': asset['repeatMeters'],
                    'colorAdjustment': {'saturation': 0.1, 'brightness': 1.35} if key == 'granite' else None, 'maps': {}}
        for kind, (url, expected_md5) in asset['files'].items():
            cached = SOURCE / f'{key}-{kind}.jpg'
            if not cached.exists():
                request = urllib.request.Request(url, headers={'User-Agent': 'AIO-material-study/1.0'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    cached.write_bytes(response.read())
            raw = cached.read_bytes()
            assert hashlib.md5(raw).hexdigest() == expected_md5, f'Checksum mismatch: {cached.name}'
            image = Image.open(cached).convert('RGB')
            source_size = list(image.size)
            size = 512 if kind == 'color' else 256
            image = image.resize((size, size), Image.Resampling.LANCZOS)
            if key == 'granite' and kind == 'color':
                image = ImageEnhance.Color(image).enhance(0.1)
                image = ImageEnhance.Brightness(image).enhance(1.35)
            if kind == 'normal':
                pixels = []
                for r, g, b in image.getdata():
                    vector = [r / 127.5 - 1, g / 127.5 - 1, b / 127.5 - 1]
                    length = math.sqrt(sum(v * v for v in vector)) or 1
                    pixels.append(tuple(max(0, min(255, round((v / length + 1) * 127.5))) for v in vector))
                image.putdata(pixels)
            target = OUTPUT / f'{key}-{kind}.webp'
            image.save(target, 'WEBP', quality=78 if kind == 'color' else 88, method=6)
            material['maps'][kind] = {
                'file': target.name, 'bytes': target.stat().st_size,
                'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                'sourceUrl': url, 'sourceMd5': expected_md5, 'sourcePixels': source_size,
                'pixels': [size, size], 'colorSpace': 'sRGB' if kind == 'color' else 'linear',
            }
            print(target.name, target.stat().st_size, flush=True)
        manifest['materials'][key] = material
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Total texture bytes:', sum(m['bytes'] for asset in manifest['materials'].values() for m in asset['maps'].values()))


if __name__ == '__main__':
    build()
