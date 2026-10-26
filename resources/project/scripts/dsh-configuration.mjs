import fs from 'node:fs';
import path from 'node:path';

export function sameProjectPath(left,right){
  if(typeof left!=='string'||!left||typeof right!=='string'||!right)return false;
  try{return fs.realpathSync.native(path.resolve(left))===fs.realpathSync.native(path.resolve(right));}catch{return false;}
}

export function dshConfigurationMatches(root, config, health) {
  if (!health?.ok || health.project !== 'WeChatAgent' || !sameProjectPath(health.projectRoot,root)) return false;
  if (health.provider !== config.dsh.provider || health.model !== config.dsh.model) return false;
  const patch = path.join(root, 'packages/dsh-social-bridge-plugin/cordis.patch.yml');
  const revision = fs.existsSync(patch) ? /wechatagent=([a-f0-9]{16})/.exec(fs.readFileSync(patch, 'utf8'))?.[1] : '';
  if (revision && health.pluginRevision !== revision) return false;
  const accountFile = path.join(root, 'state/weflow/active-account.json');
  if (fs.existsSync(accountFile)) {
    const account = JSON.parse(fs.readFileSync(accountFile, 'utf8').replace(/^\uFEFF/, ''));
    if (account.id && health.accountScope !== account.id) return false;
  }
  return true;
}
