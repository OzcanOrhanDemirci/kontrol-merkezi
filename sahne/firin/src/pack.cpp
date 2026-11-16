// The pack: everything the window reads (docs/SALON.md "The pack"). sahne.json by a small JSON writer of its own; the
// binaries little-endian, as zlib streams (miniz, MIT, pc_graphics third_party/tinyexr) when o.compress: the window
// reads them with DecompressionStream('deflate').
#include "bake.h"

#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES   // keep the names compress, deflate... free
#include <miniz.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace salon {

namespace fs = std::filesystem;

namespace {

// a binary file, written raw or through deflate (zlib format)
class BinOut {
public:
    BinOut(const fs::path& p, bool z) : f_(p, std::ios::binary | std::ios::trunc), z_(z) {
        if (!f_) throw std::runtime_error("cannot write " + p.string());
        if (z_) {
            zs_ = {};
            if (mz_deflateInit(&zs_, 6) != MZ_OK) throw std::runtime_error("deflate init");
            buf_.resize(size_t(1) << 20);
        }
    }
    ~BinOut() {
        if (z_ && open_) mz_deflateEnd(&zs_);
    }
    void write(const void* p, size_t n) {
        if (!z_) {
            f_.write(static_cast<const char*>(p), std::streamsize(n));
            return;
        }
        const unsigned char* b = static_cast<const unsigned char*>(p);
        while (n > 0) {   // avail_in is 32 bits: feed in pieces
            const size_t piece = std::min<size_t>(n, size_t(1) << 26);
            zs_.next_in = b;
            zs_.avail_in = unsigned(piece);
            pump(MZ_NO_FLUSH);
            b += piece;
            n -= piece;
        }
    }
    template <class T>
    void put(const std::vector<T>& v) { write(v.data(), v.size() * sizeof(T)); }
    void close() {
        if (z_) {
            zs_.next_in = nullptr;
            zs_.avail_in = 0;
            pump(MZ_FINISH);
            mz_deflateEnd(&zs_);
            open_ = false;
        }
        f_.close();
        if (!f_) throw std::runtime_error("write failed");
    }

private:
    void pump(int flush) {
        for (;;) {
            zs_.next_out = buf_.data();
            zs_.avail_out = unsigned(buf_.size());
            const int r = mz_deflate(&zs_, flush);
            if (r != MZ_OK && r != MZ_STREAM_END && r != MZ_BUF_ERROR) throw std::runtime_error("deflate failed");
            f_.write(reinterpret_cast<const char*>(buf_.data()), std::streamsize(buf_.size() - zs_.avail_out));
            if (flush == MZ_FINISH ? r == MZ_STREAM_END : (zs_.avail_in == 0 && zs_.avail_out != 0)) break;
        }
    }
    std::ofstream f_;
    bool z_, open_ = true;
    mz_stream zs_{};
    std::vector<unsigned char> buf_;
};

// a small JSON writer: objects and arrays with commas kept, a new line before the elements of the outer two levels
class Json {
public:
    std::string s;
    Json& begin(char c) { pre(); s += c; first_.push_back(true); return *this; }
    Json& end(char c) {
        const bool empty = first_.back();
        first_.pop_back();
        if (!empty && first_.size() < 2) newline();
        s += c;
        return *this;
    }
    Json& key(const std::string& k) { pre(); quote(k); s += ':'; afterKey_ = true; return *this; }
    Json& str(const std::string& v) { pre(); quote(v); return *this; }
    Json& strOrNull(const std::string& v) { return v.empty() ? null() : str(v); }
    Json& null() { pre(); s += "null"; return *this; }
    Json& boolean(bool b) { pre(); s += b ? "true" : "false"; return *this; }
    // the scene's numbers are floats: the shortest text that reads back as the same float (0.012, not 0.0120000001)
    Json& num(float v) {
        pre();
        if (!std::isfinite(v)) { s += "null"; return *this; }
        char b[32];
        const auto r = std::to_chars(b, b + sizeof(b), v);
        s.append(b, r.ptr);
        return *this;
    }
    Json& num(double v) { return num(float(v)); }
    Json& num(size_t v) { pre(); s += std::to_string(v); return *this; }
    Json& num(int v) { pre(); s += std::to_string(v); return *this; }
    Json& num(uint32_t v) { pre(); s += std::to_string(v); return *this; }
    Json& vec(float3 v) { begin('['); num(v.x).num(v.y).num(v.z); return end(']'); }

private:
    void pre() {
        if (afterKey_) { afterKey_ = false; return; }
        if (first_.empty()) return;
        if (!first_.back()) s += ',';
        first_.back() = false;
        if (first_.size() <= 2) newline();
    }
    void newline() { s += '\n'; s.append(2 * first_.size(), ' '); }
    void quote(const std::string& v) {
        static const char* hex = "0123456789abcdef";
        s += '"';
        for (unsigned char c : v) {
            if (c == '"' || c == '\\') { s += '\\'; s += char(c); }
            else if (c < 32) { s += "\\u00"; s += hex[c >> 4]; s += hex[c & 15]; }
            else s += char(c);
        }
        s += '"';
    }
    std::vector<bool> first_;
    bool afterKey_ = false;
};

// a file name made of a scene name: only letters, digits, _ and -
std::string safeName(const std::string& n) {
    if (n.empty() || n.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos)
        throw std::runtime_error("not usable in a file name: \"" + n + "\"");
    return n;
}

struct Range { int page; uint32_t mat, first, count; };
struct MeshFile { uint32_t vertices = 0; std::vector<Range> ranges; };

// a mesh file: triangles sorted by (light map page, material), vertices in the order the sorted triangles first use
// them (a chart is one page and one material, so a range's vertices are contiguous); ranges count indices
MeshFile writeMesh(const fs::path& path, bool z, const Mesh& m, const std::vector<int>* chartPage) {
    struct Tri { int page; uint32_t mat; uint32_t first; };
    std::vector<Tri> order;
    order.reserve(m.tris());
    for (size_t k = 0; k + 2 < m.idx.size(); k += 3) {
        const dz::Vtx& v = m.v[m.idx[k]];
        order.push_back({chartPage ? (*chartPage)[v.chart] : 0, v.mat, uint32_t(k)});
    }
    std::stable_sort(order.begin(), order.end(), [](const Tri& a, const Tri& b) { return a.page != b.page ? a.page < b.page : a.mat < b.mat; });
    MeshFile mf;
    std::vector<int32_t> remap(m.v.size(), -1);
    std::vector<uint32_t> idx, verts;
    idx.reserve(m.idx.size());
    for (const Tri& t : order) {
        if (mf.ranges.empty() || mf.ranges.back().page != t.page || mf.ranges.back().mat != t.mat)
            mf.ranges.push_back({t.page, t.mat, uint32_t(idx.size()), 0});
        for (int j = 0; j < 3; ++j) {
            const uint32_t o = m.idx[t.first + j];
            if (remap[o] < 0) {
                remap[o] = int32_t(verts.size());
                verts.push_back(o);
            }
            idx.push_back(uint32_t(remap[o]));
        }
        mf.ranges.back().count += 3;
    }
    mf.vertices = uint32_t(verts.size());
    auto snorm = [](float x) { return int16_t(std::lround(std::clamp(x, -1.0f, 1.0f) * 32767.0f)); };
    auto unorm = [](float x) { return uint16_t(std::lround(std::clamp(x, 0.0f, 1.0f) * 65535.0f)); };
#pragma pack(push, 1)
    struct V {
        float p[3];
        int16_t n[4], t[4];
        float uv[2];
        uint16_t uv2[2];
    };
#pragma pack(pop)
    static_assert(sizeof(V) == 40, "docs/SALON.md: the vertex is 40 bytes");
    std::vector<V> out(verts.size());
    for (size_t i = 0; i < verts.size(); ++i) {
        const dz::Vtx& a = m.v[verts[i]];
        V& v = out[i];
        v.p[0] = a.p.x; v.p[1] = a.p.y; v.p[2] = a.p.z;
        v.n[0] = snorm(a.n.x); v.n[1] = snorm(a.n.y); v.n[2] = snorm(a.n.z); v.n[3] = 0;
        v.t[0] = snorm(a.t.x); v.t[1] = snorm(a.t.y); v.t[2] = snorm(a.t.z); v.t[3] = a.t.w < 0 ? -32767 : 32767;
        v.uv[0] = a.uv.x; v.uv[1] = a.uv.y;
        v.uv2[0] = chartPage ? unorm(a.uv2.x) : 0;
        v.uv2[1] = chartPage ? unorm(a.uv2.y) : 0;
    }
    BinOut f(path, z);
    const uint32_t header[4] = {0x31474D4Bu /* KMG1 */, mf.vertices, uint32_t(idx.size()), 40};
    f.write(header, sizeof(header));
    f.put(out);
    f.put(idx);
    f.close();
    return mf;
}

void ranges(Json& j, const std::vector<Range>& r, bool withPage) {
    j.begin('[');
    for (const Range& x : r) {
        j.begin('{').key("malzeme").num(x.mat);
        if (withPage) j.key("sayfa").num(x.page);
        j.key("ilk").num(x.first).key("sayi").num(x.count).end('}');
    }
    j.end(']');
}

void box(Json& j, const Box& b) {
    j.begin('{').key("merkez").vec(b.c).key("x").vec(b.x).key("y").vec(b.y).key("z").vec(b.z).end('}');
}

void view(Json& j, const View& v) {
    j.begin('{').key("goz").vec(v.eye).key("hedef").vec(v.target).key("fov").num(v.fov).end('}');
}

std::string utcNow() {
    const std::time_t t = std::time(nullptr);
    std::tm g{};
    gmtime_s(&g, &t);
    char b[32];
    std::strftime(b, sizeof(b), "%Y-%m-%dT%H:%M:%SZ", &g);
    return b;
}

}   // namespace

