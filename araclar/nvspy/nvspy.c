// nvspy: a logging pass-through for nvapi64.dll, for the GPU lighting proof (docs/GPU_ISIK_PLANI.md, steps 1-2).
//
// Placed next to MSI Center's Mystic Light executable (the one that loads nvapi64.dll), it is loaded instead of the
// system copy; it loads the real C:\Windows\System32\nvapi64.dll and forwards every call to it unchanged. It only
// observes: every interface id the program asks for (once), and every I2C read and write in full (GPU handle, port,
// device address, register bytes, data bytes, result). It never changes arguments, never calls anything itself,
// and never writes to the card. Remove the file and the program uses the system copy again.
//
// Log: C:\ProgramData\KontrolMerkezi-nvspy\nvspy-<process>-<pid>.txt
//
// Build: build.bat (x64 nvapi64.dll and x86 nvapi.dll, the same source)

#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <share.h>

typedef void *(__cdecl *QueryFn)(uint32_t id);
typedef void *(__cdecl *DirectFn)(void *a, void *b, void *c, void *d);
typedef int(__cdecl *I2cExFn)(void *gpu, void *info, uint32_t *unknown);
typedef int(__cdecl *I2cFn)(void *gpu, void *info);

#define ID_I2C_WRITE_EX 0x283AC65Au
#define ID_I2C_READ_EX  0x4D7B0709u
#define ID_I2C_WRITE    0xE812EB07u
#define ID_I2C_READ     0x2FDE12C5u

static HMODULE g_real;
static QueryFn g_query;
static DirectFn g_direct;
static I2cExFn g_writeEx, g_readEx;
static I2cFn g_write, g_read;
static CRITICAL_SECTION g_lock;
static FILE *g_log;
static uint32_t g_seen[512];
static int g_seenCount;

static void open_log(void)
{
    char exe[MAX_PATH], path[MAX_PATH], *name;
    GetModuleFileNameA(NULL, exe, MAX_PATH);
    name = strrchr(exe, '\\');
    name = name ? name + 1 : exe;
    CreateDirectoryA("C:\\ProgramData\\KontrolMerkezi-nvspy", NULL);
    _snprintf_s(path, MAX_PATH, _TRUNCATE, "C:\\ProgramData\\KontrolMerkezi-nvspy\\nvspy-%s-%lu.txt", name, GetCurrentProcessId());
    g_log = _fsopen(path, "a", _SH_DENYNO);   // readable while the program runs
    if (g_log) fprintf(g_log, "# nvspy started in %s\n", exe), fflush(g_log);
}

static void stamp(void)
{
    SYSTEMTIME t;
    GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d.%03d t%lu ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentThreadId());
}

static void hex(const uint8_t *p, uint32_t n)
{
    uint32_t i;
    if (!p) { fprintf(g_log, "(null)"); return; }
    for (i = 0; i < n && i < 256; i++) fprintf(g_log, "%02X%s", p[i], i + 1 < n ? " " : "");
    if (n > 256) fprintf(g_log, " ...");
}

// NV_I2C_INFO, natural layout. x64: version@0 displayMask@4 bIsDDCPort@8 i2cDevAddress@9 pbI2cRegAddress@16
// regAddrSize@24 pbData@32 cbSize@40 i2cSpeed@44 i2cSpeedKhz@48 portId@52 bIsPortIdSet@56 (size 64).
// x86: pbI2cRegAddress@12 regAddrSize@16 pbData@20 cbSize@24 i2cSpeed@28 i2cSpeedKhz@32 portId@36 bIsPortIdSet@40 (44).
// The raw struct bytes are logged too, so the layout can be checked from the log itself.
#ifdef _WIN64
enum { O_REG = 16, O_REGN = 24, O_DATA = 32, O_CB = 40, O_KHZ = 48, O_PORT = 52, O_PSET = 56, MINSZ = 60 };
#else
enum { O_REG = 12, O_REGN = 16, O_DATA = 20, O_CB = 24, O_KHZ = 32, O_PORT = 36, O_PSET = 40, MINSZ = 44 };
#endif
static void log_i2c(const char *what, void *gpu, void *info, int status, int after)
{
    const uint8_t *b = (const uint8_t *)info;
    uint32_t version, size;
    if (!g_log || !info) return;
    version = *(const uint32_t *)b;
    size = version & 0xFFFF;
    EnterCriticalSection(&g_lock);
    stamp();
    fprintf(g_log, "%s %s gpu=%p ver=%u size=%u", what, after ? "AFTER" : "BEFORE", gpu, version >> 16, size);
    if (size >= MINSZ)
    {
        const uint8_t *reg = *(const uint8_t *const *)(b + O_REG);
        uint32_t regSize = *(const uint32_t *)(b + O_REGN);
        const uint8_t *data = *(const uint8_t *const *)(b + O_DATA);
        uint32_t cb = *(const uint32_t *)(b + O_CB);
        fprintf(g_log, " ddc=%u addr8=0x%02X addr7=0x%02X port=%u portSet=%u speedKhz=%d mask=0x%X reg[%u]=",
                b[8], b[9], b[9] >> 1, b[O_PORT], *(const uint32_t *)(b + O_PSET), *(const int *)(b + O_KHZ), *(const uint32_t *)(b + 4), regSize);
        hex(reg, regSize);
        fprintf(g_log, " data[%u]=", cb);
        if (!after || strstr(what, "READ")) hex(data, cb); else fprintf(g_log, "-");
    }
    if (after) fprintf(g_log, " status=%d", status);
    fprintf(g_log, " raw=");
    hex(b, size && size <= 64 ? size : 64);
    fprintf(g_log, "\n");
    fflush(g_log);
    LeaveCriticalSection(&g_lock);
}

