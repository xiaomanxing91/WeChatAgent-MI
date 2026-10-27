#pragma once
#include <Windows.h>
void ScheduleWeChatAgentMIInit(HMODULE module);
void CancelWeChatAgentMIInit();
void WeChatAgentMIInitLog(const char* stage, unsigned long detail = 0);
const char* WeChatAgentMIInitState();
