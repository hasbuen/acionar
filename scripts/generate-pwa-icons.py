from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "icons"
OUTPUT.mkdir(exist_ok=True)


def font(size: int):
    candidates = (
        Path("C:/Windows/Fonts/arialbd.ttf"),
        Path("C:/Windows/Fonts/segoeuib.ttf"),
    )
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def create_icon(size: int, output_name: str, safe_padding: float = 0.0):
    image = Image.new("RGB", (size, size), "#2563eb")
    pixels = image.load()
    for y in range(size):
        ratio = y / max(size - 1, 1)
        start = (37, 99, 235)
        end = (30, 64, 175)
        color = tuple(round(start[i] + (end[i] - start[i]) * ratio) for i in range(3))
        for x in range(size):
            pixels[x, y] = color

    draw = ImageDraw.Draw(image)
    inset = round(size * safe_padding)
    logo_size = round(size * (0.56 if safe_padding else 0.62))
    logo_font = font(logo_size)
    bounds = draw.textbbox((0, 0), "A", font=logo_font, stroke_width=max(1, size // 128))
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    x = (size - width) / 2 - bounds[0]
    y = (size - height) / 2 - bounds[1] - size * 0.015
    x = min(max(x, inset), size - inset - width)
    y = min(max(y, inset), size - inset - height)
    draw.text(
        (x, y),
        "A",
        font=logo_font,
        fill="white",
        stroke_width=max(1, size // 128),
        stroke_fill="white",
    )
    image.save(OUTPUT / output_name, "PNG", optimize=True)


create_icon(192, "icon-192.png")
create_icon(512, "icon-512.png")
create_icon(512, "icon-maskable-512.png", safe_padding=0.12)
create_icon(180, "apple-touch-icon.png")
create_icon(96, "badge-96.png", safe_padding=0.12)
