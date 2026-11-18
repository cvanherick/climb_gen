"""Import the user's screenshot archive without executing its HTML or fetching URLs."""
import csv
import io
import json
import zipfile
from pathlib import Path
import argparse
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
args = parser.parse_args()
with zipfile.ZipFile(args.archive) as archive:
    rows = list(csv.DictReader(io.StringIO(archive.read('tb2_hold_metadata.csv').decode())))
    profiles = {}
    for row in rows:
        hold_id = int(row['position_id'])
        if hold_id in profiles:
            raise ValueError('Duplicate position ID')
        material = row['material']
        if material not in ('wood', 'plastic'):
            raise ValueError('Unknown material')
        crop = f'id_{hold_id}_{material}.png'
        (ROOT / 'assets/hold-crops' / crop).write_bytes(archive.read('holds/' + crop))
        profiles[hold_id] = dict(id=hold_id, x=float(row['grid_x']), y=float(row['grid_y']),
            material=material, crop=crop, directionClass=row['primary_direction_class'],
            # Image coordinates point down; board coordinates point up.
            pull=dict(x=float(row['estimated_force_x']), y=-float(row['estimated_force_y'])),
            confidence=row['direction_confidence'].lower(), verified=False,
            unknown=row['primary_direction_class'] == 'ambiguous_rounded',
            aspectRatio=float(row['shape_aspect_ratio']), note=row['confidence_note'])
    if set(profiles) != set(range(304, 802)):
        raise ValueError('Expected all 498 placement IDs')
    (ROOT / 'docs/hold-references/tb2_hold_metadata.csv').write_bytes(archive.read('tb2_hold_metadata.csv'))
    (ROOT / 'docs/hold-references/README.txt').write_bytes(archive.read('README.txt'))
items = sorted((ROOT / 'assets/hold-crops').glob('*.png'))
atlas = Image.new('RGB', (16 * 64, 32 * 64), 'white')
for i, path in enumerate(items):
    image = Image.open(path).convert('RGB')
    image.thumbnail((60, 60))
    atlas.paste(image, ((i % 16) * 64 + (64 - image.width) // 2, (i // 16) * 64 + (64 - image.height) // 2))
    profiles[int(path.stem.split('_')[1])]['atlasIndex'] = i
atlas.save(ROOT / 'assets/tb2-hold-crops-atlas.webp', quality=95, method=6)
payload = dict(layout_id=10, coordinateSystem='board-x-right-y-up', vectorMeaning='climber pull on hold; no measured magnitude', holds=profiles)
(ROOT / 'data/tb2-hold-profiles.js').write_text('globalThis.CLIMBGEN_HOLD_PROFILES = ' + json.dumps(payload, separators=(',', ':')) + ';\n')
print(f'Imported {len(profiles)} hold profiles and crops')