static int __cdecl spy_write_ex(void *gpu, void *info, uint32_t *u) { int s; log_i2c("I2C_WRITE_EX", gpu, info, 0, 0); s = g_writeEx(gpu, info, u); log_i2c("I2C_WRITE_EX", gpu, info, s, 1); return s; }
static int __cdecl spy_read_ex(void *gpu, void *info, uint32_t *u) { int s; log_i2c("I2C_READ_EX", gpu, info, 0, 0); s = g_readEx(gpu, info, u); log_i2c("I2C_READ_EX", gpu, info, s, 1); return s; }
static int __cdecl spy_write(void *gpu, void *info) { int s; log_i2c("I2C_WRITE", gpu, info, 0, 0); s = g_write(gpu, info); log_i2c("I2C_WRITE", gpu, info, s, 1); return s; }
static int __cdecl spy_read(void *gpu, void *info) { int s; log_i2c("I2C_READ", gpu, info, 0, 0); s = g_read(gpu, info); log_i2c("I2C_READ", gpu, info, s, 1); return s; }

static BOOL load_real(void)
{
    char sys[MAX_PATH];
    if (g_real) return TRUE;
    GetSystemDirectoryA(sys, MAX_PATH);
#ifdef _WIN64
    strcat_s(sys, MAX_PATH, "\\nvapi64.dll");
#else
    strcat_s(sys, MAX_PATH, "\\nvapi.dll");   // 32-bit process: GetSystemDirectory is redirected to SysWOW64
#endif
    g_real = LoadLibraryA(sys);
    if (!g_real) return FALSE;
    g_query = (QueryFn)GetProcAddress(g_real, "nvapi_QueryInterface");
    g_direct = (DirectFn)GetProcAddress(g_real, "nvapi_Direct_GetMethod");
    return g_query != NULL;
}

__declspec(dllexport) void *__cdecl nvapi_QueryInterface(uint32_t id)
{
    void *p;
    int i, seen = 0;
    if (!load_real()) return NULL;
    p = g_query(id);
    EnterCriticalSection(&g_lock);
    for (i = 0; i < g_seenCount; i++) if (g_seen[i] == id) { seen = 1; break; }
    if (!seen && g_seenCount < 512) g_seen[g_seenCount++] = id;
    if (!seen && g_log) { stamp(); fprintf(g_log, "QueryInterface 0x%08X -> %s\n", id, p ? "ok" : "null"); fflush(g_log); }
    if (p)
    {
        if (id == ID_I2C_WRITE_EX) { g_writeEx = (I2cExFn)p; p = (void *)spy_write_ex; }
        else if (id == ID_I2C_READ_EX) { g_readEx = (I2cExFn)p; p = (void *)spy_read_ex; }
        else if (id == ID_I2C_WRITE) { g_write = (I2cFn)p; p = (void *)spy_write; }
        else if (id == ID_I2C_READ) { g_read = (I2cFn)p; p = (void *)spy_read; }
    }
    LeaveCriticalSection(&g_lock);
    return p;
}

__declspec(dllexport) void *__cdecl nvapi_Direct_GetMethod(void *a, void *b, void *c, void *d)
{
    if (!load_real() || !g_direct) return NULL;
    if (g_log) { EnterCriticalSection(&g_lock); stamp(); fprintf(g_log, "Direct_GetMethod called\n"); fflush(g_log); LeaveCriticalSection(&g_lock); }
    return g_direct(a, b, c, d);
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r)
{
    (void)h; (void)r;
    if (reason == DLL_PROCESS_ATTACH)
    {
        InitializeCriticalSection(&g_lock);
        open_log();
    }
    return TRUE;
}
