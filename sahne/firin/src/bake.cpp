// The oven's host side: the OptiX pipeline (NVRTC, OptiX 9.1, exactly as pc_graphics' Denizaltı oven sets it up),
// the texels in batches traced in short launches, the firefly clamp, the edge-keeping filter, the padding and the
// encoding into the pack's planes; then the volumes. docs/SALON.md "The pack" has the formats.
#include "bake.h"

#include "atlas.h"
#include "bake_shared.h"

#include <cuda_runtime.h>
#include <nvrtc.h>
#include <optix.h>
#include <optix_function_table_definition.h>
#include <optix_stack_size.h>
#include <optix_stubs.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace salon {

static_assert(GROUP_COUNT == SALON_GROUPS, "bake_shared.h's SALON_GROUPS must match the scene's light groups");

namespace {

using Clock = std::chrono::steady_clock;
constexpr float kY0 = 0.282095f, kY1 = 0.488603f;
constexpr size_t kBudget = size_t(6) << 30;   // the oven's GPU memory at most (the card is also Özcan's desk)
constexpr int kChannels = GROUP_COUNT * 6 + 1;   // per texel: per group L0 rgb, L1 xyz; then the openness

struct __align__(OPTIX_SBT_RECORD_ALIGNMENT) Record {
    char header[OPTIX_SBT_RECORD_HEADER_SIZE];
};

std::string readText(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

void optixLog(unsigned level, const char* tag, const char* msg, void*) {
    if (level <= 2) std::fprintf(stderr, "[optix %u][%s] %s\n", level, tag, msg);
}

void ck(cudaError_t e, const char* what) {
    if (e != cudaSuccess) throw std::runtime_error(std::string("CUDA ") + what + ": " + cudaGetErrorString(e));
}
void ok(OptixResult r, const char* what) {
    if (r != OPTIX_SUCCESS) throw std::runtime_error(std::string("OptiX ") + what + ": " + optixGetErrorString(r));
}
#define CK(x) ck((x), #x)
#define OK(x) ok((x), #x)

float luminance(float r, float g, float b) { return 0.2126f * r + 0.7152f * g + 0.0722f * b; }

// everything the oven holds on the card, released in the right order whatever happens
struct Gpu {
    OptixDeviceContext ctx = nullptr;
    OptixModule module = nullptr;
    OptixProgramGroup groups[5] = {};
    OptixPipeline pipe = nullptr;
    std::vector<std::pair<void*, size_t>> buffers;
    size_t bytes = 0, peak = 0;

    void* alloc(size_t n) {
        n = std::max<size_t>(n, 16);
        size_t freeB = 0, total = 0;
        CK(cudaMemGetInfo(&freeB, &total));
        if (bytes + n > kBudget || n > freeB / 10 * 8) {
            char m[200];
            std::snprintf(m, sizeof(m), "GPU memory: %.0f MiB more would pass the oven's budget (%.0f MiB held, %.0f MiB free)",
                          n / 1048576.0, bytes / 1048576.0, freeB / 1048576.0);
            throw std::runtime_error(m);
        }
        void* p = nullptr;
        CK(cudaMalloc(&p, n));
        buffers.push_back({p, n});
        bytes += n;
        peak = std::max(peak, bytes);
        return p;
    }
    void release(void* p) {
        for (auto& b : buffers)
            if (b.first == p) {
                cudaFree(p);
                bytes -= b.second;
                b.first = nullptr;
            }
    }
    template <class T>
    T* upload(const std::vector<T>& v) {
        T* p = static_cast<T*>(alloc(std::max<size_t>(1, v.size()) * sizeof(T)));
        if (!v.empty()) CK(cudaMemcpy(p, v.data(), v.size() * sizeof(T), cudaMemcpyHostToDevice));
        return p;
    }
    ~Gpu() {
        cudaDeviceSynchronize();
        for (auto& b : buffers)
            if (b.first) cudaFree(b.first);
        if (pipe) optixPipelineDestroy(pipe);
        for (auto g : groups)
            if (g) optixProgramGroupDestroy(g);
        if (module) optixModuleDestroy(module);
        if (ctx) optixDeviceContextDestroy(ctx);
    }
};

std::string compileDevice(const BakeOptions& o) {
    const std::string src = readText(o.root + "/device/salon_bake.cu");
    if (src.empty()) throw std::runtime_error("cannot read " + o.root + "/device/salon_bake.cu");
    nvrtcProgram prog = nullptr;
    nvrtcCreateProgram(&prog, src.c_str(), "salon_bake.cu", 0, nullptr, nullptr);
    const std::string inc[] = {"-I" + o.root + "/src", "-I" + o.thirdParty + "/optix/include", "-I" + o.thirdParty + "/cuda/include"};
    std::vector<const char*> opts = {"--std=c++17", "-arch=compute_89", "--use_fast_math", "--relocatable-device-code=true",
                                     "--optix-ir", "-lineinfo", "-D__x86_64"};
    for (const auto& s : inc) opts.push_back(s.c_str());
    const nvrtcResult cr = nvrtcCompileProgram(prog, int(opts.size()), opts.data());
    size_t ls = 0;
    nvrtcGetProgramLogSize(prog, &ls);
    std::string log(ls, '\0');
    if (ls > 1) nvrtcGetProgramLog(prog, log.data());
    if (cr != NVRTC_SUCCESS) {
        nvrtcDestroyProgram(&prog);
        throw std::runtime_error("NVRTC: " + log);
    }
    size_t irSize = 0;
    nvrtcGetOptiXIRSize(prog, &irSize);
    std::string ir(irSize, '\0');
    nvrtcGetOptiXIR(prog, ir.data());
    nvrtcDestroyProgram(&prog);
    return ir;
}

// a per-texel value in a half float: NaN and Inf counted and zeroed, beyond half's range counted and clamped
struct Guard {
    size_t bad = 0;
    float operator()(float x) {
        if (!std::isfinite(x)) { ++bad; return 0.0f; }
        if (std::fabs(x) > 65504.0f) { ++bad; return std::clamp(x, -65504.0f, 65504.0f); }
        return x;
    }
};

// the edge-keeping filter inside each chart (Denizaltı's): 5 x 5 texels weighted by distance and by how alike the
// guide is (a shadow's edge stays); per group, guided by that group's L0 luminance; the openness by itself
void filterPage(const Atlas& a, const Raster& r, std::vector<float>& values) {
    const std::vector<float> src = values;
    const int64_t n = int64_t(r.texels.size());
    const int radius = 2;
    auto guide = [&](int64_t i, int g) {
        const float* v = &src[size_t(i) * kChannels];
        return g < GROUP_COUNT ? luminance(v[g * 6], v[g * 6 + 1], v[g * 6 + 2]) : v[GROUP_COUNT * 6];
    };
#pragma omp parallel for schedule(dynamic, 1024)
    for (int64_t i = 0; i < n; ++i) {
        const Texel& t = r.texels[size_t(i)];
        const int x = int(t.pixel % uint32_t(a.width)), y = int(t.pixel / uint32_t(a.width));
        for (int g = 0; g <= GROUP_COUNT; ++g) {   // g = GROUP_COUNT: the openness
            const int first = g < GROUP_COUNT ? g * 6 : GROUP_COUNT * 6, count = g < GROUP_COUNT ? 6 : 1;
            const float g0 = guide(i, g);
            float sum[6] = {}, ws = 0.0f;
            for (int dy = -radius; dy <= radius; ++dy)
                for (int dx = -radius; dx <= radius; ++dx) {
                    const int xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= a.width || yy >= a.height) continue;
                    const int32_t j = r.index[size_t(yy) * a.width + xx];
                    if (j < 0 || r.texels[size_t(j)].chart != t.chart) continue;
                    const float gj = guide(j, g);
                    const float rel = (gj - g0) / (0.25f * (gj + g0) + 1e-6f);
                    const float w = std::exp(-0.35f * float(dx * dx + dy * dy) - rel * rel);
                    for (int q = 0; q < count; ++q) sum[q] += w * src[size_t(j) * kChannels + first + q];
                    ws += w;
                }
            for (int q = 0; q < count; ++q) values[size_t(i) * kChannels + first + q] = sum[q] / ws;
        }
    }
}

}   // namespace

