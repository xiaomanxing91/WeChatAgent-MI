#define CPPHTTPLIB_WIN32
#define CPPHTTPLIB_THREAD_POOL_COUNT 8
#define CPPHTTPLIB_IDLE_INTERVAL_USECOND 100
#include "httplib.h"
#include "http_server.h"
#include "http_routes.h"
#include "deferred_init.h"

HttpServer::HttpServer() = default;
HttpServer::~HttpServer() { Stop(); }
bool HttpServer::Start(const std::string& host, int port) {
    std::lock_guard<std::mutex> guard(m_lifecycle);
    if (m_running.load()) return true;
    if (m_thread.joinable()) m_thread.join();
    m_server = std::make_unique<httplib::Server>();
    m_server->new_task_queue = [] { return new httplib::ThreadPool(CPPHTTPLIB_THREAD_POOL_COUNT); };
    m_server->set_idle_interval(0, 100);
    m_server->set_tcp_nodelay(true);
    RegisterRoutes(*m_server);
    // Bind synchronously. A non-null object or a spawned thread is not proof
    // that the configured loopback port was successfully reserved.
    if (host != "127.0.0.1" || !m_server->bind_to_port(host, port)) {
        WeChatAgentInitLog("http_bind_failed", port); m_server.reset(); return false;
    }
    m_running.store(true);
    try { m_thread = std::thread(&HttpServer::Run, this); }
    catch (...) { m_server->stop(); m_running.store(false); WeChatAgentInitLog("http_thread_failed", port); return false; }
    m_server->wait_until_ready();
    if (!m_server->is_running()) { m_running.store(false); if (m_thread.joinable()) m_thread.join(); return false; }
    WeChatAgentInitLog("http_listening", port);
    return true;
}
void HttpServer::Run() {
    bool served = false;
    try { served = m_server->listen_after_bind(); } catch (...) { WeChatAgentInitLog("http_listen_exception"); }
    m_running.store(false);
    WeChatAgentInitLog(served ? "http_stopped" : "http_listen_failed");
}
void HttpServer::Stop() {
    std::lock_guard<std::mutex> guard(m_lifecycle);
    if (m_server) m_server->stop();
    if (m_thread.joinable()) m_thread.join();
    m_running.store(false);
    m_server.reset();
}
