#!/usr/bin/env python3
"""Build a Windows .ico from the Typos PNG renders.

Entries up to 128 px are classic 32-bit BMP/DIB images (readable by NSIS, Resource Hacker and every
Windows version); the 256 px entry is PNG-compressed, as Windows itself does.

Usage: make-ico.py OUT.ico PNG_DIR [size ...]
Expects PNG_DIR/typos-icon-<size>.png (see docs/WINDOWS.md for where those come from).
"""
import io, struct, sys
from PIL import Image

out, png_dir = sys.argv[1], sys.argv[2]
sizes = [int(s) for s in sys.argv[3:]] or [16, 24, 32, 48, 64, 128, 256]

entries = []
for size in sizes:
	im = Image.open('%s/typos-icon-%d.png' % (png_dir, size)).convert('RGBA')
	assert im.size == (size, size), (size, im.size)
	if size >= 256:
		buf = io.BytesIO()
		im.save(buf, 'PNG')
		entries.append((size, buf.getvalue()))
		continue
	px = im.load()
	xor = bytearray()
	for y in range(size - 1, -1, -1):
		for x in range(size):
			r, g, b, a = px[x, y]
			xor += bytes((b, g, r, a))
	row = ((size + 31) // 32) * 4
	mask = bytearray()
	for y in range(size - 1, -1, -1):
		bits = bytearray(row)
		for x in range(size):
			if px[x, y][3] < 128:
				bits[x // 8] |= 0x80 >> (x % 8)
		mask += bits
	header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0)
	entries.append((size, header + bytes(xor) + bytes(mask)))

data = struct.pack('<HHH', 0, 1, len(entries))
offset = 6 + 16 * len(entries)
blobs = b''
for size, blob in entries:
	data += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(blob), offset)
	offset += len(blob)
	blobs += blob
with open(out, 'wb') as fh:
	fh.write(data + blobs)
print('wrote', out, [s for s, _ in entries])