uint16_t toHalf(float f) {
    uint32_t x;
    std::memcpy(&x, &f, 4);
    const uint32_t sign = (x >> 16) & 0x8000u;
    const int32_t e = int32_t((x >> 23) & 0xFF) - 127 + 15;
    uint32_t m = x & 0x7FFFFFu;
    if (((x >> 23) & 0xFF) == 0xFF) return uint16_t(sign | 0x7C00u | (m ? 0x200u : 0));
    if (e >= 31) return uint16_t(sign | 0x7C00u);
    if (e <= 0) {   // subnormal
        if (e < -10) return uint16_t(sign);
        m |= 0x800000u;
        const uint32_t shift = uint32_t(14 - e);
        uint32_t h = m >> shift;
        if ((m >> (shift - 1)) & 1u) ++h;   // round half up
        return uint16_t(sign | h);
    }
    uint32_t h = sign | (uint32_t(e) << 10) | (m >> 13);
    if (m & 0x1000u) ++h;   // round half up (a carry into the exponent is right)
    return uint16_t(h);
}

float fromHalf(uint16_t h) {
    const uint32_t sign = uint32_t(h & 0x8000u) << 16;
    uint32_t e = (h >> 10) & 0x1F, m = h & 0x3FFu, x;
    if (e == 0) {
        if (!m) {
            x = sign;
        } else {
            e = 1;
            while (!(m & 0x400u)) { m <<= 1; --e; }
            m &= 0x3FFu;
            x = sign | ((e + 127 - 15) << 23) | (m << 13);
        }
    } else if (e == 31) {
        x = sign | 0x7F800000u | (m << 13);
    } else {
        x = sign | ((e + 127 - 15) << 23) | (m << 13);
    }
    float f;
    std::memcpy(&f, &x, 4);
    return f;
}

