// Outer integration endpoints; the upstream send implementation is unchanged.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <vector>
#include <regex>
#include <sstream>
#include <bcrypt.h>
#include <cstring>
#pragma comment(lib,"bcrypt.lib")
#include "httplib.h"
#include "json.hpp"
#include "wx_send.h"
#include "sticker_sender.h"
#include "voice_sender.h"
#include "global.h"
#include "wechatagent_hook.h"
#include "deferred_init.h"

using json = nlohmann::json;
static std::timed_mutex sendMutex;

static bool StickerReady() {
    auto module=GetModuleHandleW(L"Weixin.dll");
    if(!module)return false;
    auto base=reinterpret_cast<uintptr_t>(module);
    const auto* dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    const auto* pe=reinterpret_cast<const IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    auto inCode=[base,pe](uintptr_t address){
        if(address<base || address>=base+pe->OptionalHeader.SizeOfImage)return false;
        MEMORY_BASIC_INFORMATION info{};
        if(!VirtualQuery(reinterpret_cast<void*>(address),&info,sizeof(info)) || info.State!=MEM_COMMIT)return false;
        return (info.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY))!=0;
    };
    if(!inCode(base+offset::send_message) || !inCode(base+offset::create_param2) ||
      !inCode(base+WeChatAgentMISticker::EmojiFactory))return false;
    const uintptr_t tables[]={WeChatAgentMISticker::EmojiOwnerVtable,WeChatAgentMISticker::EmojiVtable,offset::param1_vtable,
      offset::param2_1,offset::param2_2,offset::param2_3};
    for(auto offset:tables){
        if(offset+sizeof(uintptr_t)>pe->OptionalHeader.SizeOfImage)return false;
        MEMORY_BASIC_INFORMATION info{};
        if(!VirtualQuery(reinterpret_cast<void*>(base+offset),&info,sizeof(info)) || info.State!=MEM_COMMIT ||
          (info.Protect&(PAGE_NOACCESS|PAGE_GUARD)))return false;
        if(!inCode(*reinterpret_cast<const uintptr_t*>(base+offset)))return false;
    }
    return true;
}

static bool ForwardSticker(const std::string& target,const std::string& path) {
    __try { return WeixinSend::SendStickerFile(target,path); }
    __except(EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// Image messages must be built by WeChat's own constructor. The upstream
// sender hand-fills a raw buffer, which leaves nested vtables empty and makes
// the client store the result as a file message. FileFactory (0x1C4CE70)
// allocates 0x7A8 bytes, installs the image vtable and runs the real body
// constructor; we only fill the receiver/path/type fields afterwards.
namespace WeChatAgentMIImage {
inline constexpr uintptr_t FileFactory = 0x1C4CE70;

struct UnknownBlock { uint64_t vtable; uint64_t temp[6]; uint64_t self; };
struct InnerStruct1 { void* ptr1; void* ptr2; void* ptr3; uint64_t count; };
struct InnerStruct2 { void* vtable; void* ptr1; uint64_t data1; uint64_t data2; uint64_t field1; };

inline uint64_t Capacity(uint64_t length) { return (((length + 1) + 0xF) & ~0xFULL) - 1; }

static void SetString(void* dst, const std::string& value) {
    memset(dst, 0, 0x20);
    const uint64_t length = value.size();
    if (length < 16) {
        memcpy(dst, value.data(), length);
        *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x10) = length;
        *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x18) = 0xF;
        return;
    }
    char* heap = static_cast<char*>(HeapAlloc(GetProcessHeap(), 0, length + 1));
    if (!heap) return;
    memcpy(heap, value.data(), length); heap[length] = 0;
    *reinterpret_cast<char**>(dst) = heap;
    *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x10) = length;
    *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x18) = Capacity(length);
}

static uint64_t SetStringU(void* dst, const std::string& value) {
    memset(dst, 0, 0x20);
    const int count = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (count <= 0) return 0;
    if (count < 8) {
        MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), static_cast<wchar_t*>(dst), count);
        *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x10) = count;
        *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x18) = 0xF;
        return count;
    }
    wchar_t* heap = static_cast<wchar_t*>(HeapAlloc(GetProcessHeap(), 0, (count + 1) * sizeof(wchar_t)));
    if (!heap) return 0;
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), heap, count);
    heap[count] = 0;
    *reinterpret_cast<wchar_t**>(dst) = heap;
    *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x10) = count;
    *reinterpret_cast<uint64_t*>(static_cast<char*>(dst) + 0x18) = Capacity(count);
    return count;
}

