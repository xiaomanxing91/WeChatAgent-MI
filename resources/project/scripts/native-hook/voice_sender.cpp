// 语音发送：直接调用微信自己的 UI 发送入口 0x6199D10。
//
// 逆向结论（4.1.10.27，见 D:/a/_wxre/ANALYSIS.md v5）：
//   UI 录音发送 -> 0x54B02A0 -> 0x6199D10(ctx, out, silk, target, durMs, desc)
//   0x6199D10 内部：
//     0x619A190(out, target, silk, &durMs, desc) -> 建 0x778 消息对象
//     body+0xD8 = 34（语音）；body+0xB0 = 收件人；body+0x708 = SILK 字节
//     body+0x728 = 时长 ms；body+0x730 = {4,3}；body+0x738 = 30000；body+0x748 = ""
//     0x1649B50(service, out, &vector{body,owner}, 1) -> 排队上传发送
//   ctx 入口即被覆盖（未使用），out 为输出缓冲，可传 nullptr。
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdarg>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <string>
#include "global.h"
#include "voice_sender.h"

// 复用与图片/表情完全相同的发送收口（components/WeChat-Hook/src/wx_send.cpp）。
namespace WeixinSend {
    struct InnerStruct2;
    InnerStruct2* BuildSendParam1(uintptr_t);
    void BuildSendParam2_Image(uint64_t*);
}

