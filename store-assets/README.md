# Chrome Web Store assets

Upload these files in the store listing's **Graphic assets** section:

- **Store icon:** `icon-128.png` — 128 × 128 PNG, copied from the extension's existing icon.
- **Screenshot:** `screenshots/oddy-overview-1280x800.png` — 1280 × 800, 24-bit RGB PNG without transparency.

The screenshot uses the supplied real Oddy panel capture, trimmed only to remove the outer browser edge and scrollbar. Captions are outside the app image; the app content is not rewritten. The visible contact name and environment remain in the capture: confirm they are suitable for public display before uploading.

These listing assets are outside `public/`, so they are not bundled into the extension ZIP.

## Regenerate

Keep the source capture at `source/oddy-panel.png`, then run:

```bash
python -m pip install Pillow
python scripts/generate-store-assets.py
```

The generator uses Segoe UI on Windows, or DejaVu Sans where available.
