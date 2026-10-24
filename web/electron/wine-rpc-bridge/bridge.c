/*
 * Telium Wine Discord RPC bridge
 *
 * Inspired by EnderIce2/rpc-bridge's MIT-licensed Wine-service lifecycle.
 * Telium keeps only the headless Windows named-pipe side and relays to an
 * authenticated localhost endpoint owned by the desktop utility process.
 *
 * Plain Wine may use --start-service for an immediate demand-start relay.
 * Steam/Proton uses --install-auto-service only while the prefix is idle. On
 * later game launches Wine's own services.exe auto-starts the bridge inside the
 * game's actual wineserver/Pressure Vessel. The auto service waits for a fresh
 * endpoint file from a running Telium before it creates the Discord pipe, so it
 * is inert when Telium is closed or Rich Presence is disabled.
 *
 * See LICENSE-rpc-bridge.txt for upstream license/attribution.
 */

#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winsvc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BUFFER_SIZE 8192
#define PIPE_NAME "\\\\.\\pipe\\discord-ipc-0"
#define SERVICE_NAME "telium-rpc-bridge"
#define SERVICE_DISPLAY_NAME "Telium Wine RPC Bridge"
#define SERVICE_BINARY "C:\\windows\\temp\\telium-rpc-bridge-v2.exe"
#define SERVICE_COMMAND "C:\\windows\\temp\\telium-rpc-bridge-v2.exe --service"
#define CONFIG_PATH "C:\\windows\\temp\\telium-rpc-endpoint.txt"
#define TOKEN_SIZE 128
#define SERVICE_KEY_SIZE 128

typedef struct relay_state {
    HANDLE pipe;
    SOCKET socket;
    volatile LONG stopped;
} relay_state;

static SERVICE_STATUS g_service_status;
static SERVICE_STATUS_HANDLE g_service_handle = NULL;

static void diagnostic(const char *message) {
    fprintf(stderr, "TELIUM_RPC:%s\n", message);
    fflush(stderr);
}

static void diagnostic_code(const char *message, int code) {
    fprintf(stderr, "TELIUM_RPC:%s:%d\n", message, code);
    fflush(stderr);
}

static void trim_line(char *line) {
    if (!line) return;
    size_t length = strlen(line);
    while (length && (line[length - 1] == '\r' || line[length - 1] == '\n')) {
        line[--length] = '\0';
    }
}

static void stop_relay(relay_state *state) {
    if (InterlockedExchange(&state->stopped, 1) != 0) return;
    shutdown(state->socket, SD_BOTH);
    CancelIoEx(state->pipe, NULL);
}

static int send_all(SOCKET socket_fd, const char *buffer, int length) {
    int sent = 0;
    while (sent < length) {
        int n = send(socket_fd, buffer + sent, length - sent, 0);
        if (n <= 0) return 0;
        sent += n;
    }
    return 1;
}

static int recv_all(SOCKET socket_fd, char *buffer, int length) {
    int received = 0;
    while (received < length) {
        int n = recv(socket_fd, buffer + received, length - received, 0);
        if (n <= 0) return 0;
        received += n;
    }
    return 1;
}

static int write_all(HANDLE pipe, const char *buffer, DWORD length) {
    DWORD written_total = 0;
    while (written_total < length) {
        DWORD written = 0;
        if (!WriteFile(pipe, buffer + written_total, length - written_total, &written, NULL)) return 0;
        if (written == 0) return 0;
        written_total += written;
    }
    return 1;
}

static DWORD WINAPI pipe_to_socket(LPVOID param) {
    relay_state *state = (relay_state *)param;
    char buffer[BUFFER_SIZE];
    while (!state->stopped) {
        DWORD read = 0;
        if (!ReadFile(state->pipe, buffer, sizeof(buffer), &read, NULL) || read == 0) break;
        if (!send_all(state->socket, buffer, (int)read)) break;
    }
    stop_relay(state);
    return 0;
}

static DWORD WINAPI socket_to_pipe(LPVOID param) {
    relay_state *state = (relay_state *)param;
    char buffer[BUFFER_SIZE];
    while (!state->stopped) {
        int read = recv(state->socket, buffer, sizeof(buffer), 0);
        if (read <= 0) break;
        if (!write_all(state->pipe, buffer, (DWORD)read)) break;
    }
    stop_relay(state);
    return 0;
}

