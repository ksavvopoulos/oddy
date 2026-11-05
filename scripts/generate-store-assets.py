"""Generate Chrome Web Store assets from the supplied Oddy panel screenshot.

Requires Pillow: python -m pip install Pillow
Run from any directory: python scripts/generate-store-assets.py
"""

from pathlib import Path
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "store-assets"
SOURCE = ASSETS / "source" / "oddy-panel.png"
OUTPUT = ASSETS / "screenshots" / "oddy-overview-1280x800.png"


def font(size, bold=False):
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = (
        [windows / "segoeuib.ttf", Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")]
        if bold
        else [windows / "segoeui.ttf", Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    )
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    raise RuntimeError("Install Segoe UI or DejaVu Sans before generating store assets.")


def main():
    background = "#F4F7FA"
    ink = "#202C44"
    muted = "#53657A"
    teal = "#176F62"
    canvas = Image.new("RGB", (1280, 800), background)

    with Image.open(SOURCE) as original:
        # Trim only the browser's top edge and right scrollbar, not Oddy content.
        panel = original.convert("RGBA").crop((0, 6, original.width - 12, original.height))
    panel_height = 744
    panel_width = round(panel.width * panel_height / panel.height)
    panel = panel.resize((panel_width, panel_height), Image.Resampling.LANCZOS)
    corner_mask = Image.new("L", panel.size)
    ImageDraw.Draw(corner_mask).rounded_rectangle(
        (0, 0, panel_width - 1, panel_height - 1), radius=12, fill=255
    )
    panel.putalpha(corner_mask)
    left, top = 856, 16
    frame = (left, top, left + panel_width + 24, top + panel_height + 24)
    shadow = Image.new("RGBA", canvas.size)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (frame[0] + 2, frame[1] + 9, frame[2] + 2, frame[3] + 9),
        radius=18, fill=(32, 44, 68, 35)
    )
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(12)))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(frame, radius=18, fill="white", outline="#DCE3EC", width=1)
    canvas.alpha_composite(panel, (left + 12, top + 12))

    with Image.open(ROOT / "public" / "icons" / "128.png") as original_icon:
        icon = original_icon.convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)
    canvas.alpha_composite(icon, (76, 68))
    draw = ImageDraw.Draw(canvas)
    draw.text((158, 62), "Oddy", font=font(44, True), fill=ink)
    draw.text((160, 116), "Your Dataverse Raven", font=font(19), fill=muted)

    draw.text((76, 218), "Your Dataverse", font=font(64, True), fill=ink)
    draw.text((76, 295), "Raven.", font=font(64, True), fill=ink)
    draw.text((79, 407), "AI assistance beside your work,", font=font(27), fill=muted)
    draw.text((79, 445), "with context and control.", font=font(27), fill=muted)

    features = [
        "Use the current record’s context",
        "Reuse guided workflow skills",
        "Choose what context to include",
    ]
    for y, label in zip((539, 595, 651), features):
        draw.ellipse((80, y + 7, 98, y + 25), outline=teal, width=2)
        draw.ellipse((86, y + 13, 92, y + 19), fill=teal)
        draw.text((117, y), label, font=font(23), fill=ink)
    draw.text((79, 746), "Works with your Azure OpenAI connection", font=font(18), fill=muted)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # RGB PNG is 24-bit, with no alpha channel, as required for store screenshots.
    canvas.convert("RGB").save(OUTPUT, format="PNG", optimize=True)
    shutil.copyfile(ROOT / "public" / "icons" / "128.png", ASSETS / "icon-128.png")
    with Image.open(OUTPUT) as result:
        assert result.size == (1280, 800) and result.mode == "RGB"
    print(f"Screenshot: {OUTPUT}")
    print(f"Store icon: {ASSETS / 'icon-128.png'}")


if __name__ == "__main__":
    main()
