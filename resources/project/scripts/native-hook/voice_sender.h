#pragma once
#include <cstdint>
#include <string>

// 4.1.10.27 语音发送入口。
// 与贴纸/图片不同，语音不走 send_message(0x1677A30)：UI 的「录音 -> 发送」
// 最终进入 0x6199D10，由它创建 0x778 字节的语音消息对象（body vt 0x8DD0028，
// body+0xD8 = 34），再交给 0x1649B50 排队上传发送。
//
// 实测调用约定（x64，第 5/6 参在栈上）：
//   void* f(void* ctx, void* out, std::string* silk, std::string* target,
//           uint32_t durationMs, VoiceMediaDesc* desc)
// ctx 在函数入口即被覆盖，实际未使用（可传 nullptr）。
// out 是 0x58 字节以上的输出缓冲：+0x00 服务 shared_ptr，+0x38 待发消息 vector。
namespace WeChatAgentMIVoice {
    inline constexpr uintptr_t SendEntry   = 0x6199D10;  // UI 语音发送入口（造消息 + 待发列表）
    inline constexpr uintptr_t Factory     = 0x619A190;  // 语音消息工厂（造 0x778 消息对象）
    inline constexpr uintptr_t SendMessage = 0x1677A30;  // 与图片/表情共用的发送收口
    inline constexpr uintptr_t OwnerVtable = 0x8DCFF98;  // 消息 owner vtable
    inline constexpr uintptr_t BodyVtable  = 0x8DD0028;  // 消息 body vtable

    // 语音描述块（UI 发送时固定为 {4, 3, 30000, 0, ""}）。
    struct MediaDesc {
        uint32_t format;    // +0x00 -> body+0x730 = 4（voiceformat）
        uint32_t kind;      // +0x04 -> body+0x734 = 3
        uint64_t limit;     // +0x08 -> body+0x738 = 30000
        uint8_t  flag;      // +0x10 -> body+0x740 = 0
        std::string extra;  // +0x18 -> body+0x748 = 空串
    };

    // 输出对象：调用后由微信填充，至少 0x58 字节。
    struct SendResult { uint8_t raw[0x80]; };

    bool Ready();                                                    // 版本/特征校验
    bool IsSilk(const std::string& bytes);                           // SILK_V3 magic
    uint32_t DurationMs(const std::string& silk);                    // 帧数 * 20ms
    // swapArgs：诊断用。0x6199D10 的第 3/4 参顺序尚未 100% 确认（silk,target 还是
    // target,silk），置 true 时交换两者，便于一次构建验证两种假设。
    bool SendVoiceFile(const std::string& target, const std::string& silk,
                       uint32_t durationMs, bool swapArgs, std::string* error);
}
