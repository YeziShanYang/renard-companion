"""Generates Renard's toolbar and store icons from a 16x16 pixel-art fox head.

The art is original to this project (the licensed sprite sheet is never used
for icons). Run from the repository root:  python3 scripts/make-icons.py
"""
import struct
import zlib
from pathlib import Path

PALETTE = {
    '.': (0, 0, 0, 0),
    'K': (47, 47, 46, 255),     # outline
    'O': (214, 121, 65, 255),   # orange
    'R': (157, 80, 33, 255),    # rust shading
    'C': (255, 255, 255, 255),  # cheeks and inner ears
}

HEAD = [
    '................',
    '.KK..........KK.',
    '.KOK........KOK.',
    '.KCOK......KOCK.',
    '.KCOOKKKKKKOOCK.',
    '.KOOOOOOOOOOOOK.',
    'KOOOOOOOOOOOOOOK',
    'KOOKKOOOOOOKKOOK',
    'KOOKKOOOOOOKKOOK',
    'KROOOOOOOOOOOORK',
    '.KCCCOOOOOOCCCK.',
    '.KCCCCCKKCCCCCK.',
    '..KCCCCCCCCCCK..',
    '...KKCCCCCCKK...',
    '.....KKKKKK.....',
    '................',
]

SIZES = [16, 32, 48, 96, 128]


def write_png(path, rows):
    height, width = len(rows), len(rows[0])
    raw = b''.join(b'\x00' + bytes(v for px in row for v in px) for row in rows)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    path.write_bytes(png)


def render(size):
    # Integer upscale, centered; sizes that are not multiples of 16 get a margin.
    scale = size // 16
    pad = (size - 16 * scale) // 2
    canvas = [[PALETTE['.'] for _ in range(size)] for _ in range(size)]
    for y, line in enumerate(HEAD):
        for x, ch in enumerate(line):
            for dy in range(scale):
                for dx in range(scale):
                    canvas[pad + y * scale + dy][pad + x * scale + dx] = PALETTE[ch]
    return canvas


def main():
    out = Path(__file__).resolve().parent.parent / 'src' / 'icons'
    out.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        write_png(out / f'icon-{size}.png', render(size))
        print(f'wrote icons/icon-{size}.png')


if __name__ == '__main__':
    main()