bool bake(const Scene& s, const Atlas& a, const std::vector<int>& chartPage, const BakeOptions& o, Baked& out, std::string& err,
          const std::function<void(float, const std::string&)>& progress) {
    try {
        if (o.samples < 1 || o.volSamples < 1 || o.bounces < 0 || o.bounces > 32)
            throw std::runtime_error("samples must be >= 1 and bounces 0..32");
        const auto t0 = Clock::now();
        auto seconds = [](Clock::time_point a0) { return std::chrono::duration<double>(Clock::now() - a0).count(); };
        auto say = [&](float f, const std::string& line) {
            if (progress) progress(f, line);
        };
        const Mesh& m = s.mesh;
        Gpu gpu;
        CK(cudaFree(nullptr));
        OK(optixInit());
        OptixDeviceContextOptions co{};
        co.logCallbackFunction = optixLog;
        co.logCallbackLevel = 4;
        OK(optixDeviceContextCreate(nullptr, &co, &gpu.ctx));

        // ---- the device program
        const std::string ir = compileDevice(o);
        OptixModuleCompileOptions mco{};
        mco.optLevel = OPTIX_COMPILE_OPTIMIZATION_DEFAULT;
        mco.debugLevel = OPTIX_COMPILE_DEBUG_LEVEL_MINIMAL;
        OptixPipelineCompileOptions pco{};
        pco.traversableGraphFlags = OPTIX_TRAVERSABLE_GRAPH_FLAG_ALLOW_SINGLE_GAS;
        pco.numPayloadValues = 2;
        pco.numAttributeValues = 2;
        pco.exceptionFlags = OPTIX_EXCEPTION_FLAG_NONE;
        pco.pipelineLaunchParamsVariableName = "params";
        pco.pipelineLaunchParamsSizeInBytes = sizeof(SalonParams);
        pco.usesPrimitiveTypeFlags = OPTIX_PRIMITIVE_TYPE_FLAGS_TRIANGLE;
        char olog[8192];
        size_t olen = sizeof(olog);
        if (optixModuleCreate(gpu.ctx, &mco, &pco, ir.data(), ir.size(), olog, &olen, &gpu.module) != OPTIX_SUCCESS)
            throw std::runtime_error(std::string("optixModuleCreate: ") + olog);
        OptixProgramGroupDesc d[5] = {};
        d[0].kind = OPTIX_PROGRAM_GROUP_KIND_RAYGEN;
        d[0].raygen.module = gpu.module;
        d[0].raygen.entryFunctionName = "__raygen__bake";
        d[1].kind = OPTIX_PROGRAM_GROUP_KIND_MISS;
        d[2].kind = OPTIX_PROGRAM_GROUP_KIND_HITGROUP;
        d[3].kind = OPTIX_PROGRAM_GROUP_KIND_RAYGEN;
        d[3].raygen.module = gpu.module;
        d[3].raygen.entryFunctionName = "__raygen__volume";
        d[4].kind = OPTIX_PROGRAM_GROUP_KIND_RAYGEN;
        d[4].raygen.module = gpu.module;
        d[4].raygen.entryFunctionName = "__raygen__place";
        OptixProgramGroupOptions go{};
        olen = sizeof(olog);
        OK(optixProgramGroupCreate(gpu.ctx, d, 5, &go, olog, &olen, gpu.groups));
        OptixPipelineLinkOptions lo{};
        lo.maxTraceDepth = 1;
        olen = sizeof(olog);
        OK(optixPipelineCreate(gpu.ctx, &pco, &lo, gpu.groups, 5, olog, &olen, &gpu.pipe));
        OK(optixPipelineSetStackSizeFromCallDepths(gpu.pipe, 1, 0, 0, 0, 1));
        CUdeviceptr rec[5] = {};   // the programs: bake, miss, hit, volume, place
        for (int i = 0; i < 5; ++i) {
            Record r{};
            OK(optixSbtRecordPackHeader(gpu.groups[i], &r));
            rec[i] = CUdeviceptr(gpu.alloc(sizeof(Record)));
            CK(cudaMemcpy(reinterpret_cast<void*>(rec[i]), &r, sizeof(Record), cudaMemcpyHostToDevice));
        }
        OptixShaderBindingTable sbt{};
        sbt.raygenRecord = rec[0];
        sbt.missRecordBase = rec[1];
        sbt.missRecordStrideInBytes = sizeof(Record);
        sbt.missRecordCount = 1;
        sbt.hitgroupRecordBase = rec[2];
        sbt.hitgroupRecordStrideInBytes = sizeof(Record);
        sbt.hitgroupRecordCount = 1;

        // ---- the ray structure: every triangle but the ones that do not occlude (stencil paint, decals)
        std::vector<float3> pos(m.v.size());
        std::vector<float4> nrm(m.v.size());
        for (size_t i = 0; i < m.v.size(); ++i) {
            pos[i] = m.v[i].p;
            nrm[i] = make_float4(m.v[i].n.x, m.v[i].n.y, m.v[i].n.z, 0.0f);
        }
        std::vector<uint3> tri;
        std::vector<unsigned> tmat, tpage;
        std::vector<float2> uv2(m.v.size());
        for (size_t i = 0; i < m.v.size(); ++i) uv2[i] = m.v[i].uv2;
        tri.reserve(m.tris());
        for (size_t k = 0; k + 2 < m.idx.size(); k += 3) {
            const uint32_t mt = m.v[m.idx[k]].mat;
            if (mt >= s.mats.size()) throw std::runtime_error("a triangle's material is out of range");
            if (s.mats[mt].flags & MF_NO_OCCLUDE) continue;
            tri.push_back(make_uint3(m.idx[k], m.idx[k + 1], m.idx[k + 2]));
            tmat.push_back(mt);
            tpage.push_back(unsigned(std::max(0, chartPage[m.v[m.idx[k]].chart])));
        }
        if (tri.empty()) throw std::runtime_error("nothing to trace: the scene has no occluding triangle");
        float3* dPos = gpu.upload(pos);
        float4* dNrm = gpu.upload(nrm);
        uint3* dTri = gpu.upload(tri);
        unsigned* dMat = gpu.upload(tmat);
        OptixBuildInput bi{};
        bi.type = OPTIX_BUILD_INPUT_TYPE_TRIANGLES;
        CUdeviceptr vb = CUdeviceptr(dPos);
        bi.triangleArray.vertexFormat = OPTIX_VERTEX_FORMAT_FLOAT3;
        bi.triangleArray.vertexStrideInBytes = sizeof(float3);
        bi.triangleArray.numVertices = unsigned(pos.size());
        bi.triangleArray.vertexBuffers = &vb;
        bi.triangleArray.indexFormat = OPTIX_INDICES_FORMAT_UNSIGNED_INT3;
        bi.triangleArray.indexStrideInBytes = sizeof(uint3);
        bi.triangleArray.numIndexTriplets = unsigned(tri.size());
        bi.triangleArray.indexBuffer = CUdeviceptr(dTri);
        const unsigned flags[1] = {OPTIX_GEOMETRY_FLAG_DISABLE_ANYHIT};
        bi.triangleArray.flags = flags;
        bi.triangleArray.numSbtRecords = 1;
        OptixAccelBuildOptions ao{};
        ao.buildFlags = OPTIX_BUILD_FLAG_PREFER_FAST_TRACE | OPTIX_BUILD_FLAG_ALLOW_RANDOM_VERTEX_ACCESS;
        ao.operation = OPTIX_BUILD_OPERATION_BUILD;
        OptixAccelBufferSizes sizes{};
        OK(optixAccelComputeMemoryUsage(gpu.ctx, &ao, &bi, 1, &sizes));
        void* temp = gpu.alloc(sizes.tempSizeInBytes);
        void* gas = gpu.alloc(sizes.outputSizeInBytes);
        OptixTraversableHandle handle = 0;
        OK(optixAccelBuild(gpu.ctx, nullptr, &ao, &bi, 1, CUdeviceptr(temp), sizes.tempSizeInBytes, CUdeviceptr(gas),
                           sizes.outputSizeInBytes, &handle, nullptr, 0));
        CK(cudaDeviceSynchronize());
        gpu.release(temp);

        // ---- materials, emitters, rotors
        std::vector<BakeMat> mats;
        for (const auto& mt : s.mats) mats.push_back({mt.meanAlbedo, (mt.flags & MF_EMISSIVE) ? BM_EMISSIVE : 0u});
        std::vector<BakeLight> lights;
        for (const auto& l : s.lights) {
            if (l.group < 0 || l.group >= GROUP_COUNT) throw std::runtime_error("an emitter's light group is out of range");
            BakeLight b{};
            b.c = l.c;
            b.u = l.u;
            b.v = l.v;
            b.n = normalize(l.n);
            b.r = l.r;
            b.L = l.L;
            b.lobe = std::max(1.0f, l.lobe);
            b.type = l.type == Emitter::RECT ? BL_RECT : l.type == Emitter::SPHERE ? BL_SPHERE : BL_DISC;
            b.group = unsigned(l.group);
            lights.push_back(b);
        }
        std::vector<BakeRotor> rotors;
        for (const auto& r : s.dyn) {
            const uint32_t mt = r.mesh.v.empty() ? 0 : r.mesh.v.front().mat;
            if (mt >= s.mats.size()) throw std::runtime_error("a rotor's material is out of range");
            rotors.push_back({r.centre, normalize(r.axis), r.radius, std::clamp(r.bakeTransmit, 0.0f, 1.0f), s.mats[mt].meanAlbedo});
        }

        // ---- the batches: positions, normals, sums; every batch traced in short launches until it has its samples
        size_t most = 1;
        for (const auto& v : s.vols) most = std::max(most, size_t(v.dim[0]) * v.dim[1] * v.dim[2]);
        most = std::max(most, size_t(a.width) * a.height);
        const size_t batch = std::min<size_t>(most, size_t(1) << 20);
        float4* dP = static_cast<float4*>(gpu.alloc(batch * sizeof(float4)));
        float4* dN = static_cast<float4*>(gpu.alloc(batch * sizeof(float4)));
        BakeAccum* dAcc = static_cast<BakeAccum*>(gpu.alloc(batch * sizeof(BakeAccum)));
        SalonParams* dPrm = static_cast<SalonParams*>(gpu.alloc(sizeof(SalonParams)));
        SalonParams prm{};
        prm.handle = handle;
        prm.vtxN = dNrm;
        prm.idx = dTri;
        prm.triMat = dMat;
        prm.vtxUV2 = gpu.upload(uv2);
        prm.triPage = gpu.upload(tpage);
        prm.mats = gpu.upload(mats);
        prm.lights = gpu.upload(lights);
        prm.rotors = gpu.upload(rotors);
        prm.lightCount = unsigned(lights.size());
        prm.rotorCount = unsigned(rotors.size());
        prm.texP = dP;
        prm.texN = dN;
        prm.acc = dAcc;
        prm.sigma = s.sigma;
        std::vector<float4> hp(batch), hn(batch);
        std::vector<BakeAccum> ha(batch);
        // a launch short enough that Özcan's desk does not stutter (~40 ms, far under the driver's 2 s watchdog): the
        // samples per launch from the speed the last launch of the same program had (texels and cells differ)
        double speed[2] = {0.0, 0.0};   // samples x threads per ms: surfaces, volumes
        double longest = 0.0;
        auto trace = [&](CUdeviceptr raygen, size_t count, unsigned seedBase, int samples, const std::function<void(int)>& tick) {
            sbt.raygenRecord = raygen;
            double& rate = speed[raygen == rec[3] ? 1 : 0];
            prm.count = unsigned(count);
            prm.seedBase = seedBase;
            CK(cudaMemset(dAcc, 0, count * sizeof(BakeAccum)));
            int done = 0;
            while (done < samples) {
                const double fit = rate > 0.0 ? 40.0 * rate / double(count) : 1.0;
                prm.sampleBase = unsigned(done);
                prm.samples = unsigned(std::clamp(fit, 1.0, double(std::min(1024, samples - done))));
                CK(cudaMemcpy(dPrm, &prm, sizeof(prm), cudaMemcpyHostToDevice));
                const auto l0 = Clock::now();
                OK(optixLaunch(gpu.pipe, nullptr, CUdeviceptr(dPrm), sizeof(prm), &sbt, unsigned(count), 1, 1));
                CK(cudaDeviceSynchronize());
                const double ms = seconds(l0) * 1000.0;
                longest = std::max(longest, ms);
                done += int(prm.samples);
                rate = double(count) * prm.samples / std::max(ms, 0.01);
                if (tick) tick(done);
            }
            CK(cudaMemcpy(ha.data(), dAcc, count * sizeof(BakeAccum), cudaMemcpyDeviceToHost));
        };
        auto send = [&](const std::vector<Texel>& texels, size_t first, size_t count) {
            for (size_t i = 0; i < count; ++i) {
                const Texel& t = texels[first + i];
                hp[i] = make_float4(t.p.x, t.p.y, t.p.z, t.footprint);
                hn[i] = make_float4(t.n.x, t.n.y, t.n.z, 0.0f);
            }
            CK(cudaMemcpy(dP, hp.data(), count * sizeof(float4), cudaMemcpyHostToDevice));
            CK(cudaMemcpy(dN, hn.data(), count * sizeof(float4), cudaMemcpyHostToDevice));
            // where each texel gathers its light (a texel inside another part moved out): one short launch
            sbt.raygenRecord = rec[4];
            prm.count = unsigned(count);
            CK(cudaMemcpy(dPrm, &prm, sizeof(prm), cudaMemcpyHostToDevice));
            OK(optixLaunch(gpu.pipe, nullptr, CUdeviceptr(dPrm), sizeof(prm), &sbt, unsigned(count), 1, 1));
            CK(cudaDeviceSynchronize());
        };

        out = Baked{};
        out.atlas = a;
        out.atlas.usedTexels = 0;
        size_t volCells = 0;
        for (const auto& v : s.vols) volCells += size_t(v.dim[0]) * v.dim[1] * v.dim[2];
        const size_t pixels = size_t(a.width) * a.height;
        Guard guard;

        // ---- pass 1: the direct light on every texel (a fixed few samples, whatever the bake's count: the nested
        // samples of two bakes stay nested). From it:
        //   the firefly clamp, per group: the outgoing radiance of the brightest surfaces (99.9th percentile) twice
        //   over. A path brighter than that found a hot spot (a wall a hand from a lamp): it would speckle the room.
        //   Lower (a few times the 99th percentile) cut the light a pool of sun on the floor throws back when the pool
        //   is under 1 % of the surface.
        //   the secondary lights: the directly lit texels as emitters the paths sample by power (next-event estimation
        //   to the light surfaces send on, in MIS with the paths). A shaft's pool of light lighting a gallery by its
        //   bounce is 1 % of the hemisphere: paths alone found it a few times in a thousand and the walls stood
        //   speckled at 1024 samples (12.8/255 of noise in the test room).
        // (the pages are rasterised here once and once more each to bake: an 8192² page's index alone is 256 MiB)
        const auto t1 = Clock::now();
        const int directSamples = 32;
        struct Lit { float3 p, n; float side; float3 rad[GROUP_COUNT]; uint32_t pixel; int page; };
        std::vector<Lit> lit;
        std::vector<float> seen[GROUP_COUNT];
        size_t allTexels = 0, moved = 0;
        prm.maxBounces = 0;
        prm.salt = 0x1F3D5B79u;
        for (float& c : prm.clampLum) c = 1e30f;
        for (int page = 0; page < a.pages; ++page) {
            const Raster r = rasterise(s, a, chartPage, page);
            allTexels += r.texels.size();
            for (size_t base = 0; base < r.texels.size(); base += batch) {
                const size_t count = std::min(batch, r.texels.size() - base);
                send(r.texels, base, count);
                CK(cudaMemcpy(hn.data(), dN, count * sizeof(float4), cudaMemcpyDeviceToHost));   // which were moved
                trace(rec[0], count, unsigned(size_t(page) * pixels + base), directSamples, {});
                for (size_t i = 0; i < count; ++i) {
                    const Texel& t = r.texels[base + i];
                    const Material& mt = s.mats[t.mat];
                    if (hn[i].w > 0.5f) {   // moved out of a part: its face is hidden, it sends no light from there
                        ++moved;
                        continue;
                    }
                    if (mt.flags & MF_EMISSIVE) continue;   // its light is its emitter's
                    Lit e{};
                    double power = 0.0;
                    for (int g = 0; g < GROUP_COUNT; ++g) {
                        const float E = guard(ha[i].e[g] / directSamples);
                        e.rad[g] = mt.meanAlbedo * (E * INV_PIf);
                        const float l = luminance(e.rad[g].x, e.rad[g].y, e.rad[g].z);
                        seen[g].push_back(l);
                        power += l;
                    }
                    if (!(power > 0.0)) continue;
                    e.p = t.p;
                    e.n = t.n;
                    e.side = t.footprint;
                    e.pixel = t.pixel;
                    e.page = page;
                    lit.push_back(e);
                }
            }
        }
        // the clamp
        for (int g = 0; g < GROUP_COUNT; ++g) {
            float c = o.clamp;
            if (!(c > 0.0f)) {
                auto& v = seen[g];
                std::sort(v.begin(), v.end());
                c = v.empty() ? 0.0f : 2.0f * v[std::min(v.size() - 1, size_t(0.999 * double(v.size())))];
                if (!(c > 0.0f) && !v.empty()) c = 2.0f * v.back();
                if (!(c > 0.0f)) c = 1.0f;   // a group nothing lights
            }
            prm.clampLum[g] = out.clampUsed[g] = c;
            std::vector<float>().swap(seen[g]);
        }
        // the secondary lights' table: every group an equal share of the samples, within a group by power (radiance
        // times area); the texels that hold the first 99.9 % of it, at most 4 M; Walker's alias table to pick them.
        // (One table for all groups: a sample lights every group the texel sends. Per group, a sample each, took 2.2x
        // the time for 1.8x less variance: less for the time than more samples.)
        std::vector<double> weight(lit.size(), 0.0);
        {
            double total[GROUP_COUNT] = {};
            auto power = [](const Lit& e, int g) { return double(luminance(e.rad[g].x, e.rad[g].y, e.rad[g].z)) * e.side * e.side; };
            for (const Lit& e : lit)
                for (int g = 0; g < GROUP_COUNT; ++g) total[g] += power(e, g);
            for (size_t j = 0; j < lit.size(); ++j)
                for (int g = 0; g < GROUP_COUNT; ++g)
                    if (total[g] > 0.0) weight[j] += power(lit[j], g) / total[g];
            std::vector<size_t> order(lit.size());
            for (size_t j = 0; j < order.size(); ++j) order[j] = j;
            std::stable_sort(order.begin(), order.end(), [&](size_t x, size_t y) { return weight[x] > weight[y]; });
            double all = 0.0, cum = 0.0;
            for (double w : weight) all += w;
            size_t keep = 0;
            while (keep < order.size() && keep < (size_t(4) << 20) && cum < 0.999 * all) cum += weight[order[keep++]];
            order.resize(keep);
            std::sort(order.begin(), order.end());   // back in raster order (deterministic, and near texels near in memory)
            std::vector<Lit> kept(keep);
            std::vector<double> kw(keep);
            for (size_t k = 0; k < keep; ++k) {
                kept[k] = lit[order[k]];
                kw[k] = weight[order[k]];
            }
            lit.swap(kept);
            weight.swap(kw);
        }
        const size_t ns = lit.size();
        std::vector<float4> secP(ns), secN(ns), secL(ns * GROUP_COUNT);
        std::vector<float> prob(ns, 1.0f);
        std::vector<unsigned> alias(ns);
        std::vector<int> secMap;
        if (ns) {
            double all = 0.0;
            for (double w : weight) all += w;
            secMap.assign(size_t(a.pages) * pixels, -1);
            std::vector<double> scaled(ns);
            std::vector<size_t> small, large;
            for (size_t j = 0; j < ns; ++j) {
                const Lit& e = lit[j];
                const double P = weight[j] / all;
                secP[j] = make_float4(e.p.x, e.p.y, e.p.z, e.side);
                secN[j] = make_float4(e.n.x, e.n.y, e.n.z, float(P / (double(e.side) * e.side)));   // the pdf by area
                for (int g = 0; g < GROUP_COUNT; ++g) secL[j * GROUP_COUNT + g] = make_float4(e.rad[g].x, e.rad[g].y, e.rad[g].z, 0.0f);
                secMap[size_t(e.page) * pixels + e.pixel] = int(j);
                scaled[j] = P * double(ns);
                alias[j] = unsigned(j);
                (scaled[j] < 1.0 ? small : large).push_back(j);
            }
            while (!small.empty() && !large.empty()) {   // Vose's method
                const size_t l = small.back(), h = large.back();
                small.pop_back();
                large.pop_back();
                prob[l] = float(scaled[l]);
                alias[l] = unsigned(h);
                scaled[h] = (scaled[h] + scaled[l]) - 1.0;
                (scaled[h] < 1.0 ? small : large).push_back(h);
            }
            for (size_t j : large) prob[j] = 1.0f;
            for (size_t j : small) prob[j] = 1.0f;
        }
        std::vector<Lit>().swap(lit);
        std::printf("pass 1 (direct, %d samples), %.1f s: %zu texels, %zu of them moved out of a part; %zu secondary light texels; "
                    "firefly clamp", directSamples, seconds(t1), allTexels, moved, ns);
        for (int g = 0; g < GROUP_COUNT; ++g) std::printf(" %.4g", prm.clampLum[g]);
        std::printf("\n");
        if (ns) {
            prm.secP = gpu.upload(secP);
            prm.secN = gpu.upload(secN);
            prm.secL = gpu.upload(secL);
            prm.secProb = gpu.upload(prob);
            prm.secAlias = gpu.upload(alias);
            prm.secMap = gpu.upload(secMap);
            prm.secCount = unsigned(ns);
        }
        std::vector<int>().swap(secMap);
        prm.mapW = unsigned(a.width);
        prm.mapH = unsigned(a.height);
        prm.maxBounces = unsigned(o.bounces);
        prm.salt = 0xA511E9B3u;
        speed[0] = 0.0;   // pass 1 traced no paths: its speed says nothing

        // ---- pass 2: the surfaces, page by page
        const double work = double(allTexels) * o.samples + double(volCells) * o.volSamples;
        double workDone = 0.0;
        const auto ts = Clock::now();
        out.planeA.resize(size_t(a.pages) * GROUP_COUNT);
        out.planeB.resize(size_t(a.pages) * GROUP_COUNT);
        for (int page = 0; page < a.pages; ++page) {
            Raster r = rasterise(s, a, chartPage, page);
            const size_t nt = r.texels.size();
            out.atlas.usedTexels += nt;
            std::vector<float> values(nt * kChannels, 0.0f);
            for (size_t base = 0; base < nt; base += batch) {
                const size_t count = std::min(batch, nt - base);
                send(r.texels, base, count);
                char line[160];
                trace(rec[0], count, unsigned(size_t(page) * pixels + base), o.samples, [&](int done) {
                    std::snprintf(line, sizeof(line), "page %d/%d: texels %zu/%zu, sample %d/%d", page + 1, a.pages,
                                  base + count, nt, done, o.samples);
                    say(float((workDone + double(count) * done) / work), line);
                });
                workDone += double(count) * o.samples;
                const float inv = 1.0f / float(o.samples);
                for (size_t i = 0; i < count; ++i) {
                    const BakeAccum& h = ha[i];
                    float* v = &values[(base + i) * kChannels];
                    for (int g = 0; g < GROUP_COUNT; ++g)
                        for (int c = 0; c < 3; ++c) {
                            v[g * 6 + c] = guard(h.l0[g][c] * inv);
                            v[g * 6 + 3 + c] = guard(h.l1[g][c] * inv);
                        }
                    v[GROUP_COUNT * 6] = h.openW > 0.0f ? guard(h.open / h.openW) : 1.0f;
                }
            }
            if (o.filter) filterPage(a, r, values);
            dilate(a, page, r, values, kChannels);
            // the planes: A = L0 rgb + openness (half), B = the L1 direction and its share (8 bit)
            for (int g = 0; g < GROUP_COUNT; ++g) {
                auto& A = out.planeA[size_t(page) * GROUP_COUNT + g];
                auto& B = out.planeB[size_t(page) * GROUP_COUNT + g];
                A.assign(pixels * 4, 0);
                B.assign(pixels * 4, 0);
                for (size_t i = 0; i < r.texels.size(); ++i) {
                    const float* v = &values[i * kChannels];
                    const size_t px = r.texels[i].pixel;
                    const float l0 = luminance(v[g * 6], v[g * 6 + 1], v[g * 6 + 2]);
                    const float3 l1 = make_float3(v[g * 6 + 3], v[g * 6 + 4], v[g * 6 + 5]);
                    const float len = length(l1);
                    const float3 dir = len > 1e-30f ? l1 / len : make_float3(0, 0, 0);
                    const float share = l0 > 1e-30f ? std::clamp(len / (kY1 / kY0 * l0), 0.0f, 1.0f) : 0.0f;
                    A[px * 4 + 0] = toHalf(guard(v[g * 6]));
                    A[px * 4 + 1] = toHalf(guard(v[g * 6 + 1]));
                    A[px * 4 + 2] = toHalf(guard(v[g * 6 + 2]));
                    A[px * 4 + 3] = toHalf(std::clamp(v[GROUP_COUNT * 6], 0.0f, 1.0f));
                    const float b[4] = {0.5f + 0.5f * dir.x, 0.5f + 0.5f * dir.y, 0.5f + 0.5f * dir.z, share};
                    for (int c = 0; c < 4; ++c) B[px * 4 + c] = uint8_t(std::lround(std::clamp(b[c], 0.0f, 1.0f) * 255.0f));
                }
            }
        }
        const double surfaceSeconds = seconds(ts);
        std::printf("\nsurfaces: %zu texels on %d pages, %d samples, %.1f s\n", out.atlas.usedTexels, a.pages, o.samples, surfaceSeconds);

        // ---- the volumes
        const auto tv = Clock::now();
        out.volM.resize(s.vols.size() * GROUP_COUNT);
        out.volF.resize(s.vols.size() * GROUP_COUNT);
        for (size_t vi = 0; vi < s.vols.size(); ++vi) {
            const Volume& v = s.vols[vi];
            const size_t n = size_t(v.dim[0]) * v.dim[1] * v.dim[2];
            prm.volLo = v.lo;
            prm.volCell = v.cell;
            prm.volDim = make_uint3(unsigned(v.dim[0]), unsigned(v.dim[1]), unsigned(v.dim[2]));
            for (int g = 0; g < GROUP_COUNT; ++g) {
                out.volM[vi * GROUP_COUNT + g].assign(n * 4, 0);
                out.volF[vi * GROUP_COUNT + g].assign(n * 4, 0);
            }
            size_t inside = 0;
            for (size_t base = 0; base < n; base += batch) {
                const size_t count = std::min(batch, n - base);
                char line[160];
                trace(rec[3], count, unsigned(base), o.volSamples, [&](int done) {
                    std::snprintf(line, sizeof(line), "volume %s: cells %zu/%zu, sample %d/%d", v.name.c_str(), base + count, n,
                                  done, o.volSamples);
                    say(float((workDone + double(count) * done) / work), line);
                });
                workDone += double(count) * o.volSamples;
                const float inv = 1.0f / float(o.volSamples);
                for (size_t i = 0; i < count; ++i) {
                    const BakeAccum& h = ha[i];
                    const bool open = h.open > 0.5f;
                    inside += open ? 0 : 1;
                    for (int g = 0; g < GROUP_COUNT; ++g) {
                        uint16_t* M = &out.volM[vi * GROUP_COUNT + g][(base + i) * 4];
                        uint16_t* F = &out.volF[vi * GROUP_COUNT + g][(base + i) * 4];
                        for (int c = 0; c < 3; ++c) {
                            M[c] = toHalf(open ? guard(h.l0[g][c] * inv) : 0.0f);
                            F[c] = toHalf(open ? guard(h.l1[g][c] * inv) : 0.0f);
                        }
                        M[3] = toHalf(open ? 1.0f : 0.0f);
                        F[3] = 0;
                    }
                }
            }
            std::printf("volume %s: %dx%dx%d cells of %.3g m, %zu inside geometry\n", v.name.c_str(), v.dim[0], v.dim[1], v.dim[2],
                        v.cell, inside);
        }
        const double volumeSeconds = seconds(tv);
        out.invalidValues = guard.bad;
        out.seconds = seconds(t0);
        std::printf("volumes: %.1f s; total %.1f s; NaN/Inf/overflow replaced: %zu; peak GPU memory %.0f MiB; longest launch %.0f ms\n",
                    volumeSeconds, out.seconds, out.invalidValues, gpu.peak / 1048576.0, longest);
        say(1.0f, "done");
        return true;
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
}

}   // namespace salon
