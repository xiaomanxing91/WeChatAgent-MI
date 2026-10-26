"""Message-bound sticker decoding. No process access or arbitrary URL input.

Cache layout and AES-CBC key=IV convention follow weflow-cli 3d56da9 (MIT).
Original license: components/weflow-cli/LICENSE. Credentials stay in memory.
"""
import hashlib
import base64
import io
import pathlib
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
from PIL import Image

MAX_BYTES = 8 * 1024 * 1024
CDN_HOSTS = frozenset({'wxapp.tc.qq.com', 'vweixinf.tc.qq.com'})
APPMSG_STICKER_TYPE = 8 * 2**32 + 49


def emoji_info_attributes(value,md5):
    """Read message-bound appmsg-8 emojiinfo (base64 protobuf), without I/O."""
    if not isinstance(value,str) or not value or len(value)>65536:return {}
    try:
        data=base64.b64decode(''.join(value.split()),validate=True)
        names={1:'md5',2:'cdnurl',3:'thumburl',5:'encrypturl',6:'aeskey',8:'externurl',9:'externmd5'}
        values={};at=0;count=0
        def integer(offset):
            result=0
            for shift in range(0,70,7):
                if offset>=len(data):raise ValueError()
                byte=data[offset];offset+=1
                if shift==63 and byte>1:raise ValueError()
                result|=(byte&127)<<shift
                if byte<128:return result,offset
            raise ValueError()
        while at<len(data):
            count+=1
            if count>128:raise ValueError()
            tag,at=integer(at);number,wire=tag>>3,tag&7
            if not 0<number<2**29:raise ValueError()
            if wire==2:
                size,at=integer(at);end=at+size
                if end>len(data):raise ValueError()
                if number in names:
                    if number in values or size>8192:raise ValueError()
                    values[number]=data[at:end].decode('utf-8')
                at=end
            elif wire==0:_,at=integer(at)
            elif wire in (1,5):
                at+=8 if wire==1 else 4
                if at>len(data):raise ValueError()
            else:raise ValueError()
        if values.get(1,'').lower()!=md5.lower():return {}
        result={names[number]:text for number,text in values.items() if text}
        if result.get('aeskey') and not re.fullmatch(r'(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{64})',result['aeskey']):result.pop('aeskey')
        if result.get('externmd5') and not re.fullmatch('[a-fA-F0-9]{32}',result['externmd5']):result.pop('externmd5')
        return result
    except (ValueError,UnicodeError):
        return {}


def sticker_image_xml(local_type,content):
    """Normalize appmsg-8 stickers while excluding files and other appmsgs."""
    if local_type==47:
        return content
    if local_type not in (49,APPMSG_STICKER_TYPE) or not content or len(content)>100_000 or '<!DOCTYPE' in content.upper() or '<!ENTITY' in content.upper():
        return None
    try:
        root=ET.fromstring(content)
        app=root.find('appmsg') if root.tag=='msg' else root if root.tag=='appmsg' else None
        if app is None or app.findtext('type')!='8':return None
        attach=app.find('appattach')
        if attach is None:return None
        attrs={'md5':attach.findtext('emoticonmd5',''),'type':'2'}
        attrs.update(emoji_info_attributes(attach.findtext('emojiinfo',''),attrs['md5']))
        for field,name in [('totallen','len'),('cdnattachurl','cdnurl'),('aeskey','aeskey')]:
            value=attach.findtext(field)
            if value:attrs[name]=value
        normalized=ET.Element('msg');ET.SubElement(normalized,'emoji',attrs)
        result=ET.tostring(normalized,encoding='unicode');emoji_attributes(result)
        return result
    except (ET.ParseError,RuntimeError):
        return None


def emoji_attributes(content):
    if not content or len(content) > 100_000 or '<!DOCTYPE' in content.upper() or '<!ENTITY' in content.upper():
        raise RuntimeError('IMAGE_STICKER_METADATA_INVALID')
    try:
        root = ET.fromstring(content)
        emoji = root.find('emoji') if root.tag == 'msg' else None
        attrs = dict(emoji.attrib) if emoji is not None else {}
        if not re.fullmatch(r'[a-fA-F0-9]{32}', attrs.get('md5', '')):
            raise ValueError()
        attrs['md5'] = attrs['md5'].lower()
        return attrs
    except (ET.ParseError, ValueError):
        raise RuntimeError('IMAGE_STICKER_METADATA_INVALID') from None


def trusted_cdn_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 33 for c in value):
        raise RuntimeError('IMAGE_STICKER_CDN_REJECTED')
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ('http', 'https') or url.hostname not in CDN_HOSTS or url.username or url.password or url.port not in (None, 443) or url.fragment:
            raise ValueError()
        return urllib.parse.urlunsplit(('https', url.hostname, url.path, url.query, ''))
    except ValueError:
        raise RuntimeError('IMAGE_STICKER_CDN_REJECTED') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def sticker_download_url(value, allow_alias=False):
    url = trusted_cdn_url(value)
    # Explicitly opt-in: retain TLS verification while mapping only the
    # observed legacy Tencent host to its verified compatibility endpoint.
    if allow_alias and urllib.parse.urlsplit(url).hostname == 'vweixinf.tc.qq.com':
        url = url.replace('https://vweixinf.tc.qq.com/', 'https://wxapp.tc.qq.com/', 1)
    return url