namespace {
using WeChatAgentVoice::MediaDesc;

// push rbp / push r14 / push rsi / push rdi / push rbx / sub rsp,0xB0
constexpr unsigned char kSendPrologue[13] = {
    0x55, 0x41, 0x56, 0x56, 0x57, 0x53, 0x48, 0x81, 0xEC, 0xB0, 0x00, 0x00, 0x00
};
// push rbp / push r15 / push r14 / push r12 / push rsi / push rdi / push rbx / sub rsp,0x40
constexpr unsigned char kFactoryPrologue[14] = {
    0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x54, 0x56, 0x57, 0x53, 0x48, 0x83, 0xEC, 0x40
};

std::wstring ModulePath(HMODULE module) {
    wchar_t file[32768] = {};
    DWORD size = GetModuleFileNameW(module, file, 32768);
    return size && size < 32768 ? std::wstring(file, size) : L"";
}

void Diag(const char* format, ...) {
    // 诊断日志：state/voice-diag.log
    // 真实 Weixin.dll 在 state/hook/<版本>/<版本>/ 下，上溯 4 层正好是 state。
    std::wstring module = ModulePath(GetModuleHandleW(L"Weixin.dll"));
    if (module.empty()) return;
    std::filesystem::path root = std::filesystem::path(module).parent_path().parent_path()
        .parent_path().parent_path();
    std::filesystem::path log = root / L"voice-diag.log";
    FILE* file = nullptr;
    if (_wfopen_s(&file, log.c_str(), L"a") != 0 || !file) return;
    SYSTEMTIME now{};
    GetLocalTime(&now);
    std::fprintf(file, "[%04u-%02u-%02u %02u:%02u:%02u.%03u] ",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
    va_list args;
    va_start(args, format);
    std::vfprintf(file, format, args);
    va_end(args);
    std::fputc('\n', file);
    std::fclose(file);
}

// 只放 POD 局部量：__try 不能和需要析构的 C++ 对象共存（C2712）。
struct SharedMessage { uintptr_t body, owner; };

// 0x619A190(out, target, silk, &durMs, desc)：真正造 0x778 语音消息对象。
bool InvokeFactory(SharedMessage* message, std::string* target, std::string* silk,
                   uint32_t durationMs, MediaDesc* desc) {
    __try {
        using Factory = SharedMessage* (*)(SharedMessage*, std::string*, std::string*,
                                           uint32_t*, MediaDesc*);
        auto factory = reinterpret_cast<Factory>(
            reinterpret_cast<uintptr_t>(g_hWeixinDll) + WeChatAgentVoice::Factory);
        factory(message, target, silk, &durationMs, desc);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// 与图片/表情发送相同的收口：send_message(param1, param2)。
bool InvokeSend(uintptr_t first, uint64_t* second, long long* rc) {
    __try {
        using Send = __int64 (*)(uintptr_t, uint64_t*);
        auto send = reinterpret_cast<Send>(
            reinterpret_cast<uintptr_t>(g_hWeixinDll) + WeChatAgentVoice::SendMessage);
        *rc = static_cast<long long>(send(first, second));
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}
}

namespace WeChatAgentVoice {

bool Ready() {
    auto module = GetModuleHandleW(L"Weixin.dll");
    if (!module || module != g_hWeixinDll) return false;
    auto base = reinterpret_cast<uintptr_t>(module);
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
    const auto* pe = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    if (pe->Signature != IMAGE_NT_SIGNATURE) return false;
    if (WeChatAgentVoice::SendEntry + sizeof(kSendPrologue) >= pe->OptionalHeader.SizeOfImage) return false;
    if (std::memcmp(reinterpret_cast<const void*>(base + WeChatAgentVoice::SendEntry),
                    kSendPrologue, sizeof(kSendPrologue)) != 0) return false;
    if (std::memcmp(reinterpret_cast<const void*>(base + WeChatAgentVoice::Factory),
                    kFactoryPrologue, sizeof(kFactoryPrologue)) != 0) return false;
    auto owner = *reinterpret_cast<const uintptr_t*>(base + WeChatAgentVoice::OwnerVtable);
    auto body = *reinterpret_cast<const uintptr_t*>(base + WeChatAgentVoice::BodyVtable);
    auto inside = [base, pe](uintptr_t value) {
        return value >= base && value < base + pe->OptionalHeader.SizeOfImage;
    };
    return inside(owner) && inside(body);
}

bool IsSilk(const std::string& bytes) {
    return bytes.size() > 16 && bytes.compare(0, 9, "#!SILK_V3") == 0;
}

uint32_t DurationMs(const std::string& silk) {
    if (!IsSilk(silk)) return 0;
    size_t pos = 9;
    if (pos < silk.size() && static_cast<unsigned char>(silk[pos]) == 0x0A) ++pos;  // 部分封装带换行
    uint32_t frames = 0;
    while (pos + 2 <= silk.size()) {
        auto length = static_cast<uint16_t>(
            static_cast<unsigned char>(silk[pos]) |
            (static_cast<unsigned char>(silk[pos + 1]) << 8));
        if (length == 0 || pos + 2 + length > silk.size()) break;
        pos += 2 + length;
        if (++frames >= 3000) break;  // 60s 上限
    }
    return frames * 20;  // SILK 每帧 20ms（与客户端录音侧 +0x180=20 一致）
}

bool SendVoiceFile(const std::string& target, const std::string& silk,
                   uint32_t durationMs, bool swapArgs, std::string* error) {
    if (!Ready()) {
        if (error) *error = "voice layout unavailable";
        return false;
    }
    if (!IsSilk(silk)) {
        if (error) *error = "not SILK_V3";
        return false;
    }
    uint32_t computed = DurationMs(silk);
    if (computed == 0) {
        if (error) *error = "empty SILK";
        return false;
    }
    // 帧数才是客户端认的时长；外部传入只用于交叉校验。
    uint32_t duration = computed;
    if (durationMs > 0 && (durationMs + 400 < computed || durationMs > computed + 400)) {
        Diag("duration mismatch: caller=%u computed=%u -> using computed", durationMs, computed);
    }
    if (duration > 60000) duration = 60000;

    MediaDesc desc{};
    desc.format = 4;
    desc.kind = 3;
    desc.limit = 30000;
    desc.flag = 0;

    // 诊断开关：交换第 3/4 参，验证 (silk,target) 还是 (target,silk)。
    // 微信的语音载荷在 "#!SILK_V3" 魔数前还有一个 0x02 字节（12:37 真实 UI 录音抓包：
    // c.data = 02 23 21 53 49 4C 4B 5F 56 33 0C 00 …）。标准 SILK 文件没有这个前缀，
    // 直接送进去解码器会把 '#'(0x23) 当成帧长，播出来全是杂音。
    std::string payload = silk;
    if (payload.empty() || static_cast<unsigned char>(payload[0]) != 0x02) {
        payload.insert(payload.begin(), '\x02');
    }
    std::string content = swapArgs ? target : payload;
    std::string recipient = swapArgs ? payload : target;
    SharedMessage message{};
    DWORD started = GetTickCount();
    bool ok = InvokeFactory(&message, &recipient, &content, duration, &desc);
    DWORD elapsed = GetTickCount() - started;
    auto base = reinterpret_cast<uintptr_t>(g_hWeixinDll);
    uintptr_t bodyVt = message.body ? *reinterpret_cast<uintptr_t*>(message.body) : 0;
    uintptr_t ownerVt = message.owner ? *reinterpret_cast<uintptr_t*>(message.owner) : 0;
    Diag("factory ok=%d body=%p owner=%p bodyVt=%p want=%p ownerVt=%p want=%p elapsed=%lu swap=%d",
        ok ? 1 : 0, reinterpret_cast<void*>(message.body), reinterpret_cast<void*>(message.owner),
        reinterpret_cast<void*>(bodyVt), reinterpret_cast<void*>(base + WeChatAgentVoice::BodyVtable),
        reinterpret_cast<void*>(ownerVt), reinterpret_cast<void*>(base + WeChatAgentVoice::OwnerVtable),
        elapsed, swapArgs ? 1 : 0);
    if (!ok || !message.body || !message.owner) {
        if (error) *error = "voice factory failed";
        return false;
    }
    if (bodyVt != base + WeChatAgentVoice::BodyVtable || ownerVt != base + WeChatAgentVoice::OwnerVtable) {
        if (error) *error = "unexpected voice class";
        return false;
    }
    // 类型 34：0x6199D10 内部也是写 body+0xD8 = 0x22。
    *reinterpret_cast<uint32_t*>(message.body + 0xD8) = 0x22;

    auto first = reinterpret_cast<uintptr_t>(WeixinSend::BuildSendParam1(message.owner));
    auto second = static_cast<uint64_t*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0xE8));
    if (!first || !second) {
        if (error) *error = "send param alloc failed";
        return false;
    }
    WeixinSend::BuildSendParam2_Image(second);
    long long rc = 0;
    bool sent = InvokeSend(first, second, &rc);
    Diag("send_message ok=%d rc=%lld target=%s bytes=%zu dur=%u",
        sent ? 1 : 0, rc, target.c_str(), silk.size(), duration);
    if (!sent) {
        if (error) *error = "send_message raised";
        return false;
    }
    return true;
}
}
