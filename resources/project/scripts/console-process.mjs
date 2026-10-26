import { spawn } from 'node:child_process';
import path from 'node:path';

export function windowsPowerShellEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'psmodulepath') delete result[key];
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const modules = [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')];
  if (env.ProgramFiles) modules.push(path.win32.join(env.ProgramFiles, 'WindowsPowerShell', 'Modules'));
  result.PSModulePath = modules.join(';');
  return result;
}

export function windowsPowerShellExecutable(env = process.env) {
  return path.win32.join(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// A persistent service started by PowerShell can inherit a pipe handle even
// after the launcher exits. Its pipes must not define the task's lifetime.
export function runConsoleCommand(spec, onOutput, { cwd, env = process.env, timeoutMs = 180000, drainMs = 150 } = {}) {
  return new Promise(resolve => {
    const processEnv = /(?:^|[\\/])powershell\.exe$/i.test(spec.exe) ? windowsPowerShellEnvironment(env) : env;
    const child = spawn(spec.exe, spec.args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...processEnv, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } });
    let done = false, drainTimer;
    const finish = code => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(drainTimer);
      child.stdout?.destroy(); child.stderr?.destroy(); resolve(code);
    };
    const deadline = setTimeout(() => {
      onOutput('\n操作等待超时，请查看连接检查与运行日志后重试。\n');
      child.kill(); finish(124);
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
    child.once('error', error => { onOutput(error.message); finish(1); });
    child.once('exit', code => {
      clearTimeout(deadline);
      // Let queued output drain, with a bound independent of descendants.
      drainTimer = setTimeout(() => finish(code ?? 1), drainMs);
    });
    child.once('close', code => finish(code ?? 1));
  });
}

export function taskFailureMessage(output, code) {
  if (/READER_PORT_UNAVAILABLE/.test(output)) return '读取服务端口已被占用或被 Windows 拒绝。请在连接设置中修改微信读取端口，再启动服务；端口可能被未监听的其他程序占用。';
  if (/port is used by another installation|port is already in use|EADDRINUSE|address already in use/i.test(output)) return '配置端口已被占用。点击“检查占用进程”，核对程序后可选择停止，再重试。';
  if (/Another desktop WeChat is running|WECHAT_MULTIPLE/i.test(output)) return '检测到其他微信客户端。点击“检查占用进程”，确认并停止对应微信后，再打开匹配微信。';
  if (/HOOK_INITIALIZATION_TIMEOUT|HOOK_NOT_LISTENING/.test(output)) return '微信发送组件未能完成初始化。请使用“打开微信”启动匹配客户端；查看 hook-init.log，确认模块等待是否超时或端口绑定失败。';
  if (/HOOK_HEALTH_TIMEOUT/.test(output)) return '微信发送组件响应超时，请稍后重试；持续失败时查看 hook-init.log。';
  if (/HOOK_HEALTH_INVALID_RESPONSE/.test(output)) return '微信发送端口返回了无效响应，可能被其他程序占用；请检查 hook-init.log 和发送端口。';
  if (/ACCOUNT_SWITCH_REQUIRES_DSH_RESTART/.test(output)) return '账号已切换。请从 DSH 托盘完整退出并重新打开，再启动助手服务。';
  if (code === 124) return '操作等待超时。请查看连接检查与日志，确认当前服务状态后重试。';
  if (/ModuleNotFoundError|ImportError|DLL load failed|需要 sqlcipher3/i.test(output)) return '读取组件缺失或无法加载。请重新安装更新后的安装包，然后在首次配置中点击“验证内置环境”。';
  if (/Selected account database directory is unavailable/i.test(output)) return '找不到所选账号的数据库目录。请在首次配置中自动查找账号，或重新选择包含 db_storage 的账号文件夹。';
  if (/Selected account database credential verification failed/i.test(output)) return '密钥与当前账号数据库不匹配。请在首次配置中点击“一键连接并验证”重新获取。';
  if (/Windows current-user credential decryption failed|Legacy secret requires/i.test(output)) return '已有凭据无法在当前电脑或 Windows 用户下读取。请在首次配置中点击“一键连接并验证”重新获取。';
  if (/Contact database could not be read|One or more message shards could not be read/i.test(output)) return '微信数据库尚未完整同步或暂时无法读取。请在微信打开几个聊天，等待同步后重新连接并验证。';
  if (/Reader initialization failed: (?:KeyError|FileNotFoundError)/i.test(output)) return '数据库读取设置尚未完成。请在首次配置中选择账号并点击“一键连接并验证”。';
  if (/reader exited/i.test(output)) return '数据库读取器未能启动。请在首次配置中重新连接并验证微信；下方会显示读取器的具体错误。';
  if (/HOOK_COMPONENT_UPDATE_PENDING/.test(output)) return '发送组件已更新。请从匹配微信的托盘菜单完整退出，再点击“打开微信”应用更新。';
  if (/CouldNotAutoloadMatchingModule|Microsoft\.PowerShell\.Security.*module|Get-AuthenticodeSignature.*ObjectNotFound/is.test(output)) return 'Windows PowerShell 安全模块未能加载。请退出应用后重新打开更新后的 WeChatAgent.exe。';
  if (/WECHAT_LAUNCH_EXITED/i.test(output)) return '微信启动后已退出。若微信提示必须升级，当前固定版本的发送组件需要重新适配；请保留完整微信提示。';
  if (/WeChat-Hook is not ready|BACKEND_UNAVAILABLE|Matching WeChat client missing/i.test(output)) return '匹配微信尚未就绪。点击“打开微信”，登录配置的账号后再启动。';
  if (/HOOK_VERSION_MISMATCH|Client version mismatch/i.test(output)) return '微信版本与发送组件不匹配，请在连接设置中选择匹配的微信程序。';
  if (/HOOK_ACCOUNT_NOT_READY/i.test(output)) return '微信登录账号与数据库账号不一致，请登录读取设置对应的账号。';
  if (/Install the DSH plugin|Fully.*reopen DSH|ECONNREFUSED.*11230/i.test(output)) return 'DSH 插件尚未就绪。打开 DSH，启用本项目插件并完整重开后再启动。';
  if (/Invalid project configuration|configuration.*failed/i.test(output)) return '项目配置无效，请检查连接设置与人格文件。';
  return '操作未完成，请查看下方详细信息，修正配置后重试。';
}
