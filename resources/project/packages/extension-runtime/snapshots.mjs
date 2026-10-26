import fs from 'node:fs';
import path from 'node:path';

// Content is read only when file identity/metadata changes. Atomic replacement
// is detected through inode + ctime, even when byte length stays unchanged.
export class PolicySnapshots {
  constructor(root) {this.root=root;this.files=new Map();this.epoch=0;this.reads=0;this.stats=0;this.extensions={};this.wechat={};this.allowed=new Set();}
  signature(file) {
    this.stats++;
    try {const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink())throw Error('CONFIG_FILE_INVALID');return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;}
    catch(error){if(error.code==='ENOENT')return 'missing';throw error;}
  }
  read(relative,fallback,validate,attempt=0) {
    const file=path.join(this.root,relative),signature=this.signature(file),cached=this.files.get(file);
    if(cached?.signature===signature){if(cached.error)throw cached.error;return cached.value;}
    this.epoch++;
    try {
      if(signature!=='missing' && fs.statSync(file).size>1048576)throw Error('CONFIG_TOO_LARGE');
      this.reads++;const value=signature==='missing'?fallback:JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));validate(value);
      const after=this.signature(file);if(after!==signature){if(attempt>=2)throw Error('CONFIG_CHANGED_DURING_READ');return this.read(relative,fallback,validate,attempt+1);}
      this.files.set(file,{signature,value});return value;
    } catch(error){this.files.set(file,{signature,error});throw error;}
  }
  refresh() {
    const old=this.epoch;
    try {
      const extensions=this.read('config/extensions.json',{version:1,extensions:{}},value=>{if(value?.version!==1||!value.extensions||typeof value.extensions!=='object'||Array.isArray(value.extensions))throw Error('EXTENSION_CONFIG_INVALID');});
      const project=this.read('config/wechatagent.json',null,value=>{if(value!==null && (!value||typeof value!=='object'||Array.isArray(value)))throw Error('PROJECT_CONFIG_INVALID');});
      this.extensions=extensions.extensions;this.project=project;this.wechat=project?.wechat ?? {};
      if(old!==this.epoch)this.allowed=new Set(['private','group'].flatMap(kind=>(this.wechat.whitelist?.[kind==='group'?'groups':'private']??[]).map(id=>`wechat:${kind}:${id}`)));
      this.failure=null;
    } catch(error){this.failure=error;this.extensions={};this.wechat={};this.allowed=new Set();}
    return this.epoch;
  }
  permits(key) {return !this.failure && /^wechat:(private|group):[1-9]\d*$/.test(key??'') && this.allowed.has(key);}
}
