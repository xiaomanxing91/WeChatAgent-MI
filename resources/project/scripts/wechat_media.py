"""Local-only media helpers copied from weflow-cli 3d56da9 (MIT).

Only image codec and verified local key lookup are retained. This module has
no export UI, remote fetching, process-memory access, or persistent secrets.
Original license: components/weflow-cli/LICENSE.
"""
import contextlib
import os
import pathlib
import re
import struct
import subprocess
import tempfile
import hashlib
from pathlib import Path
MAX_EMBED_SIZE = 8 * 1024 * 1024
V2_MAGIC = b"\x07\x08V2\x08\x07"
V2_CIPHERTEXT_START = 15
# A V2 original photo is not a raster. The container publishes a wxgf payload
# that is a short HEVC still, so it needs a video decoder before anything can
# read pixels out of it. The key search already accepts this magic; the decode
# path has to accept it too, or every original is discarded in favour of the
# much smaller thumbnail that sits beside it.
WXGF_MAGIC = b"wxgf"
WXGF_MIME = "image/wxgf"
WXGF_FRAME_LIMIT = 4
# Identifies the geometry and quality ladder used to build a preview. Cached
# previews carry it so a pipeline change invalidates them instead of leaving
# stale low-resolution results in place forever. Owned here because both the
# preview encoder and the cache reader depend on it and neither may own it.
PREVIEW_PIPELINE_VERSION = 2


def clean_account_wxid(value):
    value = str(value or '').strip()
    parts = value.rsplit('_', 1)
    if len(parts) == 2 and len(parts[1]) == 4 and parts[1].isalnum():
        return parts[0]
    return value

def resolve_v2_media_key(account_dir, own_wxid='', kvcomm_dir=''):
    """Derive and verify the local WeChat V2 image key without persisting it."""
    if not account_dir:
        return None
    if not kvcomm_dir:
        appdata = os.environ.get('APPDATA', '')
        kvcomm_dir = os.path.join(appdata, 'Tencent', 'xwechat', 'net', 'kvcomm')
    try:
        codes = sorted({
            int(match.group(1))
            for name in os.listdir(kvcomm_dir)
            if (match := re.fullmatch(r'key_(\d+)_.+\.statistic', name, re.IGNORECASE))
        })
    except (OSError, ValueError):
        return None
    if not codes:
        return None

    templates = []
    for root in ('msg', 'cache', 'resource'):
        search_root = os.path.join(account_dir, root)
        if not os.path.isdir(search_root):
            continue
        for current_root, _, files in os.walk(search_root):
            for name in files:
                if not name.lower().endswith('_t.dat'):
                    continue
                path = os.path.join(current_root, name)
                try:
                    with open(path, 'rb') as stream:
                        header = stream.read(V2_CIPHERTEXT_START + 16)
                    if header.startswith(V2_MAGIC) and len(header) >= V2_CIPHERTEXT_START + 16:
                        templates.append(header[V2_CIPHERTEXT_START:V2_CIPHERTEXT_START + 16])
                except OSError:
                    continue
                if len(templates) >= 32:
                    break
            if len(templates) >= 32:
                break
        if len(templates) >= 32:
            break
    if not templates:
        return None

    wxids = list(dict.fromkeys(filter(None, (
        clean_account_wxid(own_wxid),
        clean_account_wxid(Path(account_dir).name),
    ))))
    try:
        from Crypto.Cipher import AES
    except ImportError:
        return None
    for wxid in wxids:
        for code in codes:
            aes_key = hashlib.md5(f'{code}{wxid}'.encode()).hexdigest()[:16].encode('ascii')
            try:
                plaintext = AES.new(aes_key, AES.MODE_ECB).decrypt(templates[0])
            except (TypeError, ValueError):
                continue
            if detect_mime_from_bytes(plaintext) or plaintext.startswith((b'wxgf', b'WXGF')):
                return code & 0xff, aes_key
    return None

def decode_wechat_v2(filepath, xor_key, aes_key):
    try:
        from Crypto.Cipher import AES
        from Crypto.Util import Padding
        with open(filepath, 'rb') as stream:
            data = stream.read(MAX_EMBED_SIZE + 1)
        if len(data) > MAX_EMBED_SIZE or not data.startswith(V2_MAGIC):
            return None
        signature, aes_size, xor_size = struct.unpack('<6sLLx', data[:V2_CIPHERTEXT_START])
        if signature != V2_MAGIC:
            return None
        encrypted_size = aes_size + 16 - aes_size % 16
        encrypted = data[V2_CIPHERTEXT_START:V2_CIPHERTEXT_START + encrypted_size]
        decrypted = Padding.unpad(AES.new(aes_key, AES.MODE_ECB).decrypt(encrypted), 16)
        remainder = data[V2_CIPHERTEXT_START + encrypted_size:]
        if xor_size:
            if xor_size > len(remainder):
                return None
            raw = remainder[:-xor_size]
            tail = bytes(value ^ xor_key for value in remainder[-xor_size:])
        else:
            raw, tail = remainder, b''
        output = decrypted + raw + tail
        if output.startswith(WXGF_MAGIC):
            # Report the container honestly. Callers that can run ffmpeg ask for
            # the decoded frames; callers that only understand rasters still get
            # a definite answer instead of an unexplained None.
            return (output, WXGF_MIME)
        mime = detect_mime_from_bytes(output[:16])
        return (output, mime) if mime else None
    except (OSError, ValueError, struct.error):
        return None