static int parse_port(const char *text, unsigned short *port) {
    if (!text || !*text) return 0;
    char *end = NULL;
    long value = strtol(text, &end, 10);
    if (!end || *end != '\0' || value <= 0 || value > 65535) return 0;
    *port = (unsigned short)value;
    return 1;
}

static SOCKET open_loopback_socket(unsigned short port) {
    SOCKET socket_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_fd == INVALID_SOCKET) return INVALID_SOCKET;

    struct sockaddr_in address;
    ZeroMemory(&address, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        closesocket(socket_fd);
        return INVALID_SOCKET;
    }
    return socket_fd;
}

static int control_exchange(
    unsigned short port,
    const char *verb,
    const char *token,
    const char *service_key,
    const char *expected_ack
) {
    if (!token || !*token || strlen(token) >= TOKEN_SIZE
        || !service_key || !*service_key || strlen(service_key) >= SERVICE_KEY_SIZE) return 0;

    SOCKET socket_fd = open_loopback_socket(port);
    if (socket_fd == INVALID_SOCKET) return 0;

    char message[TOKEN_SIZE + SERVICE_KEY_SIZE + 24];
    int message_length = snprintf(message, sizeof(message), "%s %s %s\n", verb, token, service_key);
    if (message_length <= 0 || message_length >= (int)sizeof(message)) {
        closesocket(socket_fd);
        return 0;
    }

    DWORD timeout_ms = 2000;
    setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
    int ack_length = (int)strlen(expected_ack);
    char ack[32];
    int ok = ack_length < (int)sizeof(ack)
        && send_all(socket_fd, message, message_length)
        && recv_all(socket_fd, ack, ack_length)
        && memcmp(ack, expected_ack, ack_length) == 0;
    closesocket(socket_fd);
    return ok;
}

static int probe_endpoint(unsigned short port, const char *token, const char *service_key) {
    return control_exchange(port, "PROBE", token, service_key, "PROBE-OK\n");
}

static int notify_pipe_ready(unsigned short port, const char *token, const char *service_key) {
    for (int attempt = 0; attempt < 40; attempt++) {
        if (control_exchange(port, "READY", token, service_key, "READY-OK\n")) return 1;
        Sleep(250);
    }
    return 0;
}

static SOCKET connect_rpc_socket(unsigned short port, const char *token) {
    if (!token || !*token || strlen(token) >= TOKEN_SIZE) return INVALID_SOCKET;

    for (int attempt = 0; attempt < 40; attempt++) {
        SOCKET socket_fd = open_loopback_socket(port);
        if (socket_fd == INVALID_SOCKET) {
            Sleep(250);
            continue;
        }

        if (!send_all(socket_fd, token, (int)strlen(token)) || !send_all(socket_fd, "\n", 1)) {
            closesocket(socket_fd);
            Sleep(250);
            continue;
        }

        DWORD timeout_ms = 5000;
        setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
        char ack[3];
        if (!recv_all(socket_fd, ack, sizeof(ack)) || memcmp(ack, "OK\n", sizeof(ack)) != 0) {
            closesocket(socket_fd);
            Sleep(250);
            continue;
        }
        timeout_ms = 0;
        setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
        return socket_fd;
    }

    return INVALID_SOCKET;
}

static HANDLE create_rpc_pipe(void) {
    return CreateNamedPipeA(
        PIPE_NAME,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        PIPE_UNLIMITED_INSTANCES,
        BUFFER_SIZE,
        BUFFER_SIZE,
        0,
        NULL
    );
}

static int run_bridge(
    unsigned short port,
    const char *token,
    const char *service_key,
    int revalidate_after_connection
) {
    int readiness_reported = 0;

    for (;;) {
        HANDLE pipe = create_rpc_pipe();
        if (pipe == INVALID_HANDLE_VALUE) return 4;

        if (!readiness_reported) {
            if (!notify_pipe_ready(port, token, service_key)) {
                CloseHandle(pipe);
                return 5;
            }
            readiness_reported = 1;
        }

        BOOL connected = ConnectNamedPipe(pipe, NULL);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            Sleep(250);
            continue;
        }

        SOCKET socket_fd = connect_rpc_socket(port, token);
        if (socket_fd == INVALID_SOCKET) {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
            if (revalidate_after_connection) return 6;
            Sleep(500);
            continue;
        }

        relay_state state = { pipe, socket_fd, 0 };
        HANDLE threads[2] = { NULL, NULL };
        threads[0] = CreateThread(NULL, 0, pipe_to_socket, &state, 0, NULL);
        threads[1] = CreateThread(NULL, 0, socket_to_pipe, &state, 0, NULL);
        if (!threads[0] || !threads[1]) {
            stop_relay(&state);
            if (threads[0]) WaitForSingleObject(threads[0], 1000);
            if (threads[1]) WaitForSingleObject(threads[1], 1000);
        } else {
            WaitForMultipleObjects(2, threads, FALSE, INFINITE);
            stop_relay(&state);
            WaitForMultipleObjects(2, threads, TRUE, 1000);
        }

        if (threads[0]) CloseHandle(threads[0]);
        if (threads[1]) CloseHandle(threads[1]);
        closesocket(socket_fd);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);

        if (revalidate_after_connection) return 0;
    }
}

