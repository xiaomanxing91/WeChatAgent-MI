"""Bounded local image previews shared by received and collected stickers."""
import base64,hashlib,io
from PIL import Image,ImageOps
from wechat_media import PREVIEW_PIPELINE_VERSION

# Detail previews are capped at a 2048px long edge: the vision route projects
# every request image onto a ~1024-token patch grid, so a longer edge only adds
# bytes the provider discards. Sticker sheets keep the older 1280px bound, which
# already fits the widest sampled animation budget.
PREVIEW_MAX_EDGE = 1280
PREVIEW_MAX_BYTES = 768 * 1024
# The transport in image-input.mjs refuses anything above 768 KiB per image, so
# this ceiling is fixed by the wire format rather than by image quality.
DETAIL_MAX_EDGE = 2048
DETAIL_MAX_BYTES = 768 * 1024
# Quality ladder, walked until the encoded image fits the byte target. Alpha is
# dropped by this stage, so plain JPEG is always available.
DETAIL_QUALITIES = (88, 80, 72, 64, 56, 48)

def normalize_image(raw, animated=False):
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise RuntimeError('IMAGE_TOO_LARGE_OR_EMPTY')
    with Image.open(io.BytesIO(raw)) as source:
        if source.width * source.height > 40_000_000:
            raise RuntimeError('IMAGE_PIXEL_LIMIT')
        if animated and getattr(source, 'is_animated', False):
            # Bound decoded pixels and frames. A static sheet conveys sampled
            # animation content without repeatedly sending entire animations.
            budget = min(128, max(1, 80_000_000 // (source.width * source.height)))
            count=min(getattr(source,'n_frames',1),budget)
            frames=[]
            for index in dict.fromkeys((0,(count-1)//2,count-1)):
                source.seek(index)
                frame = source.convert('RGBA')
                frame.thumbnail((384, 384))
                background = Image.new('RGB', frame.size, 'white')
                background.paste(frame, mask=frame.getchannel('A'))
                frames.append(background)
            image = Image.new('RGB', (sum(f.width for f in frames), max(f.height for f in frames)), 'white')
            x = 0
            for frame in frames:
                image.paste(frame, (x, 0)); x += frame.width
        else:
            image = ImageOps.exif_transpose(source).convert('RGB')
    return _encode(image, animated)

def _encode(image, animated):
    """Encode one image, preferring the largest size that fits the byte target.

    A downscale ladder walks resolution before quality: dropping resolution
    costs the model real detail, while dropping quality mostly costs file size.
    The receiver only ever holds a thumbnail, so this must not fail where the
    old single-size path succeeded.
    """
    max_edge = PREVIEW_MAX_EDGE if animated else DETAIL_MAX_EDGE
    max_bytes = PREVIEW_MAX_BYTES if animated else DETAIL_MAX_BYTES
    # Deduplicated so a bound that already sits in the ladder costs one pass, not two.
    for edge in dict.fromkeys((max_edge, 1280, 1024, 800)):
        scaled = image.copy()
        scaled.thumbnail((edge, edge), Image.LANCZOS)
        for quality in DETAIL_QUALITIES:
            output = io.BytesIO()
            scaled.save(output, format='JPEG', quality=quality, optimize=True, subsampling=0)
            data = output.getvalue()
            if len(data) <= max_bytes:
                return {'b64': base64.b64encode(data).decode('ascii'), 'mime': 'image/jpeg',
                    'width': scaled.width, 'height': scaled.height, 'bytes': len(data),
                    'sha256': hashlib.sha256(data).hexdigest(), 'pipeline': PREVIEW_PIPELINE_VERSION}
    raise RuntimeError('NORMALIZED_IMAGE_TOO_LARGE')