def is_wxgf(raw):
    return bool(raw) and raw.startswith(WXGF_MAGIC)

def decode_wxgf_frames(raw, limit=WXGF_FRAME_LIMIT, timeout=15):
    """Decode a wxgf still into its raster frames, in stream order.

    WeChat publishes the original as a short HEVC stream rather than a JPEG.
    Most images store a single frame; a few keep a blank leading frame, so the
    caller must not assume frame 0 carries the picture. Returns a list of PNG
    byte strings (possibly empty) and never raises on decoder failure.
    """
    if not is_wxgf(raw):
        return []
    try:
        import imageio_ffmpeg
        executable = imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        raise RuntimeError('IMAGE_WXGF_FFMPEG_UNAVAILABLE') from None
    with _work_directory() as base:
        source = base / 'input.hevc'
        source.write_bytes(raw[4:])
        result = subprocess.run([executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-threads', '1', '-f', 'hevc', '-i', str(source), '-frames:v', str(limit),
            '-f', 'image2', str(base / 'frame-%02d.png')],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0:
            return []
        return [file.read_bytes() for file in sorted(base.glob('frame-*.png'))]

@contextlib.contextmanager
def _work_directory():
    """Scratch space for the decoder, degrading gracefully when TEMP is denied.

    A managed runtime may refuse both the system temp directory and any
    replacement, so each candidate is proven writable before it is handed out;
    a directory the decoder cannot write to would otherwise surface as an
    unexplained decode failure.
    """
    candidates = []
    try:
        candidates.append(pathlib.Path(tempfile.mkdtemp(prefix='wechatagent-wxgf-')))
    except OSError:
        pass
    candidates.append(pathlib.Path(tempfile.gettempdir()) / f'wechatagent-wxgf-{os.getpid()}')
    for base in candidates:
        try:
            base.mkdir(parents=True, exist_ok=True)
            (base / '.probe').write_bytes(b'')
            (base / '.probe').unlink()
        except OSError:
            continue
        try:
            yield base
        finally:
            for file in base.glob('*'):
                try:
                    file.unlink()
                except OSError:
                    pass
            try:
                base.rmdir()
            except OSError:
                pass
        return
    raise RuntimeError('IMAGE_WXGF_WORKDIR_UNAVAILABLE')

def extract_media_md5s(value):
    matches = re.findall(r'(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])', str(value or ''), re.IGNORECASE)
    return list(dict.fromkeys(match.lower() for match in matches))

def extract_blob_md5s(value, known_md5s=None):
    if value is None:
        return []
    if isinstance(value, memoryview):
        data = value.tobytes()
    elif isinstance(value, (bytes, bytearray)):
        data = bytes(value)
    else:
        data = str(value).encode('utf-8', errors='ignore')
    matches = re.findall(rb'(?i)([0-9a-f]{32})(?:[._][thbc])?\.dat', data)
    if not matches:
        matches = re.findall(rb'(?i)(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])', data)
    result = [item.decode('ascii').lower() for item in matches]
    # MessageResourceInfo commonly stores MD5 values as raw 16-byte fields.
    # Index those candidates; get_cached_image will retain only candidates
    # that resolve to an actual local media file.
    for offset in range(0, max(0, len(data) - 15)):
        candidate = data[offset:offset + 16]
        candidate_hex = candidate.hex()
        if (candidate not in (b'\x00' * 16, b'\xff' * 16)
                and (known_md5s is None or candidate_hex in known_md5s)):
            result.append(candidate_hex)
    return list(dict.fromkeys(result))

def detect_mime_from_bytes(header_bytes):
    """Detect MIME type from byte header."""
    if header_bytes[:2] == b'\xff\xd8':
        return 'image/jpeg'
    if header_bytes[:4] == b'\x89PNG':
        return 'image/png'
    if header_bytes[:3] == b'GIF':
        return 'image/gif'
    if header_bytes[:4] == b'RIFF' and len(header_bytes) >= 12 and header_bytes[8:12] == b'WEBP':
        return 'image/webp'
    return None