static int read_auto_config(
    char *port_text,
    size_t port_size,
    char *token,
    size_t token_size,
    char *service_key,
    size_t service_key_size
) {
    FILE *file = fopen(CONFIG_PATH, "rb");
    if (!file) return 0;

    int ok = fgets(port_text, (int)port_size, file) != NULL
        && fgets(token, (int)token_size, file) != NULL
        && fgets(service_key, (int)service_key_size, file) != NULL;
    fclose(file);
    if (!ok) return 0;

    trim_line(port_text);
    trim_line(token);
    trim_line(service_key);
    unsigned short ignored = 0;
    return parse_port(port_text, &ignored)
        && token[0] && strlen(token) < TOKEN_SIZE
        && service_key[0] && strlen(service_key) < SERVICE_KEY_SIZE;
}

static int run_auto_service(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 3;

    for (;;) {
        char port_text[16] = {0};
        char token[TOKEN_SIZE] = {0};
        char service_key[SERVICE_KEY_SIZE] = {0};
        unsigned short port = 0;

        // The endpoint file is deliberately pre-armed before Proton starts.
        // If it is absent, the service was auto-started only because an idle
        // installer brought Wine's SCM up. Exit instead of keeping a stray
        // host wineserver alive while Telium is repairing the service.
        if (!read_auto_config(
            port_text, sizeof(port_text),
            token, sizeof(token),
            service_key, sizeof(service_key)
        ) || !parse_port(port_text, &port)) {
            WSACleanup();
            return 0;
        }

        // Stale credentials must be inert. A future Wine launch will auto-start
        // the service again after Telium has supplied a fresh endpoint.
        if (!probe_endpoint(port, token, service_key)) {
            WSACleanup();
            return 0;
        }

        (void)run_bridge(port, token, service_key, 1);
        Sleep(250);
    }
}

static void set_service_state(DWORD state, DWORD exit_code) {
    ZeroMemory(&g_service_status, sizeof(g_service_status));
    g_service_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_service_status.dwCurrentState = state;
    g_service_status.dwWin32ExitCode = exit_code;
    g_service_status.dwControlsAccepted = state == SERVICE_RUNNING
        ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN)
        : 0;
    if (g_service_handle) SetServiceStatus(g_service_handle, &g_service_status);
}

static void WINAPI service_control(DWORD code) {
    if (code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN) {
        set_service_state(SERVICE_STOPPED, 0);
        ExitProcess(0);
    }
}

static void WINAPI service_main(DWORD argc, LPSTR *argv) {
    g_service_handle = RegisterServiceCtrlHandlerA(SERVICE_NAME, service_control);
    if (!g_service_handle) return;
    set_service_state(SERVICE_START_PENDING, 0);
    set_service_state(SERVICE_RUNNING, 0);

    int result = 0;
    if (argc >= 4) {
        unsigned short port = 0;
        const char *token = argv[2];
        const char *service_key = argv[3];
        if (!parse_port(argv[1], &port) || !token || !*token || !service_key || !*service_key) {
            result = ERROR_INVALID_PARAMETER;
        } else {
            WSADATA wsa;
            if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) result = 3;
            else {
                result = run_bridge(port, token, service_key, 0);
                WSACleanup();
            }
        }
    } else {
        result = run_auto_service();
    }

    set_service_state(SERVICE_STOPPED, (DWORD)result);
}

