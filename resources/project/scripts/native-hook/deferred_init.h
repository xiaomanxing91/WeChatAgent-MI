#pragma once
#include <Windows.h>
void ScheduleWeChatAgentInit(HMODULE module);
void CancelWeChatAgentInit();
void WeChatAgentInitLog(const char* stage, unsigned long detail = 0);
const char* WeChatAgentInitState();
