// izle: watch MSI's own I2C traffic to the graphics card, read-only, by attaching to MSI's lighting process as a
// debugger (GPU lighting proof, docs/GPU_ISIK_PLANI.md steps 1-2). x86 build: the target (LEDKeeper2.exe) is 32-bit.
//
//   izle.exe [process name, default LEDKeeper2.exe] [minutes, default 30]
//   izle.exe --test <pid>   attach to a test program and watch NvAPI_GPU_GetFullName instead (no I2C at all)
//
// How: NVIDIA's I2C functions are located in our own copy of nvapi (module + offset), the same module is found in the
// target, and a one-byte breakpoint (INT3) goes on each function's first instruction. When MSI calls one, its thread
// stops; we read the arguments (GPU handle, NV_I2C_INFO and the register and data bytes it points to) from MSI's
// memory, log them, put the original byte back, single-step that one instruction, re-arm, and let MSI continue. A
// second one-shot breakpoint on the return address logs the result (and the bytes a read returned).
// It never calls the card, never changes MSI's arguments, and injects no code. Stop: Ctrl+C, the file "dur" in the
// log folder, or the time limit; all breakpoints are removed and the debugger detaches (MSI keeps running).
//
// Log: C:\ProgramData\KontrolMerkezi-nvspy\izle-HHMMSS.txt

#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#define STATUS_WX86_SINGLE_STEP 0x4000001E
#define STATUS_WX86_BREAKPOINT 0x4000001F

typedef void *(__cdecl *QueryFn)(uint32_t id);

typedef struct { const char *name; uint32_t id; int kind; wchar_t module[MAX_PATH]; uintptr_t offset; uintptr_t addr; uint8_t orig; int armed; } Target;
enum { K_WRITE_EX, K_READ_EX, K_WRITE, K_READ, K_TEST };
static Target T[5] = {
    { "I2C_WRITE_EX", 0x283AC65A, K_WRITE_EX }, { "I2C_READ_EX", 0x4D7B0709, K_READ_EX },
    { "I2C_WRITE", 0xE812EB07, K_WRITE }, { "I2C_READ", 0x2FDE12C5, K_READ },
    { "GPU_GetFullName", 0xCEEE8E9F, K_TEST },
};
static int nT = 4;

typedef struct { DWORD tid; HANDLE h; int rearm; int target; uintptr_t ret; uint8_t retOrig; uintptr_t info; uintptr_t arg1; } Th;
static Th TH[256];
static int nTH;

static HANDLE hProc;
static FILE *L;
static volatile LONG stopFlag;
static int seenSystemBp;

