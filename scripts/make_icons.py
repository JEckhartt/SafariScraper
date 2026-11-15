"""Generates the app icon and extension icons. Run: python3 scripts/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024

def icon(size, bg=True):
    k = 4  # supersample
    n = size * k
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = n / S
    if bg:
        # vertical blue -> teal gradient
        top, bot = (10, 132, 255), (48, 209, 180)
        for y in range(n):
            t = y / (n - 1)
            d.line([(0, y), (n, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bot)) + (255,))
    fg = (255, 255, 255, 255) if bg else (0, 0, 0, 255)
    # back photo card
    d.rounded_rectangle([300*u, 210*u, 790*u, 620*u], radius=60*u, outline=fg, width=int(44*u))
    # front photo card with mountains + sun
    x0, y0, x1, y1 = 210*u, 330*u, 700*u, 740*u
    if bg:
        d.rounded_rectangle([x0, y0, x1, y1], radius=60*u, fill=(255, 255, 255, 255))
        ink = (10, 132, 255, 255)
    else:
        d.rounded_rectangle([x0, y0, x1, y1], radius=60*u, fill=fg)
        ink = (0, 0, 0, 0)
    d.polygon([(250*u, 700*u), (390*u, 520*u), (470*u, 610*u), (540*u, 540*u), (660*u, 700*u)], fill=ink)
    d.ellipse([540*u, 390*u, 620*u, 470*u], fill=ink)
    # download arrow
    cx = 800*u
    d.line([(cx, 660*u), (cx, 830*u)], fill=fg, width=int(56*u))
    d.polygon([(cx-110*u, 760*u), (cx+110*u, 760*u), (cx, 880*u)], fill=fg)
    return im.resize((size, size), Image.LANCZOS)

app = icon(1024).convert("RGB")  # app icons must not have alpha
app.save(ROOT / "App/Assets.xcassets/AppIcon.appiconset/icon-1024.png")

res = ROOT / "Extension/Resources"
for s in (48, 96, 128, 256, 512):
    icon(s).save(res / f"icon-{s}.png")
for s in (16, 32):
    icon(s, bg=False).save(res / f"toolbar-{s}.png")
print("icons written")


def card_icon(size, bg=True):
    k = 4
    n = size * k
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = n / S
    if bg:
        top, bot = (191, 90, 242), (255, 55, 95)
        for y in range(n):
            t = y / (n - 1)
            d.line([(0, y), (n, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bot)) + (255,))
    fg = (255, 255, 255, 255) if bg else (0, 0, 0, 255)
    ink = (191, 90, 242, 255) if bg else (0, 0, 0, 0)
    # card
    d.rounded_rectangle([250*u, 160*u, 774*u, 864*u], radius=70*u, fill=fg)
    # portrait: head + shoulders
    d.ellipse([432*u, 250*u, 592*u, 410*u], fill=ink)
    d.pieslice([352*u, 420*u, 672*u, 700*u], 180, 360, fill=ink)
    # text lines
    for i, w in enumerate((420, 360, 300)):
        y = 640 + i * 70
        d.rounded_rectangle([(512 - w / 2)*u, y*u, (512 + w / 2)*u, (y + 34)*u], radius=17*u, fill=ink)
    return im.resize((size, size), Image.LANCZOS)



cres = ROOT / "CardExtension/Resources"
if cres.exists():
    for s in (48, 96, 128, 256, 512):
        card_icon(s).save(cres / f"icon-{s}.png")
    for s in (16, 32):
        card_icon(s, bg=False).save(cres / f"toolbar-{s}.png")
    print("card icons written")
