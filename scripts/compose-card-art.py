#!/usr/bin/env python3
"""
compose-card-art.py - fit a PORTRAIT art drop onto the landscape card canvas.

Why this exists (founder 2026-08-30): the AI-Itinerary art was delivered
portrait (660x697). The module card renders `art` at ~1.4 aspect with
resizeMode 'cover', so dropping a portrait source straight into the pipeline
crops its top and bottom off - and the founder's requirement is the image
renders WHOLE. `contain` is not the alternative: that was tried on 2026-08-26
and reverted (letterboxed bands read as broken).

So the art is pre-composed onto the 1200x900 card canvas the ImageryBackdrop
asset contract already specifies - subject right, obsidian copy field left -
and the whole frame survives. The composed PNG is written to the drop root,
NOT under the 2026-08-26 subfolder, because optimize-imagery.py only applies
smart_crop to that subfolder and a smart_crop here would undo the composition.

Usage:  python scripts/compose-card-art.py <source-image> <output-name.png>
Then:   python scripts/optimize-imagery.py
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow required:  python -m pip install Pillow")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DROP = os.path.join(REPO, "Proton Drive Download - 2026-08-25")

CANVAS_W, CANVAS_H = 1200, 900      # the 4:3 card-art contract
OBSIDIAN = (7, 9, 13)               # D.bg - the app surface the card sits on
RIGHT_MARGIN = 22
# Art height as a fraction of the canvas. Under 1.0 so the card's ~5% `cover`
# crop (card 1.4 aspect vs canvas 1.333) can never bite into the artwork.
ART_H_FRAC = 0.97


def compose(src_path, out_name):
    art = Image.open(src_path).convert("RGBA")
    target_h = int(CANVAS_H * ART_H_FRAC)
    target_w = round(art.width * target_h / art.height)
    art = art.resize((target_w, target_h), Image.LANCZOS)

    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), OBSIDIAN)
    x0 = CANVAS_W - RIGHT_MARGIN - target_w
    y0 = (CANVAS_H - target_h) // 2
    if x0 < 0:
        sys.exit("source too wide for the canvas after scaling: x0=%d" % x0)
    canvas.paste(art, (x0, y0), art)

    out = os.path.join(DROP, out_name)
    canvas.save(out, "PNG")
    print("art %dx%d at (%d,%d); copy field %d px = %.1f%%"
          % (target_w, target_h, x0, y0, x0, x0 / CANVAS_W * 100))
    print("wrote", out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    compose(sys.argv[1], sys.argv[2])
