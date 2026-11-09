#!/usr/bin/env python3
"""
Generates the Keyring app icons from a single vector-style description.
Run:  python3 tools/make_icons.py
Outputs into icons/: icon-512.png, icon-192.png, apple-touch-icon.png,
maskable-512.png and icon.svg
"""
import os
import math
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "icons"))
os.makedirs(OUT, exist_ok=True)

C1 = (124, 155, 255)   # #7c9bff
C2 = (34, 211, 238)    # #22d3ee
INK = (10, 14, 23)     # #0a0e17


def diagonal_gradient(size):
    """Smooth top-left -> bottom-right gradient, drawn small then upscaled."""
    small = 256
    img = Image.new("RGB", (small, small))
    px = img.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            # ease for a slightly richer middle
            t = t ** 0.92
            px[x, y] = (
                round(C1[0] + (C2[0] - C1[0]) * t),
                round(C1[1] + (C2[1] - C1[1]) * t),
                round(C1[2] + (C2[2] - C1[2]) * t),
            )
    return img.resize((size, size), Image.LANCZOS).convert("RGBA")


def bezier_samples(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        x = (u ** 3) * p0[0] + 3 * (u ** 2) * t * p1[0] + 3 * u * (t ** 2) * p2[0] + (t ** 3) * p3[0]
        y = (u ** 3) * p0[1] + 3 * (u ** 2) * t * p1[1] + 3 * u * (t ** 2) * p2[1] + (t ** 3) * p3[1]
        pts.append((x, y))
    return pts


def shield_points(scale, ox, oy):
    """Shield path from the 64-unit design grid, scaled + offset."""
    pts = []
    pts.append((19.5, 17.7))
    pts.append((32.0, 12.5))
    pts.append((44.5, 17.7))
    pts.append((44.5, 27.3))
    pts += bezier_samples((44.5, 27.3), (44.5, 36.7), (38.7, 43.5), (32.0, 46.3))
    pts += bezier_samples((32.0, 46.3), (25.3, 43.5), (19.5, 36.7), (19.5, 27.3))
    return [(ox + x * scale, oy + y * scale) for (x, y) in pts]


def draw_mark(img, logo_span_ratio=0.78, rounded=True, radius_ratio=17.0 / 64.0):
    """Draws the keyring mark onto a transparent RGBA square image."""
    size = img.size[0]
    grad = diagonal_gradient(size)

    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
        )
        img.paste(grad, (0, 0), mask)
    else:
        img.paste(grad, (0, 0))

    # Shield + keyhole, centred and scaled
    span = size * logo_span_ratio
    scale = span / 64.0
    ox = (size - span) / 2
    oy = (size - span) / 2

    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.polygon(shield_points(scale, ox, oy), fill=(INK[0], INK[1], INK[2], 56))

    # white keyhole: circle + tapering tail
    cx = ox + 32.0 * scale
    cy = oy + 27.5 * scale
    r = 4.6 * scale
    od.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))
    od.polygon(
        [
            (ox + 32.0 * scale, oy + 30.4 * scale),
            (ox + 29.3 * scale, oy + 38.4 * scale),
            (ox + 34.7 * scale, oy + 38.4 * scale),
        ],
        fill=(255, 255, 255, 255),
    )

    img.alpha_composite(overlay)
    return img


def render(final_size, rounded=True, logo_ratio=0.78, ss=4):
    big = Image.new("RGBA", (final_size * ss, final_size * ss), (0, 0, 0, 0))
    draw_mark(big, logo_span_ratio=logo_ratio, rounded=rounded)
    return big.resize((final_size, final_size), Image.LANCZOS)


def main():
    render(1024).save(os.path.join(OUT, "icon-1024.png"))
    render(512).save(os.path.join(OUT, "icon-512.png"))
    render(192).save(os.path.join(OUT, "icon-192.png"))
    render(180).save(os.path.join(OUT, "icon-180.png"))

    # iOS: no transparency, full bleed (the OS applies its own mask)
    render(180, rounded=False).save(os.path.join(OUT, "apple-touch-icon.png"))

    # Android maskable: full bleed, mark kept inside the 80% safe zone
    render(512, rounded=False, logo_ratio=0.62).save(os.path.join(OUT, "maskable-512.png"))

    print("icons written to", OUT)
    for f in sorted(os.listdir(OUT)):
        print("  ", f)


if __name__ == "__main__":
    main()