static std::string NewGuid() {
    unsigned char bytes[16]{};
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return std::string();
    bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0F) | 0x40);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3F) | 0x80);
    char text[40]{};
    sprintf_s(text, "{%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
    return text;
}

static InnerStruct2* BuildParam1(uint64_t owner) {
    auto module = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    auto first = static_cast<InnerStruct1*>(HeapAlloc(GetProcessHeap(), 8, 0x20));
    if (!first) return nullptr;
    first->ptr1 = reinterpret_cast<void*>(owner + 0x10);
    first->ptr2 = reinterpret_cast<void*>(owner);
    first->ptr3 = nullptr;
    first->count = 0;
    auto second = static_cast<InnerStruct2*>(HeapAlloc(GetProcessHeap(), 8, 0x28));
    if (!second) return nullptr;
    second->vtable = reinterpret_cast<void*>(module + offset::param1_vtable);
    second->ptr1 = first;
    second->data1 = reinterpret_cast<uint64_t>(first) + 0x10;
    second->data2 = reinterpret_cast<uint64_t>(first) + 0x10;
    second->field1 = 1;
    return second;
}

static void BuildParam2Image(uint64_t* out) {
    auto module = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    const uint64_t globalValue = *reinterpret_cast<uint64_t*>(module + offset::param2);
    using Create = __int64(*)(uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t);
    auto create = reinterpret_cast<Create>(module + offset::create_param2);
    auto buffer = static_cast<uint64_t*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0x10));
    auto make = [module](uintptr_t vtable) {
        auto block = static_cast<UnknownBlock*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 64));
        if (block) { block->vtable = module + vtable; block->self = reinterpret_cast<uint64_t>(block); }
        return block;
    };
    auto p2 = make(offset::param2_1);
    auto p3 = make(offset::param2_2);
    auto p4 = make(offset::param2_3);
    if (!buffer || !p2 || !p3 || !p4) return;
    create(reinterpret_cast<uint64_t>(out), reinterpret_cast<uint64_t>(p2), reinterpret_cast<uint64_t>(p3),
        reinterpret_cast<uint64_t>(p4), reinterpret_cast<uint64_t>(buffer), globalValue);
}

static bool Send(const std::string& target, const std::string& path) {
    auto module = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    if (!module) return false;
    struct SharedMessage { uintptr_t body, owner; };
    SharedMessage message{};
    using Factory = SharedMessage*(*)(SharedMessage*);
    reinterpret_cast<Factory>(module + FileFactory)(&message);
    if (!message.body || !message.owner) return false;
    const uint64_t owner = message.owner;
    // Same field layout the previous sender used, but on a constructed body:
    // receiver 0xC0, type 0xE8, path 0xF0, size 0x198, uuid 0x6B8 (owner based).
    SetString(reinterpret_cast<void*>(owner + 0xC0), target);
    *reinterpret_cast<uint64_t*>(owner + 0xD0) = target.size();
    *reinterpret_cast<uint64_t*>(owner + 0xD8) = Capacity(target.size());
    *reinterpret_cast<uint64_t*>(owner + 0xE8) = 3;   // png image
    const uint64_t pathLength = SetStringU(reinterpret_cast<void*>(owner + 0xF0), path);
    if (!pathLength) return false;
    *reinterpret_cast<uint64_t*>(owner + 0x100) = pathLength;
    *reinterpret_cast<uint64_t*>(owner + 0x108) = Capacity(pathLength);
    *reinterpret_cast<uint64_t*>(owner + 0x198) = std::filesystem::file_size(std::filesystem::path(path));
    const std::string guid = NewGuid();
    if (guid.size() == 36) {
        SetString(reinterpret_cast<void*>(owner + 0x6B8), guid);
        *reinterpret_cast<uint64_t*>(owner + 0x6C8) = guid.size();
        *reinterpret_cast<uint64_t*>(owner + 0x6D0) = Capacity(guid.size());
    }
    auto first = BuildParam1(owner);
    auto second = static_cast<uint64_t*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0xE8));
    if (!first || !second) return false;
    BuildParam2Image(second);
    using SendCall = __int64(*)(uint64_t, uint64_t);
    reinterpret_cast<SendCall>(module + offset::send_message)(reinterpret_cast<uint64_t>(first), reinterpret_cast<uint64_t>(second));
    return true;
}
}

