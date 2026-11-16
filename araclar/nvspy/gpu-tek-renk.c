// gpu-tek-renk: step 4 of the GPU lighting proof (docs/GPU_ISIK_PLANI.md). Sends ONE static colour to the RTX 4080's
// lighting with exactly the sequence MSI's own Mystic Light was recorded sending on 2026-11-16
// (docs/gpu-kayit/msi-mystic-light-2026-11-16.txt), WITHOUT the save register 0x3F. Then a full power off shows whether
// the colour was volatile: the card must come up in its saved state (dark), not in this colour.
//
//   gpu-tek-renk.exe --karta-yaz   static blue (00 00 FF); without that exact argument it writes nothing
//
// Built x86 so the NV_I2C_INFO it hands to the driver is byte-for-byte the layout MSI's 32-bit process used
// (version 0x0003002C, address 0xD0 = 7-bit 0x68, port 1 set, 400 kHz, i2cSpeed 0xFFFF). Refuses to run unless the
// GPU is 10DE:2704 with MSI subsystem 1462:5111. Can only write the registers MSI wrote for a colour apply; 0x3F (save)
// is impossible by construction. Each write is logged to C:\ProgramData\KontrolMerkezi-nvspy\gpu-tek-renk.txt.

#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

typedef void *(__cdecl *QueryFn)(uint32_t);
typedef int(__cdecl *InitFn)(void);
typedef int(__cdecl *EnumFn)(void **, int *);
typedef int(__cdecl *PciFn)(void *, uint32_t *, uint32_t *, uint32_t *, uint32_t *);
typedef int(__cdecl *I2cExFn)(void *, void *, uint32_t *);

#pragma pack(push, 4)
typedef struct
{
    uint32_t version;       // 0x0003002C
    uint32_t displayMask;   // 0
    uint8_t bIsDDCPort;     // 0
    uint8_t i2cDevAddress;  // 0xD0
    uint8_t *pbI2cRegAddress;
    uint32_t regAddrSize;   // 1
    uint8_t *pbData;
    uint32_t cbSize;        // 1
    uint32_t i2cSpeed;      // 0xFFFF (deprecated field, as MSI)
    int32_t i2cSpeedKhz;    // 6 = 400 kHz, as MSI
    uint8_t portId;         // 1
    uint32_t bIsPortIdSet;  // 1
} I2cInfo;
#pragma pack(pop)

static const uint8_t ALLOWED[] = { 0x2D, 0x22, 0x36, 0x38, 0x30, 0x31, 0x32 };
static FILE *L;

static int allowed(uint8_t r)
{
    size_t i;
    if (r == 0x3F) return 0;
    for (i = 0; i < sizeof(ALLOWED); i++) if (ALLOWED[i] == r) return 1;
    return 0;
}

static int write_reg(I2cExFn w, void *gpu, uint8_t reg, uint8_t val)
{
    I2cInfo info;
    uint8_t r = reg, v = val;
    uint32_t unknown = 0;
    int s;
    if (!allowed(reg)) { fprintf(L, "REDDEDILDI reg %02X\n", reg); fflush(L); return -999; }
    memset(&info, 0, sizeof(info));
    info.version = (uint32_t)sizeof(info) | (3u << 16);
    info.i2cDevAddress = 0xD0;
    info.pbI2cRegAddress = &r;
    info.regAddrSize = 1;
    info.pbData = &v;
    info.cbSize = 1;
    info.i2cSpeed = 0xFFFF;
    info.i2cSpeedKhz = 6;
    info.portId = 1;
    info.bIsPortIdSet = 1;
    s = w(gpu, &info, &unknown);
    {
        SYSTEMTIME t; GetLocalTime(&t);
        fprintf(L, "%02d:%02d:%02d.%03d yaz 0x68 port1 reg=%02X data=%02X status=%d\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, reg, val, s);
        fflush(L);
    }
    printf("reg %02X = %02X -> %d\n", reg, val, s);
    return s;
}

int main(int argc, char **argv)
{
    // 11-16: an earlier build wrote on any argument and was run by mistake; writing now needs this exact word.
    if (argc < 2 || strcmp(argv[1], "--karta-yaz") != 0)
    {
        printf("Karta yazmak icin: gpu-tek-renk.exe --karta-yaz   (Ozcan'in onayiyla; bkz. docs/GPU_ISIK_PLANI.md)\n");
        return 1;
    }
    char sys[MAX_PATH];
    void *gpus[64], *gpu = NULL;
    int n = 0, i;
    QueryFn q;
    PciFn pci;
    I2cExFn w;

    if (sizeof(I2cInfo) != 44) { printf("yapi boyu %u, 44 olmali; durduruldu\n", (unsigned)sizeof(I2cInfo)); return 9; }
    CreateDirectoryA("C:\\ProgramData\\KontrolMerkezi-nvspy", NULL);
    fopen_s(&L, "C:\\ProgramData\\KontrolMerkezi-nvspy\\gpu-tek-renk.txt", "a");
    if (!L) return 8;
    GetSystemDirectoryA(sys, MAX_PATH);
    strcat_s(sys, MAX_PATH, "\\nvapi.dll");
    q = (QueryFn)GetProcAddress(LoadLibraryA(sys), "nvapi_QueryInterface");
    if (!q) { fprintf(L, "nvapi yok\n"); return 2; }
    if (((InitFn)q(0x0150E828))() != 0) { fprintf(L, "NvAPI_Initialize basarisiz\n"); return 3; }
    ((EnumFn)q(0xE5AC921F))(gpus, &n);
    pci = (PciFn)q(0x2DDFB66E);
    for (i = 0; i < n; i++)
    {
        uint32_t dev = 0, sub = 0, rev = 0, ext = 0;
        if (pci(gpus[i], &dev, &sub, &rev, &ext) == 0 && dev == 0x270410DE && sub == 0x51111462) gpu = gpus[i];
        fprintf(L, "GPU %d: aygit %08X alt %08X\n", i, dev, sub);
    }
    if (!gpu) { fprintf(L, "RTX 4080 / MSI 5111 bulunamadi; hicbir sey yazilmadi\n"); printf("kart dogrulanamadi, yazilmadi\n"); return 4; }
    w = (I2cExFn)q(0x283AC65A);
    if (!w) return 5;

    fprintf(L, "== adim 4: tek statik renk (mavi), MSI'in sirasi, 0x3F YOK\n");
    {
        // MSI 11:03:17 (red) with the colour bytes changed to blue; ~30 ms apart as MSI
        const uint8_t seq[][2] = { { 0x2D, 0x00 }, { 0x22, 0x1C }, { 0x36, 0x50 }, { 0x38, 0x02 }, { 0x30, 0x00 }, { 0x31, 0x00 }, { 0x32, 0xFF }, { 0x22, 0x13 } };
        int k;
        for (k = 0; k < 8; k++)
        {
            int s = write_reg(w, gpu, seq[k][0], seq[k][1]);
            if (s != 0) { fprintf(L, "hata, durduruldu (adim %d)\n", k); printf("hata, durduruldu\n"); return 6; }
            Sleep(30);
        }
    }
    fprintf(L, "== bitti: 8 yazma, kaydetme (0x3F) gonderilmedi\n");
    fclose(L);
    printf("bitti: kart mavi olmali; kaydetme gonderilmedi\n");
    return 0;
}
