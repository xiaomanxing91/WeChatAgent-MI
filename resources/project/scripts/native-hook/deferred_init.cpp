#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <filesystem>
#include <fstream>
#include <mutex>
#include "deferred_init.h"
#include "version_proxy.h"
#include "global.h"
#include "http_server.h"

namespace {
volatile LONG state = 0; // idle, waiting, initializing, ready, failed, cancelled
volatile LONG cancelled = 0;
std::mutex logMutex;
constexpr DWORD waitMs = 30000;
DWORD WINAPI Initialize(LPVOID module) {
    // The entry point runs after DllMain returns. Keep this proxy alive while
    // its worker and HTTP handlers are in use; no join occurs under loader lock.
    HMODULE own = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&ScheduleWeChatAgentInit), &own)) {
        InterlockedExchange(&state, 4); return 0;
    }
    const auto started = GetTickCount64();
    WeChatAgentInitLog("waiting_for_weixin_dll");
    HMODULE core = nullptr;
    while (!InterlockedCompareExchange(&cancelled, 0, 0)) {
        // Acquire a reference as well as checking presence. This call observes
        // the loader's serialization instead of accessing a half-loaded module.
        if (GetModuleHandleExW(0, L"Weixin.dll", &core)) break;
        if (GetTickCount64() - started >= waitMs) {
            InterlockedExchange(&state, 4); WeChatAgentInitLog("module_wait_timeout", waitMs); return 0;
        }
        Sleep(50);
    }
    if (InterlockedCompareExchange(&cancelled, 0, 0)) {
        if (core) FreeLibrary(core);
        InterlockedExchange(&state, 5); return 0;
    }
    WeChatAgentInitLog("weixin_dll_ready", static_cast<DWORD>(GetTickCount64() - started));
    InterlockedExchange(&state, 2);
    try {
        CustomInit(static_cast<HMODULE>(module));
        const bool ready = g_httpServer && g_httpServer->IsRunning();
        InterlockedExchange(&state, ready ? 3 : 4);
        WeChatAgentInitLog(ready ? "initialization_ready" : "initialization_failed", g_StartPort);
    } catch (...) {
        InterlockedExchange(&state, 4); WeChatAgentInitLog("initialization_exception");
    }
    // Core code and offsets remain in use by HTTP handlers for this process.
    // Both module references intentionally live until process termination.
    return 0;
}
}

void ScheduleWeChatAgentInit(HMODULE module) {
    if (InterlockedCompareExchange(&state, 1, 0) != 0) return;
    HANDLE thread = CreateThread(nullptr, 0, Initialize, module, 0, nullptr);
    if (thread) CloseHandle(thread);
    else {
        InterlockedExchange(&state, 4);
        OutputDebugStringA("[WeChatAgent] initialization worker creation failed\n");
    }
}
void CancelWeChatAgentInit() { InterlockedExchange(&cancelled, 1); }
const char* WeChatAgentInitState() {
    switch (InterlockedCompareExchange(&state, 0, 0)) {
    case 0: return "idle"; case 1: return "waiting_for_module";
    case 2: return "initializing"; case 3: return "ready";
    case 5: return "cancelled"; default: return "failed";
    }
}
void WeChatAgentInitLog(const char* stage, unsigned long detail) {
    char line[240]; SYSTEMTIME time{}; GetLocalTime(&time);
    sprintf_s(line, "[WeChatAgent] %04u-%02u-%02u %02u:%02u:%02u pid=%lu stage=%s detail=%lu\n",
        time.wYear,time.wMonth,time.wDay,time.wHour,time.wMinute,time.wSecond,GetCurrentProcessId(),stage,detail);
    OutputDebugStringA(line);
    try {
        HMODULE own = nullptr;
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&WeChatAgentInitLog), &own)) return;
        wchar_t filename[32768];
        const DWORD size = GetModuleFileNameW(own, filename, _countof(filename));
        if (!size || size >= _countof(filename)) return;
        const auto logs = std::filesystem::path(filename).parent_path().parent_path().parent_path() / L"logs";
        std::lock_guard<std::mutex> guard(logMutex);
        std::filesystem::create_directories(logs);
        std::ofstream(logs / L"hook-init.log", std::ios::app | std::ios::binary) << line;
    } catch (...) { /* Debug output remains available if the log is unwritable. */ }
}
