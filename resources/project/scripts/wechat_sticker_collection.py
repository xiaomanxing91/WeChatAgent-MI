"""A fifty-item, account-scoped sticker pool with model-reviewed admission."""
import hashlib,io,json,os,pathlib,re,threading,time,uuid
from PIL import Image,ImageDraw
from wechat_image_normalize import normalize_image

MAX_ENTRIES=50
MAX_PENDING=64
MAX_WAITING=8
MAX_FILE=8*1024*1024
HEX=re.compile(r'[a-f0-9]{64}')
CHAT=re.compile(r'wechat:(private|group):([1-9]\d{0,15})')
def valid_md5(value):return isinstance(value,str) and re.fullmatch('[a-f0-9]{32}',value) is not None

class StickerCollection:
    def __init__(self,root,account,own_wxid,active=lambda:True):
        self.root=pathlib.Path(root).resolve();account_path=str(pathlib.Path(account).resolve())
        self.account_key=hashlib.sha256(((account_path.casefold() if os.name=='nt' else account_path)+'|'+own_wxid).encode()).hexdigest()
        self.folder=self.root/'state/stickers/collected'/self.account_key[:32];self.index=self.folder/'index.json'
        self.active=active;self.lock=threading.RLock();self.import_lock=threading.Lock()

    def safe(self,file):
        file=pathlib.Path(file)
        if not file.resolve().is_relative_to(self.root/'state/stickers/collected'):raise RuntimeError('STICKER_COLLECTION_PATH_INVALID')
        for part in [file,*file.parents]:
            if part==self.root:break
            if part.is_symlink():raise RuntimeError('STICKER_COLLECTION_PATH_INVALID')
        return file

    def read(self):
        self.safe(self.index)
        if not self.index.exists():return {'version':2,'account':self.account_key,'entries':{},'waiting':{},'archive':{},'pending':{},'aliases':{},'review':None,'nextReviewAt':0,'lastReview':None}
        if not self.index.is_file() or self.index.stat().st_size>4*1024*1024:raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        state=json.loads(self.index.read_text(encoding='utf-8-sig'))
        if state.get('version') not in (1,2) or state.get('account')!=self.account_key or any(not isinstance(state.get(name),dict) for name in ('entries','pending','aliases')):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        legacy=state['version']==1
        if len(state['entries'])>(512 if legacy else MAX_ENTRIES) or len(state['pending'])>(512 if legacy else MAX_PENDING) or len(state['aliases'])>4096:raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        for collection in [state['entries'],state.get('waiting',{}),state.get('archive',{})]:
            if not isinstance(collection,dict):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
            for digest,item in collection.items():
                fields=item.get('fields') if isinstance(item,dict) else None
                if not HEX.fullmatch(digest) or not isinstance(fields,dict) or not valid_md5(item.get('sourceMd5')) or not valid_md5(fields.get('md5')):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
                if any(type(fields.get(name)) is not int or not 0<fields[name]<=maximum for name,maximum in [('len',MAX_FILE),('width',4096),('height',4096)]):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
                if 'sourceMd5s' in item and (not isinstance(item['sourceMd5s'],list) or len(item['sourceMd5s'])>8 or any(not valid_md5(md5) for md5 in item['sourceMd5s'])):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
                if type(item.get('receivedAt')) is not int or not isinstance(item.get('sources'),dict) or len(item['sources'])>100 or any(not CHAT.fullmatch(key) or type(at) is not int for key,at in item['sources'].items()):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        for image_id,item in state['pending'].items():
            if not HEX.fullmatch(image_id) or not isinstance(item,dict) or not CHAT.fullmatch(str(item.get('key',''))) or not isinstance(item.get('descriptor'),dict) or item['descriptor'].get('localType')!=47:raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
            if type(item.get('attempts',0)) is not int or not 0<=item.get('attempts',0)<=3:raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        for image_id,item in state['aliases'].items():
            if not HEX.fullmatch(image_id) or not isinstance(item,dict) or not HEX.fullmatch(str(item.get('digest',''))) or not CHAT.fullmatch(str(item.get('key',''))):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        removed=state.get('removed',{})
        if not isinstance(removed,dict) or len(removed)>512 or any(not HEX.fullmatch(digest) or type(at) is not int for digest,at in removed.items()):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        if legacy:
            # Preserve the old index and files; excess entries await DS review.
            backup=self.safe(self.folder/'index.v1.bak')
            if not backup.exists():backup.write_bytes(self.index.read_bytes())
            old=state['entries'];active=list(old)[:MAX_ENTRIES]
            state.update(version=2,entries={key:old[key] for key in active},archive={key:item for key,item in old.items() if key not in active},waiting={},review=None,nextReviewAt=0,lastReview=None)
            state['pending']=dict(list(state['pending'].items())[-MAX_PENDING:])
            self.write(state)
        if len(state.get('waiting',{}))>MAX_WAITING or len(state.get('archive',{}))>1024:raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        review=state.get('review')
        if review is not None and (not isinstance(review,dict) or not HEX.fullmatch(str(review.get('ticket',''))) or not HEX.fullmatch(str(review.get('revision',''))) or type(review.get('startedAt')) is not int or not isinstance(review.get('candidates'),list) or len(review['candidates'])>MAX_WAITING or any(not isinstance(digest,str) or not HEX.fullmatch(digest) for digest in review['candidates'])):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        return state

    def write(self,state):
        if len(state['entries'])>MAX_ENTRIES or len(state['waiting'])>MAX_WAITING:raise RuntimeError('STICKER_POOL_LIMIT')
        text=json.dumps(state,ensure_ascii=False)
        if len(text.encode())>4*1024*1024:raise RuntimeError('STICKER_COLLECTION_INDEX_FULL')
        self.safe(self.folder).mkdir(parents=True,exist_ok=True)
        temp=self.index.with_name('index.'+uuid.uuid4().hex[:16]+'.tmp');self.safe(temp).write_text(text,encoding='utf-8');temp.replace(self.index)

    def policy(self):return json.loads((self.root/'config/wechatagent.json').read_text(encoding='utf-8-sig')).get('wechat',{})
    def enabled(self,policy=None):
        settings=(policy or self.policy()).get('stickers',{})
        return settings.get('collectEnabled',settings.get('collectGroups',True)) is True
    def allowed(self,key,policy=None):
        match=CHAT.fullmatch(key) if isinstance(key,str) else None
        if not match or int(match[2])>9007199254740991:return False
        policy=policy if policy is not None else self.policy()
        return match[2] in map(str,policy.get('whitelist',{}).get('private' if match[1]=='private' else 'groups',[]))
    def usable(self,item,policy=None):return item.get('manual') is True or any(self.allowed(key,policy) for key in item.get('sources',{}))
    def can_collect(self,key):return self.active() and self.allowed(key) and self.enabled()
    def revision(self,state):return hashlib.sha256(json.dumps(list(state['entries'])).encode()).hexdigest()

    def remember(self,image_id,descriptor,key):
        if not self.can_collect(key) or not HEX.fullmatch(image_id) or descriptor.get('localType')!=47:return
        with self.lock:
            state=self.read();state['pending'][image_id]={**state['pending'].get(image_id,{}),'key':key,'descriptor':{name:descriptor[name] for name in ('talker','localId','serverId','createTime','localType','dbLocalType','account','sender') if name in descriptor}}
            while len(state['pending'])>MAX_PENDING:state['pending'].pop(next(iter(state['pending'])))
            self.write(state)
    def pending(self):
        with self.lock:
            state=self.read()
            return [] if len(state['entries'])>=MAX_ENTRIES and len(state['waiting'])>=MAX_WAITING else list(state['pending'].items())
    def attempt(self,image_id,policy_key):
        with self.lock:
            state=self.read();item=state['pending'].get(image_id)
            if not item:return False
            if item.get('policy')!=policy_key:item['attempts']=0;item['policy']=policy_key
            if item.get('attempts',0)>=3:return False
            item['attempts']=item.get('attempts',0)+1;self.write(state);return True
    def forget_pending(self,image_id):
        with self.lock:
            state=self.read()
            if image_id in state['pending']:del state['pending'][image_id];self.write(state)

    def store(self,raw,fields,source_md5,key,received_at,image_id,external=False):
        from wechat_meme_library import meme_import_allowed
        can_store=lambda:self.active() and meme_import_allowed(self.policy(),key) if external else self.can_collect(key)
        if not can_store():return False
        if not isinstance(raw,bytes) or not 0<len(raw)<=MAX_FILE or not raw.startswith((b'GIF87a',b'GIF89a')) or not valid_md5(source_md5):raise RuntimeError('STICKER_COLLECTION_RESOURCE_INVALID')
        with Image.open(io.BytesIO(raw)) as image:
            if image.format!='GIF' or not 0<image.width<=4096 or not 0<image.height<=4096:raise RuntimeError('STICKER_COLLECTION_RESOURCE_INVALID')
            width,height=image.size;animated=getattr(image,'n_frames',1)>1
        digest=hashlib.sha256(raw).hexdigest();fields={**fields,'width':width,'height':height,'md5':hashlib.md5(raw).hexdigest(),'len':len(raw)}
        with self.lock:
            state=self.read()
            if digest in state.get('removed',{}):return False
            where='entries' if digest in state['entries'] or len(state['entries'])<MAX_ENTRIES else 'waiting'
            if where=='waiting' and digest not in state['waiting'] and len(state['waiting'])>=MAX_WAITING:return False
            old=state['entries'].get(digest,state['waiting'].get(digest,state['archive'].get(digest,{})))
            item={**{name:old[name] for name in ('manual','name','manualLabel') if name in old},'fields':fields,'sourceMd5':old.get('sourceMd5',source_md5),'sourceMd5s':list(dict.fromkeys([source_md5,*old.get('sourceMd5s',[old.get('sourceMd5',source_md5)])]))[:8],
                  'receivedAt':max(int(received_at),old.get('receivedAt',0)),'sources':dict(sorted({**old.get('sources',{}),key:int(received_at)}.items(),key=lambda pair:pair[1],reverse=True)[:100]),'animated':animated}
            if not can_store():return False
            self.safe(self.folder).mkdir(parents=True,exist_ok=True);file=self.safe(self.folder/(digest+'.gif'))
            if file.exists() and file.read_bytes()!=raw:raise RuntimeError('STICKER_COLLECTION_INTEGRITY_FAILED')
            if not file.exists():
                temp=self.safe(self.folder/('.write-'+uuid.uuid4().hex[:16]+'.tmp'));temp.write_bytes(raw);temp.replace(file)
            state[where][digest]=item
            if where=='entries':state['waiting'].pop(digest,None)
            state['archive'].pop(digest,None);state['pending'].pop(image_id,None);self.write(state)
            return where=='entries'

    def bound_id(self,key,digest):return hashlib.sha256(('group-sticker:'+self.account_key+':'+key+':'+digest).encode()).hexdigest()
    def eligible(self,item,key,policy):
        settings=policy.get('stickers',{});shared=settings.get('shareEnabled',settings.get('shareGroups',True)) is True
        return item.get('manual') is True or key in item.get('sources',{}) or shared and self.usable(item,policy)
    def verified_bytes(self,digest,item):
        if not HEX.fullmatch(digest):raise RuntimeError('STICKER_COLLECTION_INDEX_INVALID')
        file=self.safe(self.folder/(digest+'.gif'));fields=item['fields']
        if not file.is_file() or file.stat().st_size>MAX_FILE:raise RuntimeError('STICKER_COLLECTION_RESOURCE_UNAVAILABLE')
        raw=file.read_bytes()
        if not raw.startswith((b'GIF87a',b'GIF89a')) or hashlib.sha256(raw).hexdigest()!=digest or hashlib.md5(raw).hexdigest()!=fields['md5'] or len(raw)!=fields['len']:raise RuntimeError('STICKER_COLLECTION_INTEGRITY_FAILED')
        return raw
    def resource_from(self,state,digest,key,image_id):
        policy=self.policy();item=state['entries'].get(digest)
        if not self.active() or not self.allowed(key,policy) or not item or not self.eligible(item,key,policy):raise PermissionError('Collected sticker is not authorized')
        if self.bound_id(key,digest)!=image_id:raise PermissionError('Collected sticker target mismatch')
        self.verified_bytes(digest,item)
        return {'id':image_id,'conversationKey':key,'sourceMd5':item['sourceMd5'],'format':'gif','fields':item['fields'],'path':str(self.safe(self.folder/(digest+'.gif'))),'origin':'sticker-pool'}
    def resource(self,image_id,key):
        with self.lock:
            state=self.read()
            for digest in state['entries']:
                if self.bound_id(key,digest)==image_id:return self.resource_from(state,digest,key,image_id)
        return None
    def candidates(self,key,limit=20,rank=lambda item:0):
        if not self.active() or not self.allowed(key):return []
        with self.lock:
            state=self.read();policy=self.policy();result=[]
            ordered=sorted(state['entries'],key=lambda digest:(rank(state['entries'][digest]),key in state['entries'][digest].get('sources',{}),state['entries'][digest]['receivedAt']),reverse=True)
            for digest in ordered:
                item=state['entries'][digest]
                if not self.eligible(item,key,policy):continue
                image_id=self.bound_id(key,digest)
                try:self.resource_from(state,digest,key,image_id)
                except (PermissionError,RuntimeError,OSError):continue
                state['aliases'][image_id]={'digest':digest,'key':key}
                result.append({'id':image_id,'receivedAt':item['receivedAt'],'sourceMd5':item['sourceMd5'],'sourceMd5s':item.get('sourceMd5s',[item['sourceMd5']]),'nativeMd5':item['fields']['md5'],'origin':'sticker-pool',**({'manualLabel':item['manualLabel']} if item.get('manualLabel') else {})})
                if len(result)>=limit:break
            while len(state['aliases'])>4096:state['aliases'].pop(next(iter(state['aliases'])))
            if result:self.write(state)
            return result
    def preview(self,image_id):
        with self.lock:
            state=self.read();alias=state['aliases'].get(image_id)
            if not alias:return None
            resource=self.resource_from(state,alias['digest'],alias['key'],image_id);raw=self.safe(resource['path']).read_bytes()
        result=normalize_image(raw,animated=True);self.resource(image_id,alias['key'])
        return {**result,'imageId':image_id,'conversationKey':alias['key']}

    def status(self):
        with self.lock:
            state=self.read();review=state.get('review')
            return {'limit':MAX_ENTRIES,'count':len(state['entries']),'waiting':len(state['waiting']),'legacyWaiting':len(state['archive']),
                    'review':('reviewing' if review else 'waiting' if state['waiting'] or state['archive'] else 'idle'),'lastReview':state.get('lastReview'),'nextReviewAt':state.get('nextReviewAt',0)}

    def claim_review(self):
        if not self.active() or not self.enabled():return None
        with self.lock:
            state=self.read();now=int(time.time());policy=self.policy()
            if state.get('review') and now-state['review']['startedAt']<150:return None
            if now<state.get('nextReviewAt',0):return None
            # Permission removal releases usable-pool capacity without exposing revoked images.
            for digest,item in list(state['entries'].items()):
                if not self.usable(item,policy):state['archive'][digest]=state['entries'].pop(digest)
            chosen=[digest for digest,item in state['waiting'].items() if self.usable(item,policy)][:MAX_WAITING]
            if not chosen:chosen=[digest for digest,item in state['archive'].items() if self.usable(item,policy)][:MAX_WAITING]
            if not chosen:self.write(state);return None
            review={'ticket':uuid.uuid4().hex+uuid.uuid4().hex,'revision':self.revision(state),'candidates':chosen,'startedAt':now}
            state['review']=review;state['nextReviewAt']=now+60;self.write(state);return review

    def review_packet(self,ticket,label_for=lambda item:None,usage=None):
        with self.lock:
            state=self.read();review=state.get('review');policy=self.policy()
            if not self.active() or not self.enabled() or not review or review['ticket']!=ticket or review['revision']!=self.revision(state):raise PermissionError('Sticker review expired')
            rows=[(digest,item,False) for digest,item in state['entries'].items()]
            for digest in review['candidates']:
                item=state['waiting'].get(digest,state['archive'].get(digest))
                if not item:raise PermissionError('Sticker review expired')
                rows.append((digest,item,True))
            if any(not self.usable(item,policy) for _,item,_ in rows):raise PermissionError('Sticker review source revoked')
            canvas=Image.new('RGB',(8*144,((len(rows)+7)//8)*144),'white');draw=ImageDraw.Draw(canvas);metadata=[]
            for index,(digest,item,new) in enumerate(rows):
                raw=self.verified_bytes(digest,item)
                with Image.open(io.BytesIO(raw)) as image:
                    frame=image.convert('RGBA');frame.thumbnail((132,114));x=(index%8)*144+6;y=(index//8)*144+24
                    canvas.paste(frame,(x,y),frame)
                slot='N'+str(review['candidates'].index(digest)+1) if new else 'P'+str(index+1)
                draw.text(((index%8)*144+6,(index//8)*144+4),slot+(' GIF' if item.get('animated') else ''),fill='black')
                label=label_for(item) or {};stats=(usage or {}).get(digest,{})
                metadata.append({'slot':slot,'new':new,'description':label.get('description','未识别内容'),'tags':label.get('tags',[]),'uses':stats.get('uses',0),'lastUsedAt':stats.get('lastUsedAt',0)})
            output=io.BytesIO();canvas.save(output,format='JPEG',quality=85)
            preview=normalize_image(output.getvalue())
            return {'ticket':ticket,'revision':review['revision'],'limit':MAX_ENTRIES,'requiredCount':min(MAX_ENTRIES,len(rows)),'items':metadata,'preview':preview}

    def apply_review(self,ticket,keep,reason=''):
        with self.lock:
            state=self.read();review=state.get('review');policy=self.policy()
            if not self.active() or not self.enabled() or not review or review['ticket']!=ticket or review['revision']!=self.revision(state):raise PermissionError('Sticker review expired')
            mapping={'P'+str(i+1):digest for i,digest in enumerate(state['entries'])}
            mapping.update({'N'+str(i+1):digest for i,digest in enumerate(review['candidates'])})
            if not isinstance(keep,list) or len(keep)!=min(MAX_ENTRIES,len(mapping)) or any(not isinstance(slot,str) or slot not in mapping for slot in keep) or len(set(keep))!=len(keep):raise ValueError('Invalid sticker selection')
            items={**state['entries'],**state['waiting'],**state['archive']}
            if any(not self.usable(items[mapping[slot]],policy) for slot in keep):raise PermissionError('Sticker review source revoked')
            selected={mapping[slot]:items[mapping[slot]] for slot in keep};replaced=set(state['entries'])-set(selected)
            considered=set(review['candidates']);new=set(selected)-set(state['entries'])
            state['entries']=selected
            for digest in considered:state['waiting'].pop(digest,None);state['archive'].pop(digest,None)
            state['aliases']={alias:item for alias,item in state['aliases'].items() if item['digest'] in selected}
            state['review']=None;state['lastReview']={'status':'selected','added':len(new),'removed':len(replaced),'at':int(time.time()),'reason':str(reason)[:240]};self.write(state)
            for digest in (replaced|considered)-set(selected):
                if digest not in state['waiting'] and digest not in state['archive']:self.safe(self.folder/(digest+'.gif')).unlink(missing_ok=True)
            return state['lastReview']

    def review_failed(self,ticket):
        with self.lock:
            state=self.read();review=state.get('review')
            if review and review['ticket']==ticket:
                state['review']=None;state['nextReviewAt']=int(time.time())+300;state['lastReview']={'status':'waiting_retry','at':int(time.time())};self.write(state)
