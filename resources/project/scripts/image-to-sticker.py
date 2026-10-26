#!/usr/bin/env python3
"""Convert a generated PNG/JPG into a WeChat-sendable sticker GIF.

Writes <md5>.gif into state/stickers/outgoing (the only directory the native
sender accepts) and prints the metadata the sender needs as JSON.
"""
import hashlib
import json
import os
import sys

MAX_SIDE = 512
MAX_BYTES = 8 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"error": "usage: image-to-sticker.py <source> <outgoing-dir>"}))
        return 2
    source, outgoing = sys.argv[1], sys.argv[2]
    try:
        from PIL import Image
    except Exception:
        print(json.dumps({"error": "PIL_UNAVAILABLE"}))
        return 3
    if not os.path.isfile(source):
        print(json.dumps({"error": "SOURCE_MISSING"}))
        return 4
    os.makedirs(outgoing, exist_ok=True)
    try:
        image = Image.open(source)
        image.load()
    except Exception:
        print(json.dumps({"error": "SOURCE_INVALID"}))
        return 5
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image).convert("RGB")
    else:
        image = image.convert("RGB")
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    payload = None
    for colors in (255, 128, 64):
        quantized = image.convert("P", palette=Image.ADAPTIVE, colors=colors)
        tmp = os.path.join(outgoing, ".tmp-" + os.urandom(6).hex() + ".gif")
        quantized.save(tmp, format="GIF", optimize=True)
        size = os.path.getsize(tmp)
        if size <= MAX_BYTES:
            payload = (tmp, size)
            break
        os.remove(tmp)
    if not payload:
        print(json.dumps({"error": "GIF_TOO_LARGE"}))
        return 6
    tmp, size = payload
    with open(tmp, "rb") as handle:
        digest = hashlib.md5(handle.read()).hexdigest()
    target = os.path.join(outgoing, digest + ".gif")
    os.replace(tmp, target)
    print(json.dumps({
        "ok": True,
        "path": target,
        "md5": digest,
        "len": size,
        "width": image.width,
        "height": image.height,
        "type": 0,
        "productid": "",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