static bool ForwardImage(const std::string& target,const std::string& path) {
    __try { return WeChatAgentMIImage::Send(target,path); }
    __except(EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static bool ForwardVoice(const std::string& target,const std::string& silk,uint32_t duration,bool swapArgs,std::string* error) {
    return WeChatAgentMIVoice::SendVoiceFile(target,silk,duration,swapArgs,error);
}

static bool StickerFileMatches(const std::filesystem::path& path,const std::string& md5) {
    std::ifstream input(path,std::ios::binary);
    if(!input)return false;
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(input)),{});
    if(bytes.empty() || bytes.size()>8*1024*1024)return false;
    bool media=(bytes.size()>=6 && (!memcmp(bytes.data(),"GIF87a",6)||!memcmp(bytes.data(),"GIF89a",6))) ||
      (bytes.size()>=8 && !memcmp(bytes.data(),"\x89PNG\r\n\x1a\n",8)) ||
      (bytes.size()>=12 && !memcmp(bytes.data(),"RIFF",4)&&!memcmp(bytes.data()+8,"WEBP",4)) ||
      (bytes.size()>=3 && bytes[0]==0xff && bytes[1]==0xd8 && bytes[2]==0xff) ||
      (bytes.size()>=4 && !memcmp(bytes.data(),"wxgf",4));
    if(!media)return false;
    BCRYPT_ALG_HANDLE algorithm=nullptr;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_MD5_ALGORITHM,nullptr,0)<0)return false;
    unsigned char digest[16]{};
    auto result=BCryptHash(algorithm,nullptr,0,bytes.data(),static_cast<ULONG>(bytes.size()),digest,16);
    BCryptCloseAlgorithmProvider(algorithm,0);
    if(result<0)return false;
    static constexpr char hex[]="0123456789abcdef";std::string actual;
    for(auto value:digest){actual+=hex[value>>4];actual+=hex[value&15];}
    return actual==md5;
}

static std::string Utf8(const std::wstring& value) {
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0, nullptr, nullptr);
    std::string out(size, '\0');
    if (size) WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), out.data(), size, nullptr, nullptr);
    return out;
}

static std::wstring ModulePath(HMODULE module = nullptr) {
    wchar_t file[32768] = {};
    DWORD size = GetModuleFileNameW(module, file, 32768);
    return size && size < 32768 ? std::wstring(file, size) : L"";
}

static std::string CoreVersion() {
    std::wstring path = ModulePath(GetModuleHandleW(L"Weixin.dll"));
    DWORD ignored = 0, size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (!size) return "";
    std::vector<BYTE> bytes(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, bytes.data())) return "";
    VS_FIXEDFILEINFO* info = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(bytes.data(), L"\\", (void**)&info, &length) || !info) return "";
    return std::to_string(HIWORD(info->dwFileVersionMS)) + "." +
        std::to_string(LOWORD(info->dwFileVersionMS)) + "." +
        std::to_string(HIWORD(info->dwFileVersionLS)) + "." +
        std::to_string(LOWORD(info->dwFileVersionLS));
}

// Query this process's file handles, without reading database pages or keys.
// ProcessHandleInformation is supported on Windows 8+; failure closes the gate.
struct HandleEntry {
    HANDLE value;
    ULONG_PTR handleCount, pointerCount;
    ULONG grantedAccess, objectTypeIndex, attributes, reserved;
};
struct HandleSnapshot { ULONG_PTR count, reserved; HandleEntry entries[1]; };

