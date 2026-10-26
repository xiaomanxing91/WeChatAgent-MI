"""Extract only cached-native forwarding fields from a bound sticker message."""
import re
import io
import hashlib
import pathlib
import uuid
import xml.etree.ElementTree as ET
from PIL import Image
from wechat_sticker import emoji_attributes

APPMSG_STICKER_TYPE = 8 * 2**32 + 49


def stage_sticker_resource(root,resource):
    """Prepare a verified pool GIF for the native sender's strict path guard."""
    root=pathlib.Path(root).resolve()
    scope=(root/'state/stickers').resolve()
    source=pathlib.Path(resource['path']).resolve()
    fields=resource.get('fields',{});md5=fields.get('md5','')
    if not scope.is_relative_to(root) or not source.is_relative_to(scope) or resource.get('format')!='gif' or not re.fullmatch('[a-f0-9]{32}',md5):
        raise RuntimeError('STICKER_CACHE_PATH_INVALID')
    if not source.is_file() or not 0<source.stat().st_size<=8*1024*1024:
        raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
    with source.open('rb') as stream:raw=stream.read(8*1024*1024+1)
    if not raw.startswith((b'GIF87a',b'GIF89a')) or hashlib.md5(raw).hexdigest()!=md5 or type(fields.get('len')) is not int or len(raw)!=fields['len']:
        raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
    return stage_sticker_bytes(root,resource,raw)


def stage_sticker_bytes(root,resource,raw):
    """Stage validated short-lived material with the same native path guard."""
    root=pathlib.Path(root).resolve();scope=(root/'state/stickers').resolve()
    fields=resource.get('fields',{});md5=fields.get('md5','')
    if not scope.is_relative_to(root) or resource.get('format')!='gif' or not re.fullmatch('[a-f0-9]{32}',md5):
        raise RuntimeError('STICKER_CACHE_PATH_INVALID')
    if not isinstance(raw,bytes) or not 0<len(raw)<=8*1024*1024 or not raw.startswith((b'GIF87a',b'GIF89a')) or hashlib.md5(raw).hexdigest()!=md5 or type(fields.get('len')) is not int or len(raw)!=fields['len']:
        raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
    if 'sha256' in resource and hashlib.sha256(raw).hexdigest()!=resource['sha256']:
        raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
    folder=root/'state/stickers/outgoing'
    if folder.is_symlink() or not folder.resolve().is_relative_to(scope):
        raise RuntimeError('STICKER_CACHE_PATH_INVALID')
    folder.mkdir(parents=True,exist_ok=True)
    file=folder/(md5+'.gif')
    if file.is_symlink():raise RuntimeError('STICKER_CACHE_PATH_INVALID')
    if file.exists():
        if file.stat().st_size!=len(raw) or file.read_bytes()!=raw:raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
    else:
        temp=folder/(md5+'.'+uuid.uuid4().hex+'.tmp')
        try:
            temp.write_bytes(raw);temp.replace(file)
        finally:
            if temp.exists():temp.unlink()
    return {**resource,'path':str(file.resolve())}


def native_gif_bytes(raw):
    # Keep every frame of received GIFs byte-for-byte. Static image stickers
    # need GIF encoding for the current native appmsg-8 upload path.
    if raw.startswith((b'GIF87a',b'GIF89a')):return raw
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('JPEG','PNG','WEBP'):
                raise RuntimeError('STICKER_NATIVE_FORMAT_UNSUPPORTED')
            if not 0<image.width<=4096 or not 0<image.height<=4096:
                raise RuntimeError('STICKER_NATIVE_IMAGE_TOO_LARGE')
            count=getattr(image,'n_frames',1)
            if count>64 or count*image.width*image.height>80_000_000:
                raise RuntimeError('STICKER_NATIVE_IMAGE_TOO_LARGE')
            frames=[];durations=[]
            for index in range(count):
                image.seek(index);frames.append(image.convert('RGBA'));durations.append(max(20,min(10000,int(image.info.get('duration',100)))))
            output=io.BytesIO()
            frames[0].save(output,format='GIF',save_all=count>1,append_images=frames[1:],duration=durations if count>1 else durations[0],loop=image.info.get('loop',0))
            result=output.getvalue()
            if not result or len(result)>8*1024*1024:raise RuntimeError('STICKER_NATIVE_IMAGE_TOO_LARGE')
            return result
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('STICKER_NATIVE_FORMAT_UNSUPPORTED') from None


def sticker_receipt_md5(local_type, xml):
    """Recognize native emoji-47 and appmsg-8, never an arbitrary attachment."""
    if local_type == 47:
        try:
            return emoji_attributes(xml)['md5']
        except RuntimeError:
            return None
    if local_type not in (49, APPMSG_STICKER_TYPE) or not xml or len(xml)>100_000 or '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
        return None
    try:
        root=ET.fromstring(xml)
        app=root.find('appmsg') if root.tag=='msg' else root if root.tag=='appmsg' else None
        if app is None or app.findtext('type')!='8':return None
        md5=app.findtext('appattach/emoticonmd5','')
        return md5.lower() if re.fullmatch(r'[a-fA-F0-9]{32}',md5) else None
    except ET.ParseError:
        return None


def sticker_send_fields(xml):
    attrs = emoji_attributes(xml)
    product = attrs.get('productid', '')
    if not re.fullmatch(r'[A-Za-z0-9._-]{0,128}', product):
        raise RuntimeError('STICKER_PRODUCT_INVALID')
    result = {'md5': attrs['md5'], 'productid': product}
    for key, maximum in [('len', 8*1024*1024), ('type', 5), ('width', 4096), ('height', 4096)]:
        raw = attrs.get(key, '0')
        if not re.fullmatch(r'\d{1,10}', raw) or int(raw)>maximum:
            raise RuntimeError('STICKER_METADATA_INVALID')
        result[key] = int(raw)
    return result
