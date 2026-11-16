"""Fetch the hall's curated CC0 Poly Haven assets. Python + requests, Pillow, numpy.

Run from any directory: python sahne/varlik.py [--textures-only | --models-only].
Needs requests, numpy, Pillow, opencv-python.
Original downloads are verified by API byte size and MD5, cached separately,
and never executed. Derived maps are versioned and verified by SHA256 + dimensions.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import time
from urllib.parse import urlparse

import cv2
import numpy as np
from PIL import Image
import requests

ROOT = Path(__file__).resolve().parent / 'varlik'
API = 'https://api.polyhaven.com/'
VERSION = 1
# name: (Poly Haven id, linear albedo multiplier, visual selection reason)
MATERIALS = {
    'beton_zemin': ('concrete_floor_worn_001', 1, 'Dark worn grey floor, fine scratches and stains, no ochre coating; its low spots feed the wetness mask.'),
    'beton_duvar': ('concrete_layers_02', 1, 'Grey cast concrete with horizontal formwork lifts and water stains: a poured retaining wall.'),
    'beton_kolon': ('concrete', 1, 'Raw board-formed concrete, vertical form joints and pores at 4 m: reads as tall cast columns.'),
    'beton_tavan': ('concrete_wall_006', 1, 'Darker, smoother concrete with form-tie holes and soft stains: a ceiling slab seen from 20 m below.'),
    'beton_anit': ('concrete_wall_009', 1, 'Fine, pale, neutral architectural concrete with panel joints and tie holes; neutral so the temperature light reads true.'),
    'celik_boyali_kasa': ('green_metal_rust', 1, 'Olive industrial green paint with sparse rust: the CPU + case fan, distinct in hue from the blue GPU fan.'),
    'celik_boyali_gpu': ('blue_metal_plate', 1, 'Deep blue painted steel panels with worn seams: the GPU fan.'),
    'celik_kanat': ('rusty_metal_sheet', 1, 'Neutral weathered bare steel with light rust: blades that belong to either painted shroud.'),
    'celik_pasli': ('rust_coarse_01', 1, 'Continuous coarse rust without ribs, so narrow rails, chains and grates do not get false relief.'),
    'celik_sac': ('metal_plate', 1, 'Raised diamond tread plate, worn and dirty: the landing deck and stair treads.'),
    'metal_koyu': ('metal_plate_02', .35, 'Aged corroded iron plates, darkened in linear light for brackets and heavy frames.'),
    'kablo': ('rubber_tiles', 1, 'Near-black fine rubber grain (the only black rubber set); cable UVs stay within one tile, away from its seams.'),
}
MODELS = {
    'caged_hanging_light': 'Long protected service light, appropriate over maintenance landings.',
    'industrial_caged_sconce': 'Caged utility lighting with industrial mounts.',
    'industrial_wall_lamp': 'Small oval guarded service lamp against massive concrete.',
    'modular_industrial_pipes_01': 'Flanges, valves and worn pipe elbows belong in a flood-control hall.',
    'modular_airduct_circular_01': 'Round ventilation sections match the huge fans.',
    'modular_electric_cables': 'Cable trays and junction runs add credible service infrastructure.',
    'metal_trash_can': 'Weathered metal maintenance bin, used sparingly near the entry.',
    'Barrel_01': 'Worn steel drum with a hazard pictogram, for a maintenance alcove.',
    'ladder_sectioned_01': 'Service access ladder, consistent with the scale of the infrastructure.',
}
REJECTED = {
    'wood_textured_concrete': 'Brown wood-grain cast reads as timber at a distance, not as grey G-Cans columns.',
    'concrete_wall_008': 'Beige-yellow cast; it would tint the arch light. Neutral concrete_wall_009 instead.',
    'concrete_panels': 'Stepped facade panels: architectural cladding, not structural concrete.',
    'smooth_concrete_floor': 'Brown-red stained surface, reads as an old painted floor.',
    'rusty_painted_metal': 'Red paint fits the colour brief, but strong corrugation is wrong for fan shrouds.',
    'rusty_metal': 'Corrugated orange sheet would emboss false ridges onto narrow rails.',
    'rusty_metal_05': 'Large blue flakes dominate small rails; continuous rust reads more consistently.',
    'concrete_floor_worn_02': 'Coarse sandy relief reads dry and crumbly rather than damp.',
    'worn_concrete_floor': 'Ochre coating reads like a painted factory floor.',
    'concrete_wall_005': 'Large broken patches are too distressed for structural columns.',
    'fire_alarm': 'Prominent baked English lettering conflicts with the Turkish-only world.',
    'WetFloorSign_01': 'Prominent baked English lettering conflicts with the Turkish-only world.',
    'utility_box_01': 'Baked DANGER labels require a Turkish texture replacement before use.',
    'utility_box_02': 'Baked DANGER labels require a Turkish texture replacement before use.',
    'power_box_01': 'Dense printed labels would need a Turkish replacement before use.',
}


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def request(url):
    if urlparse(url).scheme != 'https' or urlparse(url).hostname not in {
        'api.polyhaven.com', 'dl.polyhaven.org', 'cdn.polyhaven.com'
    }:
        raise ValueError(f'Unexpected asset URL: {url}')
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=(15, 120), headers={'User-Agent': 'KontrolMerkezi-CC0-assets/1.0'})
            r.raise_for_status()
            return r
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)


def metadata(kind, asset):
    path = ROOT / 'cache' / f'{asset}-{kind}.json'
    if path.exists():
        return json.loads(path.read_text('utf-8'))
    data = request(API + kind + '/' + asset).json()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), 'utf-8')
    return data


def download(entry, path):
    if path.exists() and path.stat().st_size == entry['size'] and digest(path, 'md5') == entry['md5']:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + '.part')
    part.write_bytes(request(entry['url']).content)
    if part.stat().st_size != entry['size'] or digest(part, 'md5') != entry['md5']:
        raise ValueError(f'Incomplete or corrupt download: {path.name}')
    part.replace(path)
    return path


def map_image(asset, files, key, optional=False):
    if key not in files:
        if optional:
            return None
        raise ValueError(f'{asset} has no required {key} map')
    options = files[key]['2k']
    extension = 'jpg' if key == 'Diffuse' and 'jpg' in options else 'png'
    if extension not in options:
        extension = 'jpg'
    entry = options[extension]
    raw = download(entry, ROOT / 'cache' / asset / Path(urlparse(entry['url']).path).name)
    with Image.open(raw) as image:
        return image.convert('RGB').resize((2048, 2048), Image.Resampling.LANCZOS)


def linear(rgb):
    rgb = np.asarray(rgb, dtype=np.float32) / 255
    return np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)


def save_image(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, **({'quality': 95, 'subsampling': 0} if path.suffix == '.jpg' else {}))


def build_material(name):
    asset, gain, reason = MATERIALS[name]
    files = metadata('files', asset)
    info = metadata('info', asset)
    stem = asset if gain == 1 else name + '_' + asset
    paths = {k: ROOT / 'doku' / (stem + suffix) for k, suffix in {
        'albedo': '_diff_2k.jpg', 'normal': '_nor_gl_2k.png', 'arm': '_arm_2k.png'}.items()}
    receipt = ROOT / 'cache' / (name + '-built.json')
    old = json.loads(receipt.read_text()) if receipt.exists() else {}
    valid = old.get('version') == VERSION
    for key, path in paths.items():
        if not path.exists() or old.get(key) != digest(path):
            valid = False
        elif Image.open(path).size != (2048, 2048):
            valid = False
    if not valid:
        albedo = map_image(asset, files, 'Diffuse')
        if gain != 1:
            a = linear(albedo) * gain
            a = np.where(a <= .0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - .055)
            albedo = Image.fromarray(np.uint8(np.clip(a * 255 + .5, 0, 255)))
        normal = map_image(asset, files, 'nor_gl')
        arm = map_image(asset, files, 'arm', optional=True)
        if arm is None:
            ao = map_image(asset, files, 'AO', optional=True)
            rough = map_image(asset, files, 'Rough')
            metal = map_image(asset, files, 'Metal', optional=True)
            arm = Image.merge('RGB', (
                ao.convert('L') if ao else Image.new('L', (2048, 2048), 255),
                rough.convert('L'), metal.convert('L') if metal else Image.new('L', (2048, 2048), 0)))
        for key, im in [('albedo', albedo), ('normal', normal), ('arm', arm)]:
            save_image(im, paths[key])
        receipt.write_text(json.dumps({'version': VERSION, **{k: digest(p) for k, p in paths.items()}}))
    with Image.open(paths['albedo']) as im:
        mean = linear(im.convert('RGB')).mean(axis=(0, 1), dtype=np.float64).tolist()
    dimensions = info.get('dimensions')
    if not dimensions or dimensions[0] <= 0:
        raise ValueError(f'No real-world texture width for {asset}')
    if abs(dimensions[0] - dimensions[1]) > 0.01 * dimensions[0]:
        raise ValueError(f'{asset} is not square; a 2048 x 2048 resize would distort it')
    print(f'{name}: {asset}: {reason}', flush=True)
    return name, {'kaynak': asset, **{k: p.relative_to(ROOT).as_posix() for k, p in paths.items()},
                  'olcek_m': dimensions[0] / 1000, 'ortalama': mean, 'lisans': 'CC0-1.0',
                  'albedo_carpani_lineer': gain}


def safe_child(parent, relative):
    parts = PurePosixPath(relative)
    if parts.is_absolute() or '..' in parts.parts or ':' in relative or '\\' in relative:
        raise ValueError(f'Unsafe model dependency: {relative}')
    return parent.joinpath(*parts.parts)


def build_model(asset):
    files = metadata('files', asset)
    entry = files['gltf']['2k']['gltf']
    parent = ROOT / 'model' / asset
    path = download(entry, parent / (asset + '_2k.gltf'))
    for relative, dependency in entry.get('include', {}).items():
        download(dependency, safe_child(parent, relative))
    data = json.loads(path.read_text('utf-8'))
    for item in data.get('buffers', []) + data.get('images', []):
        if 'uri' in item and not item['uri'].startswith('data:'):
            dependency = safe_child(parent, item['uri'])
            if not dependency.is_file():
                raise ValueError(f'Missing glTF dependency: {dependency}')
    print(f'{asset}: {MODELS[asset]}', flush=True)
    return asset, {'gltf': path.relative_to(ROOT).as_posix(), 'lisans': 'CC0-1.0'}


def wetness():
    """Puddle mask for beton_zemin: 1 = standing water, 0 = dry; same uv as the floor's maps.

    Water collects in the low parts of the scanned floor, so the mask is the floor's own 16-bit
    displacement, low-passed (sigma 40 px = 6 cm at 3 m per tile, puddle-sized blobs) and mapped
    through a soft ramp: below the 25th height percentile fully wet, above the 60th dry. Float
    throughout: an 8-bit intermediate posterises the ramp into visible contour bands.
    """
    asset = MATERIALS['beton_zemin'][0]
    entry = metadata('files', asset)['Displacement']['2k']['png']
    raw = download(entry, ROOT / 'cache' / asset / Path(urlparse(entry['url']).path).name)
    height = cv2.imread(str(raw), cv2.IMREAD_UNCHANGED)
    if height.ndim == 3:
        height = height[..., 0]
    height = cv2.resize(height.astype(np.float32) / np.iinfo(height.dtype).max, (2048, 2048),
                        interpolation=cv2.INTER_AREA)
    # Wrap padding keeps the mask tileable across the Gaussian filter.
    pad = 256
    tiled = np.pad(height, pad, mode='wrap')
    smooth = cv2.GaussianBlur(tiled, (0, 0), 40)[pad:-pad, pad:-pad]
    lo, hi = np.percentile(smooth, [25, 60])
    t = np.clip((hi - smooth) / max(hi - lo, 1e-6), 0, 1)
    t = t * t * (3 - 2 * t)
    save_image(Image.fromarray(np.uint8(t * 255 + .5)), ROOT / 'doku/zemin_islak_2k.png')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--textures-only', action='store_true')
    mode.add_argument('--models-only', action='store_true')
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    manifest = ROOT / 'varlik.json'
    result = json.loads(manifest.read_text('utf-8')) if manifest.exists() else {'malzemeler': {}, 'modeller': {}}
    # Materials sharing a source run serially: no concurrent writes to shared map paths.
    if not args.models_only:
        result['malzemeler'] = dict(build_material(name) for name in MATERIALS)
        wetness()
        result['islaklik'] = {'beton_zemin': 'doku/zemin_islak_2k.png', 'beyaz': 'wet', 'siyah': 'dry'}
    if not args.textures_only:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            result['modeller'] = dict(pool.map(build_model, MODELS))
    result['lisans'] = {'ad': 'CC0-1.0', 'kaynak': 'https://polyhaven.com/license',
                       'metin': 'https://creativecommons.org/publicdomain/zero/1.0/'}
    temporary = manifest.with_suffix('.json.part')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    temporary.replace(manifest)
    (ROOT / 'LICENSE.txt').write_text('All downloaded textures/models: Poly Haven, CC0 1.0 Universal.\n'
        'https://polyhaven.com/license\nhttps://creativecommons.org/publicdomain/zero/1.0/\n', 'utf-8')
    for asset, why in REJECTED.items():
        print(f'Rejected {asset}: {why}')
    print(f'CC0-1.0: {len(result["malzemeler"])} materials, {len(result["modeller"])} models. {manifest}')


if __name__ == '__main__':
    main()
