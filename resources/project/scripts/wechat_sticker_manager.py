"""Local, account-bound administration of the shared sticker pool. No network/model calls."""
import base64,binascii,hashlib,io,json,pathlib,re,time,uuid
from PIL import Image
from wechat_sticker_collection import HEX,MAX_ENTRIES,MAX_FILE
from wechat_sticker_labels import clean_label
from wechat_sticker_send import native_gif_bytes

class ManagerError(Exception):
    def __init__(self,code,status=400):self.code=code;self.status=status;super().__init__(code)

class StickerManager:
    def __init__(self,pool):self.pool=pool
    def active(self):
        if not self.pool.active():raise ManagerError('STICKER_MANAGER_ACCOUNT_CHANGED',409)
    def revision(self,state):
        data={name:state.get(name,{}) for name in ('entries','waiting','archive','removed')}
        return hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    def check(self,body,state):
        self.active()
        if not isinstance(body,dict) or body.get('scope')!=self.pool.account_key:raise ManagerError('STICKER_MANAGER_ACCOUNT_CHANGED',409)
        if body.get('revision')!=self.revision(state):raise ManagerError('STICKER_MANAGER_CHANGED',409)
    def label(self,item):
        try:return clean_label(item.get('manualLabel',{}))
        except ValueError:return {'description':'','tags':[]}
    def listing(self):
        self.active()
        with self.pool.lock:
            state=self.pool.read();items=[]
            for digest,item in reversed(list(state['entries'].items())):
                label=self.label(item)
                items.append({'id':digest,'name':item.get('name') or label['description'] or '聊天收集的表情 '+digest[:6],**label,
                              'manual':item.get('manual') is True,'animated':item.get('animated',False),'bytes':item['fields']['len'],
                              'width':item['fields']['width'],'height':item['fields']['height'],'addedAt':item['receivedAt']})
            self.active()
            return {'scope':self.pool.account_key,'revision':self.revision(state),'limit':MAX_ENTRIES,'count':len(items),
                    'waiting':len(state.get('waiting',{}))+len(state.get('archive',{})),'items':items}
    def image(self,digest,scope,animated=False):
        self.active()
        if scope!=self.pool.account_key:raise ManagerError('STICKER_MANAGER_ACCOUNT_CHANGED',409)
        if not isinstance(digest,str) or not HEX.fullmatch(digest):raise ManagerError('STICKER_MANAGER_INVALID')
        with self.pool.lock:
            item=self.pool.read()['entries'].get(digest)
            if not item:raise ManagerError('STICKER_MANAGER_NOT_FOUND',404)
            raw=self.pool.verified_bytes(digest,item)
        if animated:mime='image/gif'
        else:
            with Image.open(io.BytesIO(raw)) as image:
                image.thumbnail((160,160));frame=image.convert('RGBA');out=io.BytesIO();frame.save(out,format='PNG');raw=out.getvalue()
            mime='image/png'
        self.active()
        return {'mime':mime,'base64':base64.b64encode(raw).decode()}
    def metadata(self,body):
        name=body.get('name')
        if not isinstance(name,str) or not name.strip() or len(name)>120 or re.search(r'[\x00-\x1f/\\]',name):raise ManagerError('STICKER_MANAGER_INVALID')
        try:label=clean_label({'description':body.get('description') or name,'tags':body.get('tags',[])})
        except ValueError:raise ManagerError('STICKER_MANAGER_INVALID') from None
        return name.strip(),label
    def import_image(self,body):
        with self.pool.lock:self.check(body,self.pool.read())
        if not self.pool.import_lock.acquire(blocking=False):raise ManagerError('STICKER_MANAGER_BUSY',409)
        try:
            name,label=self.metadata(body);encoded=body.get('base64')
            if not isinstance(encoded,str) or not 0<len(encoded)<=((MAX_FILE+2)//3)*4:raise ManagerError('STICKER_MANAGER_TOO_LARGE',413)
            try:raw=base64.b64decode(encoded,validate=True)
            except (ValueError,binascii.Error):raise ManagerError('STICKER_MANAGER_INVALID_IMAGE') from None
            if not 0<len(raw)<=MAX_FILE:raise ManagerError('STICKER_MANAGER_TOO_LARGE',413)
            try:
                with Image.open(io.BytesIO(raw)) as image:
                    count=getattr(image,'n_frames',1)
                    if image.format not in ('GIF','PNG','JPEG','WEBP') or not 0<image.width<=4096 or not 0<image.height<=4096 or count>64 or count*image.width*image.height>80_000_000:raise ValueError()
                    width,height=image.size
                    for index in range(count):image.seek(index);image.load()
                raw=native_gif_bytes(raw)
                with Image.open(io.BytesIO(raw)) as image:animated=getattr(image,'n_frames',1)>1
            except Exception:raise ManagerError('STICKER_MANAGER_INVALID_IMAGE') from None
            digest=hashlib.sha256(raw).hexdigest();md5=hashlib.md5(raw).hexdigest()
            with self.pool.lock:
                state=self.pool.read();self.check(body,state)
                if digest not in state['entries'] and len(state['entries'])>=MAX_ENTRIES:raise ManagerError('STICKER_MANAGER_FULL',409)
                old=state['entries'].get(digest,state.get('waiting',{}).get(digest,state.get('archive',{}).get(digest,{})))
                item={**old,'fields':{'md5':md5,'len':len(raw),'width':width,'height':height,'type':2,'productid':''},
                      'sourceMd5':old.get('sourceMd5',md5),'receivedAt':int(time.time()),'sources':old.get('sources',{}),
                      'animated':animated,'manual':True,'name':name,'manualLabel':label}
                self.pool.safe(self.pool.folder).mkdir(parents=True,exist_ok=True);file=self.pool.safe(self.pool.folder/(digest+'.gif'))
                if file.exists() and file.read_bytes()!=raw:raise ManagerError('STICKER_MANAGER_INTEGRITY',409)
                temp=self.pool.safe(self.pool.folder/('.manual-'+uuid.uuid4().hex+'.tmp'))
                try:
                    if not file.exists():temp.write_bytes(raw);temp.replace(file)
                    state['entries'][digest]=item;state.get('removed',{}).pop(digest,None)
                    state.get('waiting',{}).pop(digest,None);state.get('archive',{}).pop(digest,None)
                    state['review']=None;self.pool.write(state)
                finally:temp.unlink(missing_ok=True)
            return self.listing()
        finally:self.pool.import_lock.release()
    def change(self,body,remove=False):
        with self.pool.lock:
            state=self.pool.read();self.check(body,state);digest=body.get('id')
            if not isinstance(digest,str) or not HEX.fullmatch(digest):raise ManagerError('STICKER_MANAGER_INVALID')
            item=state['entries'].get(digest)
            if not item:raise ManagerError('STICKER_MANAGER_NOT_FOUND',404)
            if remove:
                for section in ('entries','waiting','archive'):state.get(section,{}).pop(digest,None)
                state['aliases']={key:value for key,value in state['aliases'].items() if value['digest']!=digest}
                removed=state.setdefault('removed',{});removed.pop(digest,None);removed[digest]=int(time.time())
                while len(removed)>512:removed.pop(next(iter(removed)))
            else:
                name,label=self.metadata(body);item.update(name=name,manualLabel=label)
            state['review']=None;self.pool.write(state)
            if remove:self.pool.safe(self.pool.folder/(digest+'.gif')).unlink(missing_ok=True)
        return self.listing()