static int wait_service_stopped(SC_HANDLE service, DWORD timeout_ms) {
    DWORD started = GetTickCount();
    SERVICE_STATUS_PROCESS status;
    DWORD needed = 0;
    while (GetTickCount() - started < timeout_ms) {
        if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
                                  (LPBYTE)&status, sizeof(status), &needed)) return 0;
        if (status.dwCurrentState == SERVICE_STOPPED) return 1;
        Sleep(100);
    }
    return 0;
}

static SC_HANDLE open_service_manager_with_retry(void) {
    DWORD last_error = ERROR_SUCCESS;
    for (int attempt = 0; attempt < 20; attempt++) {
        SC_HANDLE manager = OpenSCManagerA(NULL, NULL, SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE);
        if (manager) return manager;
        last_error = GetLastError();
        Sleep(250);
    }
    SetLastError(last_error);
    return NULL;
}

static SC_HANDLE open_service_for_config(SC_HANDLE manager, int *ok) {
    *ok = 1;
    SC_HANDLE service = OpenServiceA(manager, SERVICE_NAME,
        SERVICE_QUERY_STATUS | SERVICE_STOP | SERVICE_START | SERVICE_CHANGE_CONFIG);
    if (!service) {
        if (GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST) return NULL;
        diagnostic_code("error:service-install", (int)GetLastError());
        *ok = 0;
        return NULL;
    }
    return service;
}

static int copy_service_binary(char *current_path, DWORD current_path_size) {
    DWORD path_length = GetModuleFileNameA(NULL, current_path, current_path_size);
    if (path_length == 0 || path_length >= current_path_size) {
        diagnostic_code("error:service-path", (int)GetLastError());
        return 0;
    }
    if (!CopyFileA(current_path, SERVICE_BINARY, FALSE)) {
        diagnostic_code("error:service-copy", (int)GetLastError());
        return 0;
    }
    return 1;
}

static SC_HANDLE configure_service(SC_HANDLE manager, SC_HANDLE service, DWORD start_type) {
    if (!service) {
        service = CreateServiceA(
            manager,
            SERVICE_NAME,
            SERVICE_DISPLAY_NAME,
            SERVICE_QUERY_STATUS | SERVICE_STOP | SERVICE_START | SERVICE_CHANGE_CONFIG,
            SERVICE_WIN32_OWN_PROCESS,
            start_type,
            SERVICE_ERROR_NORMAL,
            SERVICE_COMMAND,
            NULL, NULL, NULL, NULL, NULL
        );
        if (!service) {
            diagnostic_code("error:service-install", (int)GetLastError());
            return NULL;
        }
        return service;
    }

    // ChangeServiceConfig is valid for a running service and affects its next
    // start. That lets us migrate from an older helper/start type without first
    // stopping the process Wine just auto-started for this SCM session.
    if (!ChangeServiceConfigA(
        service,
        SERVICE_NO_CHANGE,
        start_type,
        SERVICE_NO_CHANGE,
        SERVICE_COMMAND,
        NULL, NULL, NULL, NULL, NULL,
        SERVICE_DISPLAY_NAME
    )) {
        diagnostic_code("error:service-config", (int)GetLastError());
        CloseServiceHandle(service);
        return NULL;
    }
    return service;
}

static int retire_existing_service(SC_HANDLE service) {
    if (!service) return 1;

    SERVICE_STATUS_PROCESS status;
    DWORD needed = 0;
    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
                              (LPBYTE)&status, sizeof(status), &needed)) {
        diagnostic_code("error:service-stop:query", (int)GetLastError());
        return 0;
    }
    if (status.dwCurrentState == SERVICE_STOPPED) return 1;

    // Ask normally first, but do not make repair depend on Wine implementing
    // service stop perfectly. Some Proton/Wine combinations leave this service
    // reported running even after accepting SERVICE_CONTROL_STOP.
    SERVICE_STATUS ignored;
    if (ControlService(service, SERVICE_CONTROL_STOP, &ignored)) {
        if (wait_service_stopped(service, 1500)) return 1;
    } else if (GetLastError() == ERROR_SERVICE_NOT_ACTIVE) {
        return 1;
    }

    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
                              (LPBYTE)&status, sizeof(status), &needed)) {
        diagnostic_code("error:service-stop:query", (int)GetLastError());
        return 0;
    }
    if (status.dwCurrentState == SERVICE_STOPPED) return 1;
    if (!status.dwProcessId) {
        diagnostic("error:service-stop:no-pid");
        return 0;
    }

    // The prefix is idle when --install-auto-service runs. Terminating exactly
    // the stale Telium service process is therefore safe and prevents the old
    // auto-start binary from keeping the repair wineserver alive forever.
    HANDLE process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, status.dwProcessId);
    if (!process) {
        diagnostic_code("error:service-stop:open-process", (int)GetLastError());
        return 0;
    }
    if (!TerminateProcess(process, 0)) {
        DWORD error = GetLastError();
        CloseHandle(process);
        diagnostic_code("error:service-stop:terminate", (int)error);
        return 0;
    }
    DWORD wait_result = WaitForSingleObject(process, 2000);
    CloseHandle(process);
    if (wait_result != WAIT_OBJECT_0) {
        diagnostic("error:service-stop:retire-timeout");
        return 0;
    }

    // The process handle is authoritative here. Wine's SCM can lag behind and
    // keep reporting RUNNING briefly after a forced retirement, which must not
    // turn a successful idle-prefix repair into another false failure.
    return 1;
}