bool writePack(const std::string& dir, const Scene& s, const Atlas& a, const std::vector<int>& chartPage, const Baked* b,
               const BakeOptions& o, std::string& err) {
    try {
        const fs::path dest = fs::absolute(fs::u8path(dir));
        fs::create_directories(dest);
        const std::string ext = o.compress ? ".bin.z" : ".bin";
        // what an earlier pack left (the other compression, more pages, a renamed volume) must not linger
        for (const auto& e : fs::directory_iterator(dest)) {
            const std::string n = e.path().filename().string();
            if (e.is_regular_file() && (n.size() > 4 && (n.ends_with(".bin") || n.ends_with(".bin.z")))) fs::remove(e.path());
        }

        const MeshFile geo = writeMesh(dest / ("geo" + ext), o.compress, s.mesh, &chartPage);
        std::vector<MeshFile> rotors;
        for (const Dynamic& d : s.dyn) rotors.push_back(writeMesh(dest / ("rotor_" + safeName(d.name) + ext), o.compress, d.mesh, nullptr));

        std::vector<std::string> lmFiles, volFiles;
        if (b) {
            for (int p = 0; p < a.pages; ++p) {
                lmFiles.push_back("lm_" + std::to_string(p) + ext);
                BinOut f(dest / lmFiles.back(), o.compress);
                const uint32_t h[4] = {0x314C4D4Bu /* KML1 */, uint32_t(a.width), uint32_t(a.height), uint32_t(GROUP_COUNT)};
                f.write(h, sizeof(h));
                for (int g = 0; g < GROUP_COUNT; ++g) {
                    const auto& A = b->planeA.at(size_t(p) * GROUP_COUNT + g);
                    const auto& B = b->planeB.at(size_t(p) * GROUP_COUNT + g);
                    if (A.size() != size_t(a.width) * a.height * 4 || B.size() != A.size()) throw std::runtime_error("a light map plane's size");
                    f.put(A);
                    f.put(B);
                }
                f.close();
            }
            for (size_t i = 0; i < s.vols.size(); ++i) {
                const Volume& v = s.vols[i];
                volFiles.push_back("vol_" + safeName(v.name) + ext);
                BinOut f(dest / volFiles.back(), o.compress);
                const uint32_t h[5] = {0x31564D4Bu /* KMV1 */, uint32_t(v.dim[0]), uint32_t(v.dim[1]), uint32_t(v.dim[2]), uint32_t(GROUP_COUNT)};
                f.write(h, sizeof(h));
                for (int g = 0; g < GROUP_COUNT; ++g) {
                    f.put(b->volM.at(i * GROUP_COUNT + g));
                    f.put(b->volF.at(i * GROUP_COUNT + g));
                }
                f.close();
            }
        }

        // the materials' textures, beside the pack under their sahne/varlik paths (the pack is all the window reads)
        const fs::path assets = fs::path(o.root) / ".." / "varlik";
        for (const Material& m : s.mats)
            for (const std::string& rel : {m.albedo, m.normal, m.arm, m.emission}) {
                if (rel.empty()) continue;
                const fs::path rp = fs::u8path(rel);
                if (rp.is_absolute() || rel.find("..") != std::string::npos) throw std::runtime_error("a texture path leaves sahne/varlik: " + rel);
                const fs::path from = assets / rp, to = dest / rp;
                if (!fs::exists(from)) throw std::runtime_error("missing texture " + from.string());
                fs::create_directories(to.parent_path());
                fs::copy_file(from, to, fs::copy_options::update_existing);
            }

        Json j;
        j.begin('{');
        j.key("surum").num(1);
        j.key("olusturuldu").str(utcNow());
        j.key("firin").begin('{');
        j.key("ornek").num(b ? o.samples : 0).key("hacimOrnek").num(b ? o.volSamples : 0).key("seken").num(o.bounces);
        j.key("sure_sn");
        if (b) j.num(std::round(b->seconds * 10.0) / 10.0); else j.null();
        j.key("ortam_sigma").num(s.sigma).key("ortam_g").num(s.g);
        j.key("texelOlcek").num(o.texelScale).key("filtre").boolean(o.filter);
        j.key("sinir");
        if (b) {
            j.begin('[');
            for (float c : b->clampUsed) j.num(c);
            j.end(']');
        } else {
            j.null();
        }
        j.end('}');

        j.key("malzemeler").begin('[');
        static const char* flagNames[] = {"emissive", "noOcclude", "wet", "levha", "metal", "twoSided"};
        for (const Material& m : s.mats) {
            j.begin('{').key("ad").str(m.name);
            j.key("albedo").strOrNull(m.albedo).key("normal").strOrNull(m.normal).key("arm").strOrNull(m.arm);
            j.key("isimaDoku").strOrNull(m.emission);
            j.key("uvOlcek").num(m.uvScale).key("renk").vec(m.tint);
            j.key("puruz");
            if (m.rough < 0) j.null(); else j.num(m.rough);
            j.key("metal");
            if (m.metal < 0) j.null(); else j.num(m.metal);
            j.key("bayrak").begin('[');
            for (int f = 0; f < 6; ++f)
                if (m.flags & (1u << f)) j.str(flagNames[f]);
            j.end(']');
            j.key("grup");
            if (m.group < 0) j.null(); else j.num(m.group);
            j.key("isima").num(m.emitScale);
            j.key("ortalamaAlbedo").vec(m.meanAlbedo);
            j.end('}');
        }
        j.end(']');

        j.key("geometri").begin('{').key("dosya").str("geo" + ext).key("kose").num(geo.vertices).key("ucgen").num(s.mesh.tris());
        j.key("araliklar");
        ranges(j, geo.ranges, true);
        j.end('}');

        j.key("dinamik").begin('[');
        for (size_t i = 0; i < s.dyn.size(); ++i) {
            const Dynamic& d = s.dyn[i];
            j.begin('{').key("ad").str(d.name).key("dosya").str("rotor_" + d.name + ext);
            j.key("kose").num(rotors[i].vertices).key("ucgen").num(d.mesh.tris());
            j.key("merkez").vec(d.centre).key("eksen").vec(normalize(d.axis)).key("yaricap").num(d.radius).key("kanat").num(d.blades);
            j.key("gecirgenlik").num(d.bakeTransmit).key("araliklar");
            ranges(j, rotors[i].ranges, false);
            j.end('}');
        }
        j.end(']');

        j.key("isikHaritasi").begin('{').key("dosya").begin('[');
        for (const auto& f : lmFiles) j.str(f);
        j.end(']');
        j.key("genislik").num(a.width).key("yukseklik").num(a.height).key("sayfa").num(a.pages).key("gruplar").num(int(GROUP_COUNT));
        j.key("dolgu").num(a.pad).key("texel");
        if (b) j.num(b->atlas.usedTexels); else j.null();   // counted when rasterised for the bake
        j.end('}');

        j.key("hacimler").begin('[');
        for (size_t i = 0; i < s.vols.size(); ++i) {
            const Volume& v = s.vols[i];
            j.begin('{').key("ad").str(v.name).key("dosya").strOrNull(b ? volFiles[i] : std::string());
            j.key("boyut").begin('[').num(v.dim[0]).num(v.dim[1]).num(v.dim[2]).end(']');
            j.key("alt").vec(v.lo).key("hucre").num(v.cell).end('}');
        }
        j.end(']');

        j.key("isiklar").begin('[');
        for (const Emitter& l : s.lights) {
            j.begin('{').key("grup").num(l.group);
            j.key("tur").str(l.type == Emitter::RECT ? "dikdortgen" : l.type == Emitter::SPHERE ? "kure" : "disk");
            j.key("merkez").vec(l.c);
            if (l.type != Emitter::SPHERE) j.key("u").vec(l.u).key("v").vec(l.v).key("normal").vec(normalize(l.n));
            if (l.type == Emitter::SPHERE) j.key("yaricap").num(l.r);
            j.key("parlaklik").num(l.L);
            if (l.type != Emitter::SPHERE) j.key("kosUs").num(std::max(1.0f, l.lobe));
            j.end('}');
        }
        j.end(']');

        j.key("gorunumler").begin('{').key("fanlar");
        view(j, s.fanlar);
        j.key("rgb");
        view(j, s.rgb);
        j.key("yol").begin('[');
        for (const float3& p : s.path) j.vec(p);
        j.end(']').end('}');

        j.key("capalar").begin('[');
        for (const Anchor& an : s.anchors) {
            j.begin('{').key("ad").str(an.name).key("tur").str(an.type);
            if (an.type == "levha") {
                j.key("atlas").str(an.atlas).key("boyut").begin('[').num(an.size[0]).num(an.size[1]).end(']');
                j.key("malzeme").num(an.material);
            }
            j.key("kutu");
            box(j, an.box);
            j.end('}');
        }
        j.end(']');
        j.end('}');
        j.s += '\n';

        std::ofstream f(dest / "sahne.json", std::ios::binary | std::ios::trunc);
        f << j.s;
        f.close();
        if (!f) throw std::runtime_error("cannot write sahne.json");
        return true;
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
}

}   // namespace salon
