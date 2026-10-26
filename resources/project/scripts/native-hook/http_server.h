#pragma once
#include <string>
#include <thread>
#include <atomic>
#include <memory>
#include <mutex>
namespace httplib { class Server; }
class HttpServer {
public:
    HttpServer();
    ~HttpServer();
    bool Start(const std::string& host, int port);
    void Stop();
    bool IsRunning() const { return m_running.load(); }
private:
    void Run();
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::unique_ptr<httplib::Server> m_server;
    std::mutex m_lifecycle;
};