static std::set<std::string> DatabaseAccounts() {
    using Query = NTSTATUS(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    auto query = (Query)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
    if (!query) return {};
    std::vector<BYTE> buffer(65536);
    ULONG required = 0;
    NTSTATUS status = query(GetCurrentProcess(), 51, buffer.data(), (ULONG)buffer.size(), &required);
    if (status < 0 && required > buffer.size() && required < 16 * 1024 * 1024) {
        buffer.resize(required + 4096);
        status = query(GetCurrentProcess(), 51, buffer.data(), (ULONG)buffer.size(), &required);
    }
    if (status < 0) return {};
    auto* snapshot = (HandleSnapshot*)buffer.data();
    if (snapshot->count > (buffer.size() - 2 * sizeof(ULONG_PTR)) / sizeof(HandleEntry)) return {};
    std::set<std::string> accounts;
    for (ULONG_PTR i = 0; i < snapshot->count; ++i) {
        HANDLE file = snapshot->entries[i].value;
        if (GetFileType(file) != FILE_TYPE_DISK) continue;
        wchar_t name[32768] = {};
        DWORD size = GetFinalPathNameByHandleW(file, name, 32768, FILE_NAME_NORMALIZED);
        if (!size || size >= 32768) continue;
        std::wstring path(name, size);
        for (auto& ch : path) { if (ch == L'/') ch = L'\\'; ch = towlower(ch); }
        const std::wstring marker = L"\\db_storage\\";
        size_t at = path.find(marker);
        if (at == std::wstring::npos) continue;
        std::wstring suffix = path.substr(at + marker.size());
        if (suffix != L"contact\\contact.db" && suffix != L"contact\\contact.db-wal" &&
            suffix != L"session\\session.db" && suffix.rfind(L"message\\message_", 0) != 0) continue;
        size_t previous = path.rfind(L'\\', at - 1);
        if (previous != std::wstring::npos) accounts.insert(Utf8(path.substr(previous + 1, at - previous - 1)));
    }
    return accounts;
}

void RegisterWeChatAgentMIRoutes(httplib::Server& server) {
    std::ifstream file(std::filesystem::path(ModulePath()).parent_path() / L"wechatagent-hook.token");
    std::string token;
    std::getline(file, token);
    if (!token.empty() && token.back() == '\r') token.pop_back();
    server.set_payload_max_length(65536);
    auto authorized = [token](const httplib::Request& req, httplib::Response& res) {
        std::string supplied = req.get_header_value("Authorization"), expected = "Bearer " + token;
        unsigned int difference = (unsigned int)(supplied.size() ^ expected.size());
        for (size_t i = 0; i < expected.size(); ++i) difference |= expected[i] ^ (i < supplied.size() ? supplied[i] : 0);
        if (token.size() != 64 || difference) {
            res.status = 401; res.set_content("{\"error\":\"Unauthorized\"}", "application/json");
            return false;
        }
        return true;
    };
    server.Get("/WeChatAgentMI/health", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        json data = {{"backend", "wechat-hook"}, {"integration", "WeChatAgentMI-1"},
            {"version", CoreVersion()}, {"pid", GetCurrentProcessId()}, {"databaseAccounts", DatabaseAccounts()}, {"nativeStickerSend",StickerReady()},{"nativeImageSend",true},
            {"initialization", "deferred-module-v1"}, {"startupState", WeChatAgentMIInitState()}};
        res.set_content(data.dump(), "application/json");
    });
    server.Post("/SendStickerMsg",[authorized](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        try{
            auto accounts=DatabaseAccounts();auto account=req.get_header_value("X-WeChatAgentMI-Account");
            if(CoreVersion()!="4.1.10.27" || accounts.size()!=1 || !accounts.count(account)){
                res.status=409;res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}","application/json");return;
            }
            if(!StickerReady()){
                res.status=409;res.set_content("{\"ret\":1,\"error\":\"Sticker native layout unavailable\"}","application/json");return;
            }
            auto data=json::parse(req.body);auto target=data.value("wxidorgid","");auto fields=data.at("sticker");
            std::string file=data.value("path","");
            std::string md5=fields.value("md5",""),product=fields.value("productid","");
            int length=fields.value("len",0),type=fields.value("type",0),width=fields.value("width",0),height=fields.value("height",0);
            if(target.empty() || target.size()>256 || !std::regex_match(md5,std::regex("[a-f0-9]{32}")) ||
              !std::regex_match(product,std::regex("[A-Za-z0-9._-]{0,128}")) || length<0 || length>8*1024*1024 ||
              type<0 || type>5 || width<0 || width>4096 || height<0 || height>4096){
                res.status=400;res.set_content("{\"ret\":1,\"error\":\"Invalid sticker metadata\"}","application/json");return;
            }
            auto allowed=std::filesystem::weakly_canonical(std::filesystem::path(ModulePath()).parent_path().parent_path().parent_path().parent_path()/L"state"/L"stickers"/L"outgoing");
            auto image=std::filesystem::weakly_canonical(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(file.data()),file.size())));
            auto extension=image.extension().string();
            if(image.parent_path()!=allowed || image.stem().string()!=md5 ||
              !(extension==".gif"||extension==".png"||extension==".wxgf"||extension==".webp"||extension==".jpg") ||
              !std::filesystem::is_regular_file(image) || std::filesystem::file_size(image)>8*1024*1024 || !StickerFileMatches(image,md5)){
                res.status=400;res.set_content("{\"ret\":1,\"error\":\"Invalid sticker file\"}","application/json");return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex,std::defer_lock);
            if(!lock.try_lock_for(std::chrono::seconds(1))){res.status=429;res.set_content("{\"ret\":1}","application/json");return;}
            bool accepted=ForwardSticker(target,file);
            res.set_content(accepted?"{\"ret\":0,\"retmsg\":\"accepted\"}":"{\"ret\":1,\"error\":\"Native sticker rejected\"}","application/json");
        }catch(...){res.status=400;res.set_content("{\"ret\":1,\"error\":\"Invalid sticker request\"}","application/json");}
    });
    server.Post("/WeChatAgentMI/sticker-trace",[authorized](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        auto accounts=DatabaseAccounts();auto account=req.get_header_value("X-WeChatAgentMI-Account");
        if(CoreVersion()!="4.1.10.27" || accounts.size()!=1 || !accounts.count(account)){res.status=409;res.set_content("{}","application/json");return;}
        try {
            auto data=json::parse(req.body);auto target=data.value("wxidorgid","");auto mode=data.value("mode","");
            if(target.size()>256){res.status=400;res.set_content("{}","application/json");return;}
            bool started=mode=="send"?WeChatAgentMISticker::StartSendTrace(target):WeChatAgentMISticker::StartTrace(target);
            if(!started){res.status=503;res.set_content("{}","application/json");return;}
            res.set_content(WeChatAgentMISticker::TraceJson(),"application/json");
        }catch(...){res.status=400;res.set_content("{}","application/json");}
    });
    server.Get("/WeChatAgentMI/sticker-trace",[authorized](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        res.set_content(WeChatAgentMISticker::TraceJson(),"application/json");
    });
    // Local generated images only. Same guards as text: loopback token, single
    // verified account, bounded body, and a canonical path inside the project's
    // own state/generated-images directory.
    server.Post("/SendImgMsg", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        try {
            auto accounts = DatabaseAccounts();
            std::string account = req.get_header_value("X-WeChatAgentMI-Account");
            if (CoreVersion() != "4.1.10.27" || account.empty() || accounts.size() != 1 || !accounts.count(account)) {
                res.status = 409; res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}", "application/json"); return;
            }
            json data = json::parse(req.body);
            std::string target = data.value("wxidorgid", ""), file = data.value("path", "");
            if (target.empty() || target.size() > 256 || file.empty() || file.size() > 1024) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Invalid image target\"}", "application/json"); return;
            }
            auto allowed = std::filesystem::weakly_canonical(
                std::filesystem::path(ModulePath()).parent_path().parent_path().parent_path().parent_path() / L"state" / L"generated-images");
            std::filesystem::path image;
            try {
                image = std::filesystem::weakly_canonical(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(file.data()), file.size())));
            } catch (...) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Invalid image path\"}", "application/json"); return;
            }
            auto extension = image.extension().string();
            if (image.parent_path() != allowed || !std::regex_match(image.stem().string(), std::regex("[a-f0-9]{64}")) ||
                !(extension == ".png" || extension == ".jpg") || !std::filesystem::is_regular_file(image) ||
                std::filesystem::file_size(image) > 16 * 1024 * 1024) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Invalid image file\"}", "application/json"); return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex, std::defer_lock);
            if (!lock.try_lock_for(std::chrono::seconds(1))) {
                res.status = 429; res.set_content("{\"ret\":1,\"error\":\"Busy\"}", "application/json"); return;
            }
            bool accepted = ForwardImage(target, Utf8(image.wstring()));
            if (!accepted) {
                res.status = 500; res.set_content("{\"ret\":1,\"error\":\"Native image rejected\"}", "application/json"); return;
            }
            // Acceptance only. The adapter still waits for a database receipt.
            res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}", "application/json");
        } catch (...) {
            res.status = 500; res.set_content("{\"ret\":1,\"error\":\"Native image failed\"}", "application/json");
        }
    });
    // 语音消息：只接受 state/generated-voices/<sha256>.silk。时长以 SILK 帧数
    // 为准（20ms/帧，与客户端录音侧一致），调用微信自己的 UI 发送入口 0x6199D10。
    server.Post("/SendVoiceMsg", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        try {
            auto accounts = DatabaseAccounts();
            std::string account = req.get_header_value("X-WeChatAgentMI-Account");
            if (CoreVersion() != "4.1.10.27" || account.empty() || accounts.size() != 1 || !accounts.count(account)) {
                res.status = 409; res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}", "application/json"); return;
            }
            if (!WeChatAgentMIVoice::Ready()) {
                res.status = 409; res.set_content("{\"ret\":1,\"error\":\"Voice native layout unavailable\"}", "application/json"); return;
            }
            json data = json::parse(req.body);
            std::string target = data.value("wxidorgid", ""), file = data.value("path", "");
            uint32_t duration = data.value("duration", 0u);
            if (target.empty() || target.size() > 256 || file.empty() || file.size() > 1024 || duration > 60000) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Invalid voice target\"}", "application/json"); return;
            }
            auto allowed = std::filesystem::weakly_canonical(
                std::filesystem::path(ModulePath()).parent_path().parent_path().parent_path().parent_path() / L"state" / L"generated-voices");
            std::filesystem::path voice;
            try {
                voice = std::filesystem::weakly_canonical(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(file.data()), file.size())));
            } catch (...) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Invalid voice path\"}", "application/json"); return;
            }
            if (voice.parent_path() != allowed || voice.extension() != ".silk" ||
                !std::regex_match(voice.stem().string(), std::regex("[a-f0-9]{64}")) ||
                !std::filesystem::is_regular_file(voice) || std::filesystem::file_size(voice) > 512 * 1024) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Invalid voice file\"}", "application/json"); return;
            }
            std::ifstream input(voice, std::ios::binary);
            std::string silk((std::istreambuf_iterator<char>(input)), {});
            if (!WeChatAgentMIVoice::IsSilk(silk)) {
                res.status = 400; res.set_content("{\"ret\":1,\"error\":\"Not SILK_V3\"}", "application/json"); return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex, std::defer_lock);
            if (!lock.try_lock_for(std::chrono::seconds(1))) {
                res.status = 429; res.set_content("{\"ret\":1,\"error\":\"Busy\"}", "application/json"); return;
            }
            std::string error;
            bool accepted = ForwardVoice(target, silk, duration, data.value("swap", false), &error);
            if (!accepted) {
                res.status = 500; res.set_content("{\"ret\":1,\"error\":\"" + error + "\"}", "application/json"); return;
            }
            res.set_content("{\"ret\":0,\"retmsg\":\"accepted\",\"duration\":" +
                std::to_string(WeChatAgentMIVoice::DurationMs(silk)) + "}", "application/json");
        } catch (...) {
            res.status = 500; res.set_content("{\"ret\":1,\"error\":\"Native voice failed\"}", "application/json");
        }
    });
    server.Post("/SendTextMsg", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        try {
            auto accounts = DatabaseAccounts();
            std::string account = req.get_header_value("X-WeChatAgentMI-Account");
            if (CoreVersion() != "4.1.10.27" || account.empty() || accounts.size() != 1 || !accounts.count(account)) {
                res.status = 409; res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}", "application/json"); return;
            }
            json data = json::parse(req.body);
            std::string target = data.value("wxidorgid", ""), text = data.value("msg", "");
            if (target.empty() || target.size() > 256 || text.empty() || text.size() > 16000) {
                res.status = 400; res.set_content("{\"ret\":1}", "application/json"); return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex, std::defer_lock);
            if (!lock.try_lock_for(std::chrono::seconds(1))) {
                res.status = 429; res.set_content("{\"ret\":1,\"error\":\"Busy\"}", "application/json"); return;
            }
            WeixinSend::SendText(target, text);
            // Acceptance only. The OneBot adapter still requires a new server receipt.
            res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}", "application/json");
        } catch (...) {
            res.status = 500; res.set_content("{\"ret\":1,\"error\":\"Native send failed\"}", "application/json");
        }
    });
    // Route handlers run after the bounded request body is read. Rejecting a
    // POST before reading its body can reset TCP and truncate the error JSON.
    auto unknown = [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        res.status = 404; res.set_content("{}", "application/json");
    };
    server.Get(".*", unknown);
    server.Post(".*", unknown);
}