static void stamp(void)
{
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(L, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
}
#define LOG(...) do { stamp(); fprintf(L, __VA_ARGS__); fprintf(L, "\n"); fflush(L); printf(__VA_ARGS__); printf("\n"); } while (0)

static BOOL rd(uintptr_t a, void *buf, SIZE_T n) { SIZE_T got = 0; return ReadProcessMemory(hProc, (LPCVOID)a, buf, n, &got) && got == n; }
static BOOL wr8(uintptr_t a, uint8_t v)
{
    DWORD old; SIZE_T n = 0; BOOL ok;
    if (!VirtualProtectEx(hProc, (LPVOID)a, 1, PAGE_EXECUTE_READWRITE, &old)) return FALSE;
    ok = WriteProcessMemory(hProc, (LPVOID)a, &v, 1, &n) && n == 1;
    VirtualProtectEx(hProc, (LPVOID)a, 1, old, &old);
    FlushInstructionCache(hProc, (LPCVOID)a, 1);
    return ok;
}

static Th *thread(DWORD tid)
{
    int i;
    for (i = 0; i < nTH; i++) if (TH[i].tid == tid) return &TH[i];
    if (nTH >= 256) return NULL;
    TH[nTH].tid = tid;
    TH[nTH].h = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
    TH[nTH].target = -1;
    return &TH[nTH++];
}

static void hexf(const uint8_t *p, uint32_t n)
{
    uint32_t i;
    for (i = 0; i < n && i < 256; i++) fprintf(L, "%02X%s", p[i], i + 1 < n ? " " : "");
}

// NV_I2C_INFO, x86 layout: version@0 displayMask@4 bIsDDCPort@8 i2cDevAddress@9 pbI2cRegAddress@12 regAddrSize@16
// pbData@20 cbSize@24 i2cSpeed@28 i2cSpeedKhz@32 portId@36 bIsPortIdSet@40
static void log_info(const char *what, uintptr_t gpu, uintptr_t info, int after, int readData, int status)
{
    uint8_t s[64] = { 0 }, reg[64] = { 0 }, data[256] = { 0 };
    uint32_t ver, size, pReg, nReg, pData, nData;
    if (!rd(info, s, 44)) { LOG("%s %s info=%p (unreadable)", what, after ? "SONRA" : "ONCE", (void *)info); return; }
    ver = *(uint32_t *)s; size = ver & 0xFFFF;
    pReg = *(uint32_t *)(s + 12); nReg = *(uint32_t *)(s + 16); pData = *(uint32_t *)(s + 20); nData = *(uint32_t *)(s + 24);
    if (nReg > 64) nReg = 64;
    if (nData > 256) nData = 256;
    if (nReg && pReg) rd(pReg, reg, nReg);
    if (nData && pData) rd(pData, data, nData);
    stamp();
    fprintf(L, "%s %s gpu=%08X ver=%u size=%u ddc=%u addr8=0x%02X addr7=0x%02X port=%u portSet=%u khz=%d mask=0x%X reg[%u]=",
            what, after ? "SONRA" : "ONCE", (unsigned)gpu, ver >> 16, size, s[8], s[9], s[9] >> 1, s[36], *(uint32_t *)(s + 40),
            *(int *)(s + 32), *(uint32_t *)(s + 4), nReg);
    hexf(reg, nReg);
    fprintf(L, " data[%u]=", nData);
    if (!after || readData) hexf(data, nData); else fprintf(L, "-");
    if (after) fprintf(L, " status=%d", status);
    fprintf(L, " raw=");
    hexf(s, 44);
    fprintf(L, "\n");
    fflush(L);
    printf("%s %s addr7=0x%02X reg=%02X n=%u%s\n", what, after ? "SONRA" : "ONCE", s[9] >> 1, nReg ? reg[0] : 0, nData, after ? (status ? " HATA" : " ok") : "");
}

// every address that ever held one of our INT3s: a thread may trap there just as we take the mark away
static uintptr_t ever[512];
static int nEver;
static void remember(uintptr_t a) { int i; for (i = 0; i < nEver; i++) if (ever[i] == a) return; if (nEver < 512) ever[nEver++] = a; }
static int was_ours(uintptr_t a) { int i; for (i = 0; i < nEver; i++) if (ever[i] == a) return 1; return 0; }
static int stopping;

static void arm_module(const wchar_t *path, uintptr_t base)
{
    int i;
    const wchar_t *name = wcsrchr(path, L'\\');
    name = name ? name + 1 : path;
    for (i = 0; i < nT; i++)
    {
        if (T[i].armed || _wcsicmp(name, T[i].module) != 0) continue;
        T[i].addr = base + T[i].offset;
        if (!rd(T[i].addr, &T[i].orig, 1)) { LOG("%s: okunamadi @%p", T[i].name, (void *)T[i].addr); continue; }
        if (wr8(T[i].addr, 0xCC)) { T[i].armed = 1; remember(T[i].addr); LOG("durma isareti: %s @ %ls+0x%X (%p), ilk bayt %02X", T[i].name, name, (unsigned)T[i].offset, (void *)T[i].addr, T[i].orig); }
        else LOG("%s: isaret konamadi (%lu)", T[i].name, GetLastError());
    }
}

static void arm_existing(DWORD pid)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    MODULEENTRY32W me = { sizeof(me) };
    if (snap == INVALID_HANDLE_VALUE) return;
    if (Module32FirstW(snap, &me)) do arm_module(me.szExePath, (uintptr_t)me.modBaseAddr); while (Module32NextW(snap, &me));
    CloseHandle(snap);
}

static int find_target(uintptr_t a) { int i; for (i = 0; i < nT; i++) if (T[i].addr && T[i].addr == a) return i; return -1; }



static BOOL WINAPI onCtrl(DWORD c) { (void)c; InterlockedExchange(&stopFlag, 1); return TRUE; }

static DWORD find_pid(const wchar_t *exe)
{
    PROCESSENTRY32W pe = { sizeof(pe) };
    DWORD pid = 0;
    HANDLE s = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (Process32FirstW(s, &pe)) do if (_wcsicmp(pe.szExeFile, exe) == 0) { pid = pe.th32ProcessID; break; } while (Process32NextW(s, &pe));
    CloseHandle(s);
    return pid;
}

// stop, phase 1: take every mark away (original bytes back); events keep being handled until no thread is mid-step
static void disarm(void)
{
    int i;
    for (i = 0; i < nT; i++) if (T[i].armed) { wr8(T[i].addr, T[i].orig); T[i].armed = 0; }
    for (i = 0; i < nTH; i++) if (TH[i].ret) { wr8(TH[i].ret, TH[i].retOrig); TH[i].ret = 0; TH[i].target = -1; }
    LOG("isaretler kaldirildi; bekleyen adimlar bitince ayrilacak");
}
static int pending(void) { int i; for (i = 0; i < nTH; i++) if (TH[i].rearm) return 1; return 0; }

int wmain(int argc, wchar_t **argv)
{
    wchar_t exe[MAX_PATH] = L"LEDKeeper2.exe", sys[MAX_PATH], logp[MAX_PATH], durp[MAX_PATH];
    int minutes = 30, test = 0, i;
    DWORD pid = 0, start;
    HMODULE nv;
    QueryFn q;
    SYSTEMTIME st;

    if (argc > 1 && wcscmp(argv[1], L"--test") == 0) { test = 1; pid = argc > 2 ? (DWORD)_wtoi(argv[2]) : 0; minutes = 2; }
    else { if (argc > 1) wcscpy_s(exe, MAX_PATH, argv[1]); if (argc > 2) minutes = _wtoi(argv[2]); }
    if (test) { T[0] = T[4]; nT = 1; }

    CreateDirectoryW(L"C:\\ProgramData\\KontrolMerkezi-nvspy", NULL);
    GetLocalTime(&st);
    swprintf_s(logp, MAX_PATH, L"C:\\ProgramData\\KontrolMerkezi-nvspy\\izle-%02d%02d%02d.txt", st.wHour, st.wMinute, st.wSecond);
    wcscpy_s(durp, MAX_PATH, L"C:\\ProgramData\\KontrolMerkezi-nvspy\\dur");
    DeleteFileW(durp);
    L = _wfsopen(logp, L"a", 0x40 /* _SH_DENYNO */);
    if (!L) { printf("kayit acilamadi\n"); return 1; }
    SetConsoleCtrlHandler(onCtrl, TRUE);

    // where the functions live, in our own copy of NVIDIA's DLL
    GetSystemDirectoryW(sys, MAX_PATH);
    wcscat_s(sys, MAX_PATH, L"\\nvapi.dll");
    nv = LoadLibraryW(sys);
    q = nv ? (QueryFn)GetProcAddress(nv, "nvapi_QueryInterface") : NULL;
    if (!q) { LOG("nvapi.dll yuklenemedi"); return 1; }
    for (i = 0; i < nT; i++)
    {
        HMODULE m = NULL;
        void *p = q(T[i].id);
        wchar_t full[MAX_PATH], *base;
        if (!p || !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)p, &m)) { LOG("%s bulunamadi", T[i].name); continue; }
        GetModuleFileNameW(m, full, MAX_PATH);
        base = wcsrchr(full, L'\\');
        wcscpy_s(T[i].module, MAX_PATH, base ? base + 1 : full);
        T[i].offset = (uintptr_t)p - (uintptr_t)m;
        LOG("%s: %ls+0x%X", T[i].name, T[i].module, (unsigned)T[i].offset);
    }

    {
        // attaching to a service process (LEDKeeper2 runs as SYSTEM) needs the debug privilege an administrator holds
        HANDLE tok; TOKEN_PRIVILEGES tp = { 1 };
        if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &tok))
        {
            LookupPrivilegeValueW(NULL, L"SeDebugPrivilege", &tp.Privileges[0].Luid);
            tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
            AdjustTokenPrivileges(tok, FALSE, &tp, 0, NULL, NULL);
            CloseHandle(tok);
        }
    }
    if (!pid) pid = find_pid(exe);
    if (!pid) { LOG("surec bulunamadi: %ls", exe); return 2; }
    if (!DebugActiveProcess(pid)) { LOG("baglanilamadi (pid %lu): hata %lu (yonetici gerekir)", pid, GetLastError()); return 3; }
    DebugSetProcessKillOnExit(FALSE);
    LOG("baglandi: %ls pid %lu; sure %d dk; durdurmak icin Ctrl+C ya da %ls dosyasi", exe, pid, minutes, durp);
    start = GetTickCount();

    for (;;)
    {
        DEBUG_EVENT ev;
        DWORD cont = DBG_CONTINUE;
        static DWORD stopAt;
        if (!stopping && (stopFlag || GetFileAttributesW(durp) != INVALID_FILE_ATTRIBUTES || GetTickCount() - start > (DWORD)minutes * 60000u))
        {
            disarm();
            stopping = 1;
            stopAt = GetTickCount();
        }
        if (stopping && !pending() && GetTickCount() - stopAt > 800)
        {
            DebugActiveProcessStop(pid);
            LOG("ayrildi: tum isaretler kaldirildi, surec calismaya devam ediyor");
            break;
        }
        if (!WaitForDebugEvent(&ev, 200)) continue;
        switch (ev.dwDebugEventCode)
        {
        case CREATE_PROCESS_DEBUG_EVENT:
            hProc = ev.u.CreateProcessInfo.hProcess;
            if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
            thread(ev.dwThreadId);
            break;
        case CREATE_THREAD_DEBUG_EVENT:
            thread(ev.dwThreadId);
            break;
        case LOAD_DLL_DEBUG_EVENT:
        {
            wchar_t path[MAX_PATH] = L"";
            if (ev.u.LoadDll.hFile)
            {
                GetFinalPathNameByHandleW(ev.u.LoadDll.hFile, path, MAX_PATH, 0);
                CloseHandle(ev.u.LoadDll.hFile);
            }
            if (path[0]) arm_module(path, (uintptr_t)ev.u.LoadDll.lpBaseOfDll);
            break;
        }
        case EXCEPTION_DEBUG_EVENT:
        {
            DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
            uintptr_t a = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
            Th *t = thread(ev.dwThreadId);
            cont = DBG_EXCEPTION_NOT_HANDLED;
            if (code == EXCEPTION_BREAKPOINT || code == STATUS_WX86_BREAKPOINT)
            {
                int k = find_target(a);
                if (!seenSystemBp && k < 0) { seenSystemBp = 1; arm_existing(pid); cont = DBG_CONTINUE; break; }
                if (stopping || (k >= 0 && !T[k].armed) || (k < 0 && was_ours(a) && !(t && t->ret == a)))
                {
                    // a trap on a mark we already took away: step back onto the original instruction and go on
                    if (was_ours(a) && t && t->h)
                    {
                        CONTEXT c = { 0 };
                        c.ContextFlags = CONTEXT_FULL;
                        GetThreadContext(t->h, &c);
                        c.Eip = (DWORD)a;
                        SetThreadContext(t->h, &c);
                    }
                    cont = DBG_CONTINUE;
                    break;
                }
                if (k >= 0 && t && t->h)
                {
                    CONTEXT c = { 0 };
                    uint32_t stack[3] = { 0 };
                    c.ContextFlags = CONTEXT_FULL;
                    GetThreadContext(t->h, &c);
                    rd(c.Esp, stack, sizeof(stack));     // [ret, arg1 (gpu), arg2 (info)]
                    if (T[k].kind == K_TEST) LOG("%s ONCE tid=%lu gpu=%08X ad-tamponu=%08X donus=%08X", T[k].name, ev.dwThreadId, stack[1], stack[2], stack[0]);
                    else log_info(T[k].name, stack[1], stack[2], 0, 0, 0);
                    // one-shot breakpoint on the return address, for the result
                    if (!t->ret && rd(stack[0], &t->retOrig, 1) && wr8(stack[0], 0xCC)) { remember(stack[0]); t->ret = stack[0]; t->target = k; t->info = stack[2]; t->arg1 = stack[1]; }
                    // run the original first instruction once, then re-arm
                    wr8(a, T[k].orig);
                    c.Eip = (DWORD)a;
                    c.EFlags |= 0x100;
                    SetThreadContext(t->h, &c);
                    t->rearm = k + 1;
                    cont = DBG_CONTINUE;
                }
                else if (t && t->ret && a == t->ret)
                {
                    CONTEXT c = { 0 };
                    int k2 = t->target;
                    c.ContextFlags = CONTEXT_FULL;
                    GetThreadContext(t->h, &c);
                    wr8(t->ret, t->retOrig);
                    c.Eip = (DWORD)a;
                    SetThreadContext(t->h, &c);
                    if (k2 >= 0)
                    {
                        if (T[k2].kind == K_TEST) LOG("%s SONRA tid=%lu status=%d", T[k2].name, ev.dwThreadId, (int)c.Eax);
                        else log_info(T[k2].name, t->arg1, t->info, 1, T[k2].kind == K_READ_EX || T[k2].kind == K_READ, (int)c.Eax);
                    }
                    t->ret = 0; t->target = -1;
                    cont = DBG_CONTINUE;
                }
                else cont = DBG_CONTINUE;   // a breakpoint that is not ours (e.g. the attach breakpoints): step over it
            }
            else if ((code == EXCEPTION_SINGLE_STEP || code == STATUS_WX86_SINGLE_STEP) && t && t->rearm)
            {
                int k = t->rearm - 1;
                if (T[k].armed && !stopping) wr8(T[k].addr, 0xCC);
                t->rearm = 0;
                cont = DBG_CONTINUE;
            }
            break;
        }
        case EXIT_PROCESS_DEBUG_EVENT:
            LOG("surec sona erdi");
            ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, DBG_CONTINUE);
            fclose(L);
            return 0;
        }
        ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, cont);
    }
    fclose(L);
    return 0;
}
