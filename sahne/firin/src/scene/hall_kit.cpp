#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>

namespace salon::hall {

const char* const kMatNames[M_COUNT] = {
    "beton_zemin", "beton_duvar", "beton_kolon", "beton_tavan", "beton_anit", "celik_boyali_kasa", "celik_boyali_gpu",
    "celik_kanat", "celik_pasli", "celik_sac", "metal_koyu", "kablo", "cam_lamba", "kemer_isik", "kuyu_isik", "boya",
    "pano_yuz", "ekran_yuz", "tabela_yuz", "mercek", "cekirdek_isik", "merdiven_isik", "dis_zemin", "dis_duvar",
    "dis_kolon", "dis_koyu", "dis_isik", "dis_fener"};

namespace {
// the exterior's rows are the hall's own texture sets under their own names: the asset step's entry they read
const char* textureSource(int i) {
    switch (i) {
        case M_DIS_ZEMIN: return "beton_zemin";
        case M_DIS_DUVAR: return "beton_duvar";
        case M_DIS_KOLON: return "beton_kolon";
        case M_DIS_KOYU: return "metal_koyu";
        default: return kMatNames[i];
    }
}
}   // namespace

// ---------------------------------------------------------------------------------------------------------------------
// materials

namespace {

// A small JSON reader: enough for varlik.json (objects, arrays, strings, numbers, true/false/null).
struct Json {
    enum Type { NUL, NUM, STR, ARR, OBJ, BOOL } type = NUL;
    double num = 0;
    std::string str;
    std::vector<Json> arr;
    std::map<std::string, Json> obj;
    const Json* get(const std::string& k) const {
        auto it = obj.find(k);
        return it == obj.end() ? nullptr : &it->second;
    }
};

struct JsonReader {
    const std::string& t;
    size_t i = 0;
    bool ok = true;
    void ws() {
        while (i < t.size() && (t[i] == ' ' || t[i] == '\n' || t[i] == '\r' || t[i] == '\t')) ++i;
    }
    std::string string() {
        std::string out;
        ++i;   // the opening quote
        while (i < t.size() && t[i] != '"') {
            if (t[i] == '\\' && i + 1 < t.size()) {
                ++i;
                const char c = t[i];
                if (c == 'n') out += '\n';
                else if (c == 't') out += '\t';
                else if (c == 'u' && i + 4 < t.size()) {   // \uXXXX: keep ASCII, others as '?' (names are ASCII)
                    const int cp = std::stoi(t.substr(i + 1, 4), nullptr, 16);
                    out += cp < 128 ? char(cp) : '?';
                    i += 4;
                } else out += c;
            } else out += t[i];
            ++i;
        }
        ++i;
        return out;
    }
    Json value() {
        Json j;
        ws();
        if (i >= t.size()) { ok = false; return j; }
        const char c = t[i];
        if (c == '{') {
            j.type = Json::OBJ;
            ++i;
            ws();
            if (t[i] == '}') { ++i; return j; }
            while (ok) {
                ws();
                if (t[i] != '"') { ok = false; break; }
                const std::string k = string();
                ws();
                if (t[i] != ':') { ok = false; break; }
                ++i;
                j.obj[k] = value();
                ws();
                if (t[i] == ',') { ++i; continue; }
                if (t[i] == '}') { ++i; break; }
                ok = false;
            }
        } else if (c == '[') {
            j.type = Json::ARR;
            ++i;
            ws();
            if (t[i] == ']') { ++i; return j; }
            while (ok) {
                j.arr.push_back(value());
                ws();
                if (t[i] == ',') { ++i; continue; }
                if (t[i] == ']') { ++i; break; }
                ok = false;
            }
        } else if (c == '"') {
            j.type = Json::STR;
            j.str = string();
        } else if (c == 't' || c == 'f') {
            j.type = Json::BOOL;
            j.num = c == 't';
            i += c == 't' ? 4 : 5;
        } else if (c == 'n') {
            i += 4;
        } else {
            j.type = Json::NUM;
            size_t used = 0;
            j.num = std::stod(t.substr(i, 40), &used);
            i += used;
        }
        return j;
    }
};

struct Fallback { float3 albedo; float rough, metal; float uvScale; };
// what a material is without its texture set (the levha faces' and emitters' only definition)
const Fallback kFallback[M_COUNT] = {
    {{0.09f, 0.095f, 0.09f}, 0.5f, 0.0f, 3.0f},    // beton_zemin
    {{0.20f, 0.19f, 0.17f}, 0.85f, 0.0f, 2.0f},    // beton_duvar
    {{0.18f, 0.15f, 0.11f}, 0.6f, 0.0f, 1.8f},     // beton_kolon
    {{0.06f, 0.06f, 0.055f}, 0.8f, 0.0f, 3.0f},    // beton_tavan
    {{0.26f, 0.23f, 0.16f}, 0.8f, 0.0f, 2.7f},     // beton_anit
    {{0.05f, 0.075f, 0.035f}, 0.5f, 0.0f, 1.0f},   // celik_boyali_kasa
    {{0.025f, 0.05f, 0.075f}, 0.35f, 0.0f, 2.5f},  // celik_boyali_gpu
    {{0.05f, 0.075f, 0.035f}, 0.6f, 0.0f, 1.0f},   // celik_kanat
    {{0.13f, 0.045f, 0.016f}, 0.8f, 0.0f, 2.2f},   // celik_pasli
    {{0.05f, 0.035f, 0.013f}, 0.6f, 0.4f, 0.5f},   // celik_sac
    {{0.032f, 0.024f, 0.017f}, 0.65f, 0.9f, 2.0f}, // metal_koyu
    {{0.015f, 0.015f, 0.018f}, 0.75f, 0.0f, 2.0f}, // kablo
    {{0.80f, 0.78f, 0.72f}, 0.2f, 0.0f, 1.0f},     // cam_lamba
    {{0.80f, 0.80f, 0.80f}, 0.9f, 0.0f, 1.0f},     // kemer_isik
    {{0.80f, 0.80f, 0.80f}, 0.9f, 0.0f, 1.0f},     // kuyu_isik
    {{0.60f, 0.58f, 0.50f}, 0.7f, 0.0f, 1.0f},     // boya (the live texture's alpha decides where it shows)
    {{0.04f, 0.04f, 0.04f}, 0.6f, 0.0f, 1.0f},     // pano_yuz (satin black engraved panel; its lights self-lit live)
    {{0.03f, 0.03f, 0.03f}, 0.25f, 0.0f, 1.0f},    // ekran_yuz
    {{0.12f, 0.12f, 0.11f}, 0.6f, 0.0f, 1.0f},     // tabela_yuz
    {{0.30f, 0.30f, 0.30f}, 0.1f, 0.0f, 1.0f},     // mercek
    {{0.80f, 0.80f, 0.80f}, 0.9f, 0.0f, 1.0f},     // cekirdek_isik
    {{0.80f, 0.78f, 0.72f}, 0.2f, 0.0f, 1.0f},     // merdiven_isik
    {{0.09f, 0.095f, 0.09f}, 0.5f, 0.0f, 3.0f},    // dis_zemin (beton_zemin's)
    {{0.20f, 0.19f, 0.17f}, 0.85f, 0.0f, 2.0f},    // dis_duvar (beton_duvar's)
    {{0.18f, 0.15f, 0.11f}, 0.6f, 0.0f, 1.8f},     // dis_kolon (beton_kolon's)
    {{0.032f, 0.024f, 0.017f}, 0.65f, 0.9f, 2.0f}, // dis_koyu (metal_koyu's)
    {{0.80f, 0.80f, 0.80f}, 0.9f, 0.0f, 1.0f},     // dis_isik
    {{0.80f, 0.78f, 0.72f}, 0.2f, 0.0f, 1.0f},     // dis_fener
};

}   // namespace

void loadMaterials(Scene& s, const std::string& assetDir) {
    std::ifstream in(assetDir + "/varlik.json", std::ios::binary);
    std::ostringstream buf;
    buf << in.rdbuf();
    const std::string text = buf.str();
    JsonReader rd{text};
    Json root = text.empty() ? Json{} : rd.value();
    if (!rd.ok) {
        std::fprintf(stderr, "hall: %s/varlik.json does not parse; every material uses its constants\n", assetDir.c_str());
        root = Json{};
    }
    const Json* table = root.get("malzemeler");
    std::vector<std::string> constant;
    s.mats.clear();
    for (int i = 0; i < M_COUNT; ++i) {
        Material m;
        m.name = kMatNames[i];
        const Fallback& f = kFallback[i];
        m.tint = f.albedo;
        m.meanAlbedo = f.albedo;
        m.rough = f.rough;
        m.metal = f.metal;
        m.uvScale = f.uvScale;
        const Json* e = table ? table->get(textureSource(i)) : nullptr;
        auto file = [&](const char* key) -> std::string {
            const Json* p = e ? e->get(key) : nullptr;
            if (!p || p->type != Json::STR) return {};
            return std::filesystem::exists(assetDir + "/" + p->str) ? p->str : std::string();
        };
        if (e) {
            m.albedo = file("albedo");
            m.normal = file("normal");
            m.arm = file("arm");
            if (const Json* o = e->get("olcek_m"); o && o->type == Json::NUM && o->num > 0) m.uvScale = float(o->num);
            if (const Json* a = e->get("ortalama"); a && a->type == Json::ARR && a->arr.size() == 3)
                m.meanAlbedo = make_float3(float(a->arr[0].num), float(a->arr[1].num), float(a->arr[2].num));
        }
        if (!m.albedo.empty()) m.tint = make_float3(1, 1, 1);   // the texture's mean already carries its gain
        if (!m.arm.empty()) m.rough = m.metal = -1.0f;
        if (m.albedo.empty() && i <= M_KABLO) constant.push_back(m.name);
        switch (i) {
            case M_ZEMIN: m.flags = MF_WET; break;
            case M_KOYU: m.flags = MF_METAL; break;   // its ARM's metal channel averages 0.9
            case M_CAM_LAMBA: m.flags = MF_EMISSIVE; m.group = GROUP_LAMBA; m.emitScale = kLambaL; break;
            case M_KEMER_ISIK: m.flags = MF_EMISSIVE; m.group = GROUP_KEMER; m.emitScale = kKemerL; break;
            case M_CEKIRDEK_ISIK: m.flags = MF_EMISSIVE; m.group = GROUP_KEMER; m.emitScale = kCekirdekL; break;
            case M_KUYU_ISIK: m.flags = MF_EMISSIVE; m.group = GROUP_KUYU; m.emitScale = kKuyuL; break;
            case M_MERDIVEN_ISIK: m.flags = MF_EMISSIVE; m.group = GROUP_KUYU; m.emitScale = kMerdivenL; break;
            case M_DIS_KOYU: m.flags = MF_METAL; break;
            case M_DIS_ISIK: m.flags = MF_EMISSIVE; m.group = GROUP_KUYU; m.emitScale = kCatiL; break;
            case M_DIS_FENER: m.flags = MF_EMISSIVE; m.group = GROUP_KUYU; m.emitScale = kFenerL; break;
            case M_BOYA: m.flags = MF_NO_OCCLUDE | MF_LEVHA; break;
            case M_PANO: case M_EKRAN: case M_TABELA: case M_MERCEK: m.flags = MF_LEVHA; break;
            default: break;
        }
        s.mats.push_back(m);
    }
    if (!constant.empty()) {
        std::string list;
        for (const auto& n : constant) list += (list.empty() ? "" : ", ") + n;
        std::fprintf(stderr, "hall: no texture set for %s (constants used; %s/varlik.json)\n", list.c_str(), assetDir.c_str());
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// frames

Xform facing(float3 o, float3 n, float3 up) { return Xform::frame(o, n, up); }

Xform axes(float3 o, float3 x, float3 y, float3 z) {
    Xform t;
    t.o = o;
    t.x = x;
    t.y = y;
    t.z = z;
    return t;
}

// ---------------------------------------------------------------------------------------------------------------------
// primitives

Kit& Hall::at(const Xform& t, int mat, float maxEdge) {
    k.t = t;
    k.mat = uint32_t(mat);
    k.feat = dz::FEAT_NONE;
    k.fp = make_float2(0, 0);
    k.maxEdge = maxEdge;
    return k;
}

void Hall::box(const Xform& t, float3 h, float e, int mat, float maxEdge) {
    at(t, mat, maxEdge).roundedBox(h, e);
}

void Hall::tube(float3 a, float3 b, float r, int mat, float maxEdge) {
    const float3 d = b - a;
    const float L = length(d);
    at(Xform::frame(a, d, std::fabs(d.y) < 0.95f * L ? v3(0, 1, 0) : v3(1, 0, 0)), mat, maxEdge).tube(r, 0.0f, L);
}

void Hall::rod(float3 a, float3 b, float r, int mat, float maxEdge) {
    const float3 d = b - a;
    const float L = length(d);
    at(Xform::frame(a, d, std::fabs(d.y) < 0.95f * L ? v3(0, 1, 0) : v3(1, 0, 0)), mat, maxEdge);
    // a bar with rounded ends: cap centre, a quarter round, the side, a quarter round, cap centre
    const int nu = std::clamp(int(std::ceil(2.0f * kPi * r / 0.012f)), 12, 32);
    const float e = std::min(0.35f * r, 0.25f * L);
    struct Row { float rr, z, nr, nz; };
    std::vector<Row> rows;
    rows.push_back({0.0f, 0.0f, 0.0f, -1.0f});
    for (int i = 0; i <= 3; ++i) {
        const float th = 0.5f * kPi * float(i) / 3;
        rows.push_back({r - e + e * std::sin(th), e - e * std::cos(th), std::sin(th), -std::cos(th)});
    }
    const int ns = std::max(1, int(std::ceil((L - 2 * e) / maxEdge)));
    for (int i = 1; i < ns; ++i) rows.push_back({r, e + (L - 2 * e) * float(i) / ns, 1.0f, 0.0f});
    for (int i = 0; i <= 3; ++i) {
        const float th = 0.5f * kPi * float(i) / 3;
        rows.push_back({r - e + e * std::cos(th), L - e + e * std::sin(th), std::cos(th), std::sin(th)});
    }
    rows.push_back({0.0f, L, 0.0f, 1.0f});
    std::vector<float> sv(rows.size(), 0.0f);
    for (size_t j = 1; j < rows.size(); ++j) sv[j] = sv[j - 1] + std::hypot(rows[j].rr - rows[j - 1].rr, rows[j].z - rows[j - 1].z);
    const float C = 2.0f * kPi * r;
    k.grid(nu, int(rows.size()) - 1, [&](int i, int j) {
        Kit::GridPt g;
        const float a = 2.0f * kPi * float(i % nu) / nu, ca = std::cos(a), sa = std::sin(a);
        const Row& q = rows[j];
        g.p = v3(q.rr * ca, q.rr * sa, q.z);
        g.n = normalize(v3(q.nr * ca, q.nr * sa, q.nz));
        g.s = make_float2(C * float(i) / nu, sv[j]);
        return g;
    });
}

void Hall::quad(const Xform& t, float w, float h, int mat, float maxEdge) { at(t, mat, maxEdge).quad(w, h); }

void Hall::nut(const Xform& t, float sf, int mat) { at(t, mat, 0.05f).hexPrism(sf, 0.0f, 0.8f * sf, 0.15f * sf); }

void Hall::patch(float3 a, float3 b, float3 c, float3 d, float3 n, int mat, float maxEdge) {
    at(Xform(), mat, maxEdge);
    // the winding faces n: swap the sides if a-b x a-c points away
    if (dot(cross(b - a, c - a), n) < 0) {
        std::swap(a, c);
        std::swap(b, d);
    }
    const float3 ex = normalize(b - a), ey = cross(normalize(n), ex);
    const int nu = std::max(1, int(std::ceil(std::max(length(b - a), length(d - c)) / maxEdge)));
    const int nv = std::max(1, int(std::ceil(std::max(length(c - a), length(d - b)) / maxEdge)));
    const float3 nn = normalize(n);
    k.grid(nu, nv, [&](int i, int j) {
        const float u = float(i) / nu, v = float(j) / nv;
        Kit::GridPt g;
        g.p = lerp3(lerp3(a, b, u), lerp3(c, d, u), v);
        g.n = nn;
        g.s = make_float2(dot(g.p - a, ex), dot(g.p - a, ey));
        return g;
    });
}

void Hall::bar(float3 a, float3 b, float w, float h, float3 up, int mat) {
    const float3 d = b - a;
    const float L = length(d);
    const float3 z = d / L;
    const float3 x = normalize(cross(up, z)), y = cross(z, x);
    at(axes(a, x, y, z), mat, 1e3f);
    const float c = 0.25f * std::min(w, h);   // the chamfer
    const float hw = 0.5f * w, hh = 0.5f * h;
    k.extrude({{hw, -hh + c}, {hw, hh - c}, {hw - c, hh}, {-hw + c, hh}, {-hw, hh - c}, {-hw, -hh + c}, {-hw + c, -hh},
               {hw - c, -hh}},
              0.0f, L, true);
}

void Hall::ibeam(float3 a, float3 b, float d, float bf, float tw, float tf, float3 up, int mat) {
    const float3 dd = b - a;
    const float L = length(dd);
    const float3 z = dd / L;
    const float3 x = normalize(cross(up, z)), y = cross(z, x);
    at(axes(a, x, y, z), mat, 2.0f);
    const float hd = 0.5f * d, hb = 0.5f * bf, ht = 0.5f * tw;
    const std::vector<float2> I = {{hb, -hd},      {hb, -hd + tf}, {ht, -hd + tf}, {ht, hd - tf}, {hb, hd - tf},
                                   {hb, hd},       {-hb, hd},      {-hb, hd - tf}, {-ht, hd - tf}, {-ht, -hd + tf},
                                   {-hb, -hd + tf}, {-hb, -hd}};
    // no caps (an I's outline is not convex): welded end plates close it
    k.extrude(Kit::roundOutline(I, std::min(0.006f, 0.4f * tf), 2), 0.0f, L, false);
    for (int e = 0; e < 2; ++e)
        box(axes(a + z * (e ? L - 0.004f : 0.004f), x, y, z), v3(hb + 0.005f, hd + 0.005f, 0.004f), 0.002f, mat, 1.0f);
}

namespace {
// a point on a rectangle of half sizes (ax, ay) at perimeter step q of 4M, clockwise from the top right corner
float2 rectStep(int q, int M, float ax, float ay) {
    q %= 4 * M;
    const int side = q / M;
    const float tt = float(q % M) / M;
    switch (side) {
        case 0: return make_float2(ax, ay - 2 * ay * tt);
        case 1: return make_float2(ax - 2 * ax * tt, -ay);
        case 2: return make_float2(-ax, -ay + 2 * ay * tt);
        default: return make_float2(-ax + 2 * ax * tt, ay);
    }
}
}   // namespace

void Hall::squareRing(const Xform& t, float hs, float r, int mat) {
    at(t, mat, 2.0f);
    const int M = std::max(8, int(std::ceil(2.0f * kPi * r / 4.0f / 0.12f)));   // ~12 cm round the hole
    const int N = 4 * M;
    k.grid(N, 2, [&](int i, int j) {
        const float2 q = rectStep(i, M, hs, hs);
        const float l = std::hypot(q.x, q.y);
        const float2 c = make_float2(q.x / l * r, q.y / l * r);
        const float f = j == 0 ? 0.0f : j == 1 ? 0.35f : 1.0f;
        Kit::GridPt g;
        g.p = v3(c.x + (q.x - c.x) * f, c.y + (q.y - c.y) * f, 0.0f);
        g.n = v3(0, 0, 1);
        g.s = make_float2(g.p.x, g.p.y);
        return g;
    });
}

void Hall::archFrame(const Xform& t, float r, float hw, float top, bool front, int mat) {
    at(t, mat, 2.0f);
    // the angles: the rectangle's two top corners exactly, so its edges stay straight
    const float tc = std::atan2(top, hw);
    std::vector<float> th;
    auto span = [&](float a0, float a1, bool last) {
        const int n = std::max(2, int(std::ceil(std::fabs(a1 - a0) * r / 0.15f)));
        for (int q = 0; q < (last ? n + 1 : n); ++q) th.push_back(a0 + (a1 - a0) * q / n);
    };
    span(0.0f, tc, false);
    span(tc, kPi - tc, false);
    span(kPi - tc, kPi, true);
    if (front) std::reverse(th.begin(), th.end());   // the winding faces +z
    k.grid(int(th.size()) - 1, 2, [&](int i, int j) {
        const float a = th[i], ca = std::cos(a), sa = std::sin(a);
        float ro = 1e9f;
        if (std::fabs(ca) > 1e-6f) ro = std::min(ro, hw / std::fabs(ca));
        if (sa > 1e-6f) ro = std::min(ro, top / sa);
        const float rr = j == 0 ? r : j == 1 ? r + 0.4f * (ro - r) : ro;
        Kit::GridPt g;
        g.p = v3(rr * ca, rr * sa, 0.0f);
        g.n = v3(0, 0, front ? 1.0f : -1.0f);
        g.s = make_float2(g.p.x, g.p.y);
        return g;
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// formwork faces

void Hall::formworkFace(const Xform& t, float u0, float u1, float v0, float v1, const Formwork& f, int mat,
                        float maxEdge) {
    const size_t vm = vmark();
    const uint32_t cm = cmark();
    at(t, mat, maxEdge);
    const float W = u1 - u0, H = v1 - v0;
    const float w = f.halfWidth, d = f.depth;
    // the seams inside the face (not on its edges: those meet a rounding or another surface)
    auto seams = [&](float lo, float hi, float p, float o) {
        std::vector<float> out;
        if (p <= 0) return out;
        for (float x = o + std::ceil((lo - o) / p - 1e-4f) * p; x < hi; x += p)
            if (x > lo + w && x < hi - w) out.push_back(x);
        return out;
    };
    const std::vector<float> SU = seams(u0, u1, f.pu, f.ou), SV = seams(v0, v1, f.pv, f.ov);
    // the groove's depth g >= 0 at a coordinate and its slope dg/dx: a raised-cosine valley at each seam
    auto groove1 = [&](float x, const std::vector<float>& S, float& slope) {
        slope = 0.0f;
        float best = 0.0f;
        for (float sx : S) {
            const float tt = x - sx;
            if (std::fabs(tt) < w) {
                const float g = d * 0.5f * (1.0f + std::cos(kPi * tt / w));
                if (g > best) {
                    best = g;
                    slope = -d * 0.5f * kPi / w * std::sin(kPi * tt / w);
                }
            }
        }
        return best;
    };
    // a point of the face: its depth and normal from the deeper of the two grooves
    auto point = [&](float u, float v) {
        float su, sv;
        const float gu = groove1(u, SU, su), gv = groove1(v, SV, sv);
        Kit::GridPt g;
        if (gu >= gv) {
            g.p = v3(u, v, -gu);
            g.n = normalize(v3(su, 0.0f, 1.0f));
        } else {
            g.p = v3(u, v, -gv);
            g.n = normalize(v3(0.0f, sv, 1.0f));
        }
        g.s = make_float2(u, v);
        return g;
    };

    if (f.tiesU <= 0 || f.tiesV <= 0 || f.pu <= 0 || f.pv <= 0) {
        // seams only: one grid whose lines carry each groove's profile
        auto lines = [&](float lo, float hi, const std::vector<float>& S) {
            std::vector<float> L = {lo, hi};
            for (float sx : S)
                for (float o : {-w, -0.5f * w, 0.0f, 0.5f * w, w}) L.push_back(sx + o);
            std::sort(L.begin(), L.end());
            std::vector<float> out;
            for (float x : L) {
                if (x < lo || x > hi) continue;
                if (!out.empty() && x - out.back() < 1e-3f) continue;
                while (!out.empty() && x - out.back() > maxEdge) out.push_back(out.back() + std::min(maxEdge, 0.5f * (x - out.back())));
                out.push_back(x);
            }
            return out;
        };
        const std::vector<float> U = lines(u0, u1, SU), V = lines(v0, v1, SV);
        k.grid(int(U.size()) - 1, int(V.size()) - 1, [&](int i, int j) { return point(U[i], V[j]); });
        oneChart(vm, cm);
        return;
    }

    // tie holes: one cell round each hole, from the hole's rim to the cell's rectangle (rings close to the rectangle
    // carry a seam's groove where the cell meets one), and the hole itself: a cone and its flat bottom
    const int nCu = std::max(1, int(std::lround(W / f.pu))) * f.tiesU, nCv = std::max(1, int(std::lround(H / f.pv))) * f.tiesV;
    const float cu = W / nCu, cv = H / nCv;
    const float rH = 0.016f, rB = 0.007f, dH = 0.022f;   // the recess: rim radius, bottom radius, depth
    // points along each side of a cell, as fractions of it from its first corner: the corners' neighbourhoods carry the
    // groove's profile (w/2, w from each corner, where a seam crosses the side's end), two between
    auto fractions = [&](float L) {
        return std::vector<float>{0.0f, 0.5f * w / L, w / L, 1.0f / 3.0f, 2.0f / 3.0f, 1.0f - w / L, 1.0f - 0.5f * w / L};
    };
    const std::vector<float> frV = fractions(cv), frH = fractions(cu);
    const int Ms = int(frV.size()), N = 4 * Ms;
    // a point on the cell's rectangle of half sizes (ax, ay) at step q, clockwise from the top right corner
    auto rect = [&](int q, float ax, float ay) {
        q %= N;
        const int side = q / Ms;
        const float tt = (side % 2 == 0 ? frV : frH)[q % Ms];
        switch (side) {
            case 0: return make_float2(ax, ay - 2 * ay * tt);
            case 1: return make_float2(ax - 2 * ax * tt, -ay);
            case 2: return make_float2(-ax, -ay + 2 * ay * tt);
            default: return make_float2(-ax + 2 * ax * tt, ay);
        }
    };
    for (int cj = 0; cj < nCv; ++cj)
        for (int ci = 0; ci < nCu; ++ci) {
            const float cx = u0 + (ci + 0.5f) * cu, cy = v0 + (cj + 0.5f) * cv, hx = 0.5f * cu, hy = 0.5f * cv;
            auto dir = [&](int q) {
                const float2 p = rect(q, hx, hy);
                const float l = std::hypot(p.x, p.y);
                return make_float2(p.x / l, p.y / l);
            };
            // the face round the hole: ring 0 the rim, 1 half way out, 2..4 the rectangle inset by w, w/2, 0
            k.grid(N, 4, [&](int i, int j) {
                float2 q;
                const float2 dr = dir(i);
                if (j == 0) q = make_float2(dr.x * rH, dr.y * rH);
                else if (j == 1) {
                    const float2 r2 = rect(i, hx - w, hy - w);
                    q = make_float2(0.5f * (dr.x * rH + r2.x), 0.5f * (dr.y * rH + r2.y));
                } else {
                    const float inset = j == 2 ? w : j == 3 ? 0.5f * w : 0.0f;
                    q = rect(i, hx - inset, hy - inset);
                }
                return point(cx + q.x, cy + q.y);
            });
            // the cone, from its bottom ring up to the rim (normals towards the axis and out of the face)
            k.grid(N, 1, [&](int i, int j) {
                const float2 dr = dir(i);
                const float rr = j ? rH : rB;
                Kit::GridPt g;
                g.p = v3(cx + dr.x * rr, cy + dr.y * rr, j ? 0.0f : -dH);
                g.n = normalize(v3(-dr.x * dH, -dr.y * dH, rH - rB));
                g.s = make_float2(g.p.x, g.p.y);
                return g;
            });
            k.grid(N, 1, [&](int i, int j) {
                const float2 dr = dir(i);
                Kit::GridPt g;
                g.p = v3(cx + dr.x * rB * j, cy + dr.y * rB * j, -dH);
                g.n = v3(0, 0, 1);
                g.s = make_float2(g.p.x, g.p.y);
                return g;
            });
        }
    oneChart(vm, cm);   // the planar coordinates of the cells, cones and bottoms never overlap
}

// ---------------------------------------------------------------------------------------------------------------------
// lofts

void Hall::loft(float3 c, float hx, float hz, float rc, const std::vector<float2>& profile0, int mat, int skipSide,
                float maxEdge) {
    at(Xform::at(c), mat, maxEdge);
    // the profile, long segments subdivided
    std::vector<float2> prof;
    for (size_t j = 0; j < profile0.size(); ++j) {
        if (j) {
            const float2 a = profile0[j - 1], b = profile0[j];
            const int n = std::max(1, int(std::ceil(std::hypot(b.x - a.x, b.y - a.y) / maxEdge)));
            for (int q = 1; q < n; ++q) prof.push_back(make_float2(a.x + (b.x - a.x) * q / n, a.y + (b.y - a.y) * q / n));
        }
        prof.push_back(profile0[j]);
    }
    const int R = int(prof.size());
    // profile normals (outward, up) from the neighbouring points
    std::vector<float2> pn(R);
    std::vector<float> pv(R, 0.0f);
    for (int j = 0; j < R; ++j) {
        const float2 a = prof[std::max(0, j - 1)], b = prof[std::min(R - 1, j + 1)];
        const float dx = b.x - a.x, dy = b.y - a.y, l = std::hypot(dx, dy);
        pn[j] = make_float2(dy / l, -dx / l);
        if (j) pv[j] = pv[j - 1] + std::hypot(prof[j].x - prof[j - 1].x, prof[j].y - prof[j - 1].y);
    }
    // the outline as segments: side 0 (+x, towards -z), corner, side 1 (-z, towards -x), corner, side 2, corner, side 3
    // Each outline point: a 2D position function of the offset and a fixed 2D normal
    struct OP { int kind; float a; int side; };   // kind 0: on a side at fraction a; 1: on a corner at angle a
    const int nc = 6;
    std::vector<OP> pts;
    // sides' subdivision from the base outline's lengths
    const float sideLen[4] = {2 * (hz - rc), 2 * (hx - rc), 2 * (hz - rc), 2 * (hx - rc)};
    auto addSide = [&](int sd, bool first, bool last) {
        const int n = std::max(1, int(std::ceil(sideLen[sd] / maxEdge)));
        for (int q = first ? 0 : 1; q <= (last ? n : n - 1); ++q) pts.push_back({0, float(q) / n, sd});
    };
    auto addCorner = [&](int sd, bool first, bool last) {   // the corner after side sd
        for (int q = first ? 0 : 1; q <= (last ? nc : nc - 1); ++q) pts.push_back({1, float(q) / nc, sd});
    };
    if (skipSide < 0) {
        for (int sd = 0; sd < 4; ++sd) {
            addSide(sd, sd == 0, true);
            addCorner(sd, false, sd == 3);
        }
    } else {
        for (int q = 0; q < 4; ++q) {
            const int sd = (skipSide + q) % 4;
            if (q > 0) addSide(sd, false, true);
            addCorner(sd, q == 0, q == 3);
        }
    }
    // side sd's outward normal and its direction of travel; corner sd sits between side sd and sd+1
    const float2 sn[4] = {{1, 0}, {0, -1}, {-1, 0}, {0, 1}};   // (x, z)
    auto place = [&](const OP& o, float off, float2& p, float2& n) {
        const float X = hx + off, Z = hz + off, r = rc + off;
        if (o.kind == 0) {
            const float tt = o.a;
            switch (o.side) {
                case 0: p = make_float2(X, (Z - r) - 2 * (Z - r) * tt); break;
                case 1: p = make_float2((X - r) - 2 * (X - r) * tt, -Z); break;
                case 2: p = make_float2(-X, -(Z - r) + 2 * (Z - r) * tt); break;
                default: p = make_float2(-(X - r) + 2 * (X - r) * tt, Z); break;
            }
            n = sn[o.side];
        } else {
            const float2 n0 = sn[o.side], n1 = sn[(o.side + 1) % 4];
            const float ang = 0.5f * kPi * o.a;
            n = make_float2(n0.x * std::cos(ang) + n1.x * std::sin(ang), n0.y * std::cos(ang) + n1.y * std::sin(ang));
            // the corner's centre: the outline's corner pulled in by r along both normals
            const float cx = (n0.x + n1.x) * (X - r), cz = (n0.y + n1.y) * (Z - r);
            p = make_float2(cx + n.x * r, cz + n.y * r);
        }
    };
    const int nu = int(pts.size()) - 1;
    // the surface coordinate along the outline: arc length on the base outline (rows share it: no shear at the seams)
    std::vector<float> su(pts.size(), 0.0f);
    for (size_t i = 1; i < pts.size(); ++i) {
        float2 a, b, na, nb;
        place(pts[i - 1], 0.0f, a, na);
        place(pts[i], 0.0f, b, nb);
        su[i] = su[i - 1] + std::hypot(b.x - a.x, b.y - a.y);
    }
    k.grid(nu, R - 1, [&](int i, int j) {
        float2 p, n;
        place(pts[i], prof[j].x, p, n);
        Kit::GridPt g;
        g.p = v3(p.x, prof[j].y, p.y);
        g.n = normalize(v3(n.x * pn[j].x, pn[j].y, n.y * pn[j].x));
        g.s = make_float2(su[i], pv[j]);
        return g;
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// railings, chains, lamps, plates

void Hall::railing(const std::vector<float3>& pts, float pitch, int mat, bool toePlate) {
    const float rTop = 0.0242f, rKnee = 0.0168f, rPost = 0.0242f;
    // posts: at every corner and between at most `pitch` apart
    for (size_t i = 0; i + 1 < pts.size(); ++i) {
        const float3 a = pts[i], b = pts[i + 1];
        const int n = std::max(1, int(std::ceil(length(b - a) / pitch - 1e-3f)));
        for (int q = (i == 0 ? 0 : 1); q <= n; ++q) {
            const float3 p = lerp3(a, b, float(q) / n);
            rod(p, p + v3(0, 1.1f, 0), rPost, mat, 0.6f);
            // a base plate under each post, two bolts
            box(p + v3(0, 0.005f, 0), v3(0.06f, 0.005f, 0.06f), 0.003f, mat, 0.2f);
        }
    }
    for (float hgt : {1.1f, 0.55f}) {
        std::vector<float3> run;
        for (const float3& p : pts) run.push_back(p + v3(0, hgt, 0));
        Kit& kk = at(Xform(), mat, 0.6f);
        dz::pipeRun(kk, run, hgt > 1.0f ? rTop : rKnee, 0.12f);
        // the run's ends closed by rounded caps
        const float r = hgt > 1.0f ? rTop : rKnee;
        for (int e = 0; e < 2; ++e) {
            const float3 p = e ? run.back() : run.front();
            at(Xform::at(p), mat, 0.02f).sphere(r);
        }
    }
    if (toePlate)
        for (size_t i = 0; i + 1 < pts.size(); ++i) {
            const float3 a = pts[i], b = pts[i + 1], d = b - a;
            if (std::fabs(d.y) > 0.01f || a.y < 0.5f) continue;   // level runs on a deck only (a stair has stringers)
            const float L = length(d);
            const Xform t = Xform::frame(0.5f * (a + b) + v3(0, 0.05f, 0), d, v3(0, 1, 0));
            box(t, v3(0.003f, 0.05f, 0.5f * L + 0.003f), 0.0025f, mat, 1.0f);
        }
}

void Hall::chain(float3 a, float3 b, float linkLength, float wire, int mat) {
    const size_t vm = vmark();
    const uint32_t cm = cmark();
    const float3 dir = normalize(b - a);
    const float len = length(b - a);
    const float d = 2.0f * wire;
    const float W = 0.7f * linkLength;              // outer width
    const float Rc = 0.5f * (W - d);                // the bends' centre-line radius
    const float Ls = (linkLength - d) - 2.0f * Rc;  // the straight legs
    const float pitch = linkLength - 2.0f * d;      // the inner length: each link hangs in the next one's bend
    const float3 e1 = std::fabs(dir.y) < 0.9f ? normalize(cross(dir, v3(0, 1, 0))) : normalize(cross(dir, v3(1, 0, 0)));
    const float3 e2 = cross(dir, e1);
    const int ns = 14, nw = 6;
    const float per = 2.0f * Ls + 2.0f * kPi * Rc;   // the centre line's length
    const int n = std::max(1, int(std::floor((len - linkLength) / pitch)) + 1);
    for (int i = 0; i < n; ++i) {
        const float3 c = a + dir * (0.5f * linkLength + i * pitch);
        const float3 side = (i % 2) ? e2 : e1;            // the link's width direction (alternating)
        const float3 bn = cross(dir, side);               // its plane's normal
        k.t = Xform();
        k.mat = uint32_t(mat);
        // the centre line, counter-clockwise in (dir, side): its point, tangent and outward normal at length s
        auto cl = [&](float sl, float3& p, float3& tg) {
            sl = std::fmod(sl, per);
            const float h = 0.5f * Ls;
            if (sl < Ls) {   // the leg on +side, from -h to +h along dir
                p = c + side * Rc + dir * (-h + sl);
                tg = dir;
                return;
            }
            sl -= Ls;
            if (sl < kPi * Rc) {   // the bend at +dir
                const float th = sl / Rc;
                p = c + dir * h + side * (Rc * std::cos(th)) + dir * (Rc * std::sin(th));
                tg = normalize(side * -std::sin(th) + dir * std::cos(th));
                return;
            }
            sl -= kPi * Rc;
            if (sl < Ls) {
                p = c - side * Rc + dir * (h - sl);
                tg = -dir;
                return;
            }
            sl -= Ls;
            const float th = sl / Rc;
            p = c - dir * h - side * (Rc * std::cos(th)) - dir * (Rc * std::sin(th));
            tg = normalize(side * std::sin(th) - dir * std::cos(th));
        };
        // the centre line runs (+side leg) -> bend -> (-side leg) -> bend: clockwise about bn = dir x side, so the
        // wire's angle turns the other way for the grid's winding to face out
        k.grid(ns, nw, [&](int ii, int jj) {
            float3 p, tg;
            cl(per * float(ii % ns) / ns, p, tg);
            float3 out = normalize(cross(tg, bn));
            if (dot(out, p - c) < 0) out = -out;
            const float ph = -2.0f * kPi * float(jj % nw) / nw;
            const float3 nn = out * std::cos(ph) + bn * std::sin(ph);
            Kit::GridPt g;
            g.p = p + nn * wire;
            g.n = nn;
            g.s = make_float2(per * float(ii) / ns, 2.0f * kPi * wire * float(jj) / nw);
            return g;
        });
    }
    packCharts(vm, cm, 0.02f);
}

float3 Hall::cagedLamp(float3 p, float3 n, float bulbR) {
    // in the lamp's frame: z out of the wall, y up
    const Xform f = facing(p, n);
    auto P = [&](float x, float y, float z) { return f.point(v3(x, y, z)); };
    // wall plate and the arm out to the holder
    box(facing(P(0, 0, 0.006f), n), v3(0.07f, 0.09f, 0.006f), 0.004f, M_KOYU, 0.1f);
    for (int q = 0; q < 4; ++q) nut(facing(P(q % 2 ? 0.045f : -0.045f, q / 2 ? 0.06f : -0.06f, 0.012f), n), 0.013f, M_KOYU);
    rod(P(0, 0, 0.01f), P(0, 0, 0.27f), 0.014f, M_KOYU, 0.1f);
    // the holder above the bulb and a small hood (a lathe about the vertical)
    const float3 top = P(0, -0.02f, 0.30f);
    at(Xform::frame(top, v3(0, -1, 0), n), M_KOYU, 0.02f);
    k.lathe({{0.0f, -0.035f}, {0.045f, -0.035f}, {0.05f, -0.03f}, {0.05f, 0.02f}, {0.12f, 0.08f}, {0.125f, 0.088f},
             {0.118f, 0.09f}, {0.045f, 0.035f}, {0.0f, 0.035f}});
    // the bulb, screwed into the holder
    const float3 bc = top + v3(0, -0.03f - bulbR, 0);
    at(Xform::at(bc), M_CAM_LAMBA, 0.02f).sphere(bulbR);
    // the cage: a half sphere of wire from the hood's lip down round the bulb: three hoops and two crossed bows
    const float rc = 0.125f;
    const float3 cs = top + v3(0, -0.09f, 0);
    for (float h : {0.0f, -0.45f, -0.8f}) {
        const float y = h * rc, R = std::sqrt(rc * rc - y * y);
        at(Xform::frame(cs + v3(0, y, 0), v3(0, 1, 0), n), M_KOYU, 0.03f).torus(R, 0.003f);
    }
    for (int q = 0; q < 2; ++q) {
        const float a = q * 0.5f * kPi;
        const float3 ax = v3(std::cos(a), 0, std::sin(a));   // the bow's plane holds the vertical and ax
        at(axes(cs, ax, v3(0, -1, 0), cross(ax, v3(0, -1, 0))), M_KOYU, 0.03f).torus(rc, 0.003f, 0.0f, kPi);
    }
    Emitter e;
    e.type = Emitter::SPHERE;
    e.group = GROUP_LAMBA;
    e.c = bc;
    e.r = bulbR;
    e.L = kLambaL;
    s.lights.push_back(e);
    return bc;
}

Xform Hall::levha(const std::string& name, const std::string& atlas, float3 c, float3 n, float w, float h, int mat,
                  float3 up) {
    const Xform f = facing(c, n, up);
    const size_t vm = vmark();
    at(f, mat, 100.0f).quad(w, h);
    for (size_t i = vm; i < s.mesh.v.size(); ++i) {
        dz::Vtx& v = s.mesh.v[i];
        v.uv2 = v.uv;   // metres for the light map
        v.uv = make_float2(v.uv.x / w + 0.5f, 0.5f - v.uv.y / h);
    }
    Anchor an;
    an.name = name;
    an.type = "levha";
    an.box = {c, f.x * (0.5f * w), f.y * (0.5f * h), f.z * 0.01f};
    an.atlas = atlas;
    an.size[0] = w;
    an.size[1] = h;
    an.material = mat;
    s.anchors.push_back(an);
    return f;
}

void Hall::anchor(const std::string& name, const std::string& type, const Xform& t, float3 half) {
    Anchor an;
    an.name = name;
    an.type = type;
    an.box = {t.o, t.x * half.x, t.y * half.y, t.z * half.z};
    s.anchors.push_back(an);
}

void Hall::anchorBox(const std::string& name, const std::string& type, float3 lo, float3 hi) {
    anchor(name, type, Xform::at(0.5f * (lo + hi)), 0.5f * (hi - lo));
}

// ---------------------------------------------------------------------------------------------------------------------
// charts

void Hall::oneChart(size_t firstVertex, uint32_t firstChart) {
    if (firstVertex >= s.mesh.v.size()) return;
    for (size_t i = firstVertex; i < s.mesh.v.size(); ++i) s.mesh.v[i].chart = firstChart;
    s.mesh.charts = firstChart + 1;
}

void Hall::packCharts(size_t firstVertex, uint32_t firstChart, float gap) {
    Mesh& m = s.mesh;
    if (firstVertex >= m.v.size()) return;
    struct Piece { size_t b, e; float2 lo, hi; };
    std::vector<Piece> ps;
    for (size_t i = firstVertex; i < m.v.size();) {
        size_t j = i;
        Piece p{i, i, {1e30f, 1e30f}, {-1e30f, -1e30f}};
        while (j < m.v.size() && m.v[j].chart == m.v[i].chart) {
            p.lo = make_float2(std::min(p.lo.x, m.v[j].uv.x), std::min(p.lo.y, m.v[j].uv.y));
            p.hi = make_float2(std::max(p.hi.x, m.v[j].uv.x), std::max(p.hi.y, m.v[j].uv.y));
            ++j;
        }
        p.e = j;
        ps.push_back(p);
        i = j;
    }
    double area = 0;
    float widest = 0;
    for (const Piece& p : ps) {
        area += double(p.hi.x - p.lo.x + gap) * (p.hi.y - p.lo.y + gap);
        widest = std::max(widest, p.hi.x - p.lo.x);
    }
    const float rowW = std::max(widest, float(std::sqrt(area)) * 1.3f);
    float x = 0, y = 0, rowH = 0;
    for (const Piece& p : ps) {
        const float w = p.hi.x - p.lo.x, h = p.hi.y - p.lo.y;
        if (x > 0 && x + w > rowW) {
            x = 0;
            y += rowH + gap;
            rowH = 0;
        }
        for (size_t i = p.b; i < p.e; ++i) {
            m.v[i].uv = make_float2(m.v[i].uv.x - p.lo.x + x, m.v[i].uv.y - p.lo.y + y);
            m.v[i].chart = firstChart;
        }
        x += w + gap;
        rowH = std::max(rowH, h);
    }
    m.charts = firstChart + 1;
}

}   // namespace salon::hall