static int prepare_service(
    DWORD start_type,
    SC_HANDLE *manager_out,
    SC_HANDLE *service_out
) {
    *manager_out = NULL;
    *service_out = NULL;

    SC_HANDLE manager = open_service_manager_with_retry();
    if (!manager) {
        diagnostic_code("error:service-manager", (int)GetLastError());
        return 0;
    }

    int service_ok = 1;
    SC_HANDLE service = open_service_for_config(manager, &service_ok);
    if (!service_ok) {
        CloseServiceHandle(manager);
        return 0;
    }

    // Use a versioned destination so a running older service never needs to be
    // stopped or overwritten. SCM switches the service command to this path for
    // the next start; the old process can be retired only after that migration
    // is safely committed.
    char current_path[MAX_PATH];
    if (!copy_service_binary(current_path, sizeof(current_path))) {
        if (service) CloseServiceHandle(service);
        CloseServiceHandle(manager);
        return 0;
    }

    service = configure_service(manager, service, start_type);
    if (!service) {
        CloseServiceHandle(manager);
        return 0;
    }

    *manager_out = manager;
    *service_out = service;
    return 1;
}

static int install_auto_service(void) {
    SC_HANDLE manager = NULL;
    SC_HANDLE service = NULL;
    if (!prepare_service(SERVICE_AUTO_START, &manager, &service)) return 10;

    // At this point SCM already points at v2/AUTO_START for the next Wine boot.
    // Retire an older service process only after the migration is committed.
    if (!retire_existing_service(service)) {
        CloseServiceHandle(service);
        CloseServiceHandle(manager);
        return 11;
    }

    diagnostic("auto-installed");
    CloseServiceHandle(service);
    CloseServiceHandle(manager);
    return 0;
}

static int start_service_bridge(const char *port_text, const char *token, const char *service_key) {
    unsigned short ignored = 0;
    if (!parse_port(port_text, &ignored) || !token || !*token || strlen(token) >= TOKEN_SIZE
        || !service_key || !*service_key || strlen(service_key) >= SERVICE_KEY_SIZE) {
        diagnostic("error:auth-missing");
        return 2;
    }

    SC_HANDLE manager = NULL;
    SC_HANDLE service = NULL;
    if (!prepare_service(SERVICE_DEMAND_START, &manager, &service)) return 10;

    const char *args[3] = { port_text, token, service_key };
    if (!StartServiceA(service, 3, args)) {
        DWORD error = GetLastError();
        if (error != ERROR_SERVICE_ALREADY_RUNNING) {
            CloseServiceHandle(service);
            CloseServiceHandle(manager);
            diagnostic_code("error:service-start", (int)error);
            return 12;
        }
    }

    diagnostic("service-started");
    CloseServiceHandle(service);
    CloseServiceHandle(manager);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--service") == 0) {
        SERVICE_TABLE_ENTRYA table[] = {
            { SERVICE_NAME, service_main },
            { NULL, NULL },
        };
        if (!StartServiceCtrlDispatcherA(table)) return 13;
        return 0;
    }

    if (argc >= 2 && strcmp(argv[1], "--install-auto-service") == 0) {
        return install_auto_service();
    }

    if (argc >= 5 && strcmp(argv[1], "--start-service") == 0) {
        return start_service_bridge(argv[2], argv[3], argv[4]);
    }

    diagnostic("error:mode-missing");
    return 2;
}