// nvtest: a harmless 32-bit target for testing izle.exe. Asks NVIDIA's driver for the GPU's name once a second
// (NvAPI_GPU_GetFullName, read-only, no I2C) and prints whether it changed, for 40 s.
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
typedef void *(__cdecl *QueryFn)(uint32_t);
typedef int(__cdecl *InitFn)(void);
typedef int(__cdecl *EnumFn)(void **, int *);
typedef int(__cdecl *NameFn)(void *, char *);
int main(void)
{
    char sys[MAX_PATH], name[64], first[64] = "";
    int n = 0, i, same = 1;
    void *gpus[64];
    GetSystemDirectoryA(sys, MAX_PATH);
    strcat_s(sys, MAX_PATH, "\\nvapi.dll");
    QueryFn q = (QueryFn)GetProcAddress(LoadLibraryA(sys), "nvapi_QueryInterface");
    ((InitFn)q(0x0150E828))();
    ((EnumFn)q(0xE5AC921F))(gpus, &n);
    NameFn getName = (NameFn)q(0xCEEE8E9F);
    printf("pid %lu, %d GPU\n", GetCurrentProcessId(), n);
    fflush(stdout);
    for (i = 0; i < 40; i++)
    {
        int s = getName(gpus[0], name);
        if (!first[0]) strcpy_s(first, 64, name);
        if (strcmp(first, name) != 0) same = 0;
        printf("%2d status=%d ad=%s\n", i, s, name);
        fflush(stdout);
        Sleep(1000);
    }
    printf("sonuc: %s\n", same ? "her cagri ayni ve dogru sonucu verdi" : "SONUC DEGISTI");
    return 0;
}
