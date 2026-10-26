"""Prepare current-chat sends independently from long-term pool admission."""
import base64,hashlib,io,json,re,time,threading
from collections import OrderedDict
from PIL import Image
from wechat_sticker_send import native_gif_bytes,stage_sticker_bytes
from wechat_image_normalize import normalize_image

PREPARED_LIMIT=16
PREPARED_BYTES=32*1024*1024
PREPARED_TTL=600

class MemeSendResources:
    """Short-lived, account/chat-bound bytes; never a second shared library."""
    def __init__(self,pool):
        self.pool=pool;self.items=OrderedDict();self.lock=threading.RLock()

    def allowed(self,key):
        if not self.pool.active() or not meme_import_allowed(self.pool.policy(),key):raise PermissionError('Meme send is not allowed')

    def prune(self):
        now=time.monotonic()
        for image_id,item in list(self.items.items()):
            if item['expires']<=now:del self.items[image_id]
        while self.items and (len(self.items)>PREPARED_LIMIT or sum(len(item['raw']) for item in self.items.values())>PREPARED_BYTES):self.items.popitem(last=False)

    def prepare(self,key,raw):
        self.allowed(key)
        digest=hashlib.sha256(raw).hexdigest();md5=hashlib.md5(raw).hexdigest()
        image_id=hashlib.sha256(('meme-send:'+self.pool.account_key+':'+key+':'+digest).encode()).hexdigest()
        with Image.open(io.BytesIO(raw)) as image:width,height=image.size
        resource={'id':image_id,'conversationKey':key,'sourceMd5':md5,'format':'gif','sha256':digest,
                  'fields':{'md5':md5,'len':len(raw),'type':2,'width':width,'height':height,'productid':''},'origin':'dsh-meme-temporary'}
        with self.lock:
            self.prune();self.allowed(key);self.items.pop(image_id,None)
            self.items[image_id]={'resource':resource,'raw':raw,'expires':time.monotonic()+PREPARED_TTL};self.prune()
            if image_id not in self.items:raise RuntimeError('MEME_SEND_CACHE_FULL')
        return image_id

    def resource(self,image_id,key):
        with self.lock:
            self.prune();item=self.items.get(image_id)
            if not item:return None
            if item['resource']['conversationKey']!=key:raise PermissionError('Meme send conversation mismatch')
            self.allowed(key)
            return stage_sticker_bytes(self.pool.root,item['resource'],item['raw'])

    def preview(self,image_id):
        with self.lock:
            self.prune();item=self.items.get(image_id)
            if not item:return None
            key=item['resource']['conversationKey'];self.resource(image_id,key)
            return {**normalize_image(item['raw'],animated=True),'imageId':image_id,'conversationKey':key}

def send_resources(reader):
    with reader.lock:
        if not hasattr(reader,'meme_send_resources'):reader.meme_send_resources=MemeSendResources(reader.sticker_collection)
        return reader.meme_send_resources

def meme_import_allowed(policy,key):
    match=re.fullmatch(r'wechat:(private|group):([1-9]\d{0,15})',str(key))
    if not match:return False
    allowed=policy.get('whitelist',{}).get('private' if match[1]=='private' else 'groups',[])
    feature=policy.get('memeLibrary',{});stickers=policy.get('stickers',{})
    return match[2] in map(str,allowed) and feature.get('chats',{}).get(key,feature.get('enabled',False)) is True and stickers.get('chats',{}).get(key,stickers.get('enabled',True)) is True

def decode_library_image(reader,body):
    if not isinstance(body,dict) or set(body)-{'conversationKey','b64','description','tags'}:raise ValueError('Invalid meme import')
    key=body.get('conversationKey','');pool=reader.sticker_collection
    if not pool.active() or not meme_import_allowed(pool.policy(),key):raise PermissionError('Meme import is not allowed')
    value=body.get('b64')
    if not isinstance(value,str) or not 0<len(value)<=11200000:raise ValueError('Invalid meme image')
    try:raw=base64.b64decode(value,validate=True)
    except Exception:raise ValueError('Invalid meme image') from None
    if not 0<len(raw)<=8*1024*1024:raise ValueError('Invalid meme image')
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('GIF','PNG','JPEG','WEBP') or not 0<image.width<=4096 or not 0<image.height<=4096:raise ValueError()
            if image.width*image.height*getattr(image,'n_frames',1)>80000000:raise ValueError()
    except Exception:raise ValueError('Unsupported meme image') from None
    return key,raw

def inspect_library_sticker(reader,body):
    key,raw=decode_library_image(reader,body)
    return {**normalize_image(raw,animated=True),'conversationKey':key}

def import_library_sticker(reader,body):
    key,raw=decode_library_image(reader,body);pool=reader.sticker_collection
    from wechat_sticker_labels import clean_label
    label=clean_label({'description':body.get('description'),'tags':body.get('tags')})
    raw=native_gif_bytes(raw);md5=hashlib.md5(raw).hexdigest();digest=hashlib.sha256(raw).hexdigest()
    image_id=send_resources(reader).prepare(key,raw)
    admitted=False;collection='unavailable'
    try:
        admitted=pool.store(raw,{'md5':md5,'len':len(raw)},md5,key,int(time.time()),pool.bound_id(key,digest),external=True)
        collection='saved' if admitted else 'review-pending'
        if not admitted:reader.pump_sticker_pool_review()
    except (RuntimeError,OSError,ValueError):pass
    if not pool.active() or not meme_import_allowed(pool.policy(),key):raise PermissionError('Meme import permission changed')
    try:
        with reader.lock:reader.sticker_labels.save(reader.account.name,[(md5,label)])
    except (RuntimeError,OSError,ValueError):pass
    return {'ready':True,'admitted':admitted,'pending':collection=='review-pending','collection':collection,'id':image_id,'source':'dsh-meme'}