def download_sticker(value, deadline, opener=None):
    url = trusted_cdn_url(value)
    # Ignore proxy environment variables and reject all redirects, including
    # redirects to otherwise trusted hosts. Never expose token-bearing URLs.
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        request = urllib.request.Request(url, headers={'User-Agent': 'WeChatAgent/0.1'})
        with opener.open(request, timeout=min(8, remaining)) as response:
            if response.status != 200:
                raise ValueError()
            size = response.headers.get('Content-Length')
            if size and int(size) > MAX_BYTES:
                raise RuntimeError('IMAGE_STICKER_DOWNLOAD_TOO_LARGE')
            chunks, total = [], 0
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError()
                data = response.read(min(65536, MAX_BYTES + 1 - total))
                if not data:
                    break
                total += len(data)
                if total > MAX_BYTES:
                    raise RuntimeError('IMAGE_STICKER_DOWNLOAD_TOO_LARGE')
                chunks.append(data)
            return b''.join(chunks)
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('IMAGE_STICKER_DOWNLOAD_FAILED') from None


def plain_candidates(raw, aes_hex=''):
    yield raw
    if raw and len(raw) % 16 == 0 and re.fullmatch(r'(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{64})', aes_hex):
        key = bytes.fromhex(aes_hex)
        for iv in (key[:16], bytes(16)):
            decoded = AES.new(key, AES.MODE_CBC, iv).decrypt(raw)
            try:
                yield unpad(decoded, 16)
            except ValueError:
                pass


def decode_wxgf(raw):
    if not raw.startswith(b'wxgf'):
        return raw
    try:
        import imageio_ffmpeg
        executable = imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        raise RuntimeError('IMAGE_STICKER_FFMPEG_UNAVAILABLE') from None
    with tempfile.TemporaryDirectory(prefix='wechatagent-sticker-') as directory:
        base = pathlib.Path(directory)
        source = base / 'input.hevc'
        source.write_bytes(raw[4:])
        result = subprocess.run([executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-threads', '1', '-f', 'hevc', '-i', str(source), '-frames:v', '24',
            '-vf', 'scale=384:384:force_original_aspect_ratio=decrease',
            '-vsync', '0', str(base / 'frame-%02d.png')],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        files = sorted(base.glob('frame-*.png'))
        if result.returncode != 0 or not files:
            raise RuntimeError('IMAGE_STICKER_WXGF_DECODE_FAILED')
        picks = list(dict.fromkeys([files[0], files[len(files)//2], files[-1]]))
        images = []
        for file in picks:
            with Image.open(file) as image:
                images.append(image.convert('RGB'))
        sheet = Image.new('RGB', (sum(i.width for i in images), max(i.height for i in images)), 'white')
        x = 0
        for image in images:
            sheet.paste(image, (x, 0)); x += image.width
        output = io.BytesIO(); sheet.save(output, format='PNG')
        return output.getvalue()


def resolve_sticker_bytes(account, content, allow_cdn=False, allow_cdn_alias=False):
    attrs = emoji_attributes(content)
    md5, key = attrs['md5'], attrs.get('aeskey', '')
    # Platform-specific copies are bound by hashes in the same verified
    # message. A filename alone never authorizes image bytes.
    hashes=list(dict.fromkeys(value.lower() for name in ('md5','externmd5','androidmd5')
        if re.fullmatch(r'[a-fA-F0-9]{32}',value:=attrs.get(name,''))))
    account = pathlib.Path(account).resolve()
    def decode(raw):
        for candidate in plain_candidates(raw, key):
            if hashlib.md5(candidate).hexdigest() not in hashes:
                continue
            return candidate
        return None
    bases = [account / 'business' / 'emoticon' / n for n in ('Persist', 'Thumb', 'Temp')]
    cache = account / 'cache'
    if cache.is_dir():
        bases.extend(p / 'Emoticon' for p in sorted(cache.iterdir(), reverse=True) if re.fullmatch(r'\d{4}-\d{2}', p.name))
    for base in bases:
        for digest in hashes:
            for folder in (base/digest[:2],base):
                for suffix in ('','.gif','.png','.webp','.dat'):
                    file=folder/(digest+suffix)
                    try:
                        if file.resolve().is_relative_to(account) and file.is_file() and file.stat().st_size<=MAX_BYTES:
                            result=decode(file.read_bytes())
                            if result:return result
                    except OSError:
                        continue
    if not allow_cdn:
        raise RuntimeError('IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
    deadline = time.monotonic() + 20
    error = 'IMAGE_STICKER_SOURCE_UNAVAILABLE'
    for name in ('cdnurl', 'encrypturl', 'externurl'):
        if not attrs.get(name):
            continue
        try:
            result = decode(download_sticker(sticker_download_url(attrs[name], allow_cdn_alias), deadline))
            if result:
                return result
            error = 'IMAGE_STICKER_CONTENT_MISMATCH'
        except RuntimeError as failure:
            error = str(failure)
    raise RuntimeError(error)


def resolve_sticker(account, content, normalize, allow_cdn=False, allow_cdn_alias=False):
    raw=resolve_sticker_bytes(account,content,allow_cdn=allow_cdn,allow_cdn_alias=allow_cdn_alias)
    return normalize(decode_wxgf(raw),animated=True)
