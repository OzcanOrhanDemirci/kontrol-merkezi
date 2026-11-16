#include "scene/dump.h"

#include <filesystem>
#include <fstream>
#include <iomanip>
#include <stdexcept>

namespace salon {

namespace {

void vec(std::ostream& o, float3 v) { o << '[' << v.x << ',' << v.y << ',' << v.z << ']'; }

void mesh(const Mesh& m, const std::string& file) {
    std::ofstream o(file, std::ios::binary);
    const uint32_t h[4] = {0x3144474bu /* KGD1 */, uint32_t(m.v.size()), uint32_t(m.idx.size()), 48u};
    o.write(reinterpret_cast<const char*>(h), sizeof(h));
    for (const auto& v : m.v) {
        const float a[12] = {v.p.x, v.p.y, v.p.z, v.n.x, v.n.y, v.n.z, v.uv.x, v.uv.y, v.uv2.x, v.uv2.y, float(v.mat), float(v.chart)};
        o.write(reinterpret_cast<const char*>(a), sizeof(a));
    }
    o.write(reinterpret_cast<const char*>(m.idx.data()), std::streamsize(m.idx.size() * 4));
    if (!o) throw std::runtime_error("cannot write " + file);
}

void view(std::ostream& o, const View& v) {
    o << "{\"eye\":";
    vec(o, v.eye);
    o << ",\"target\":";
    vec(o, v.target);
    o << ",\"fov\":" << v.fov << '}';
}

}   // namespace

bool dumpScene(const Scene& s, const std::string& dir, std::string& err) {
    try {
        std::filesystem::create_directories(dir);
        mesh(s.mesh, dir + "/static.bin");
        std::ofstream o(dir + "/dump.json");
        o << std::setprecision(8);
        o << "{\"format\":\"KGD1\",\"static\":\"static.bin\",\"triangles\":" << s.mesh.tris() << ",\"charts\":" << s.mesh.charts;
        o << ",\"materials\":[";
        for (size_t i = 0; i < s.mats.size(); ++i) {
            const Material& m = s.mats[i];
            o << (i ? "," : "") << "{\"name\":\"" << m.name << "\",\"colour\":";
            vec(o, m.meanAlbedo);
            o << ",\"flags\":" << m.flags << ",\"group\":" << m.group << ",\"emission\":" << m.emitScale << '}';
        }
        o << "],\"dynamic\":[";
        for (size_t i = 0; i < s.dyn.size(); ++i) {
            const Dynamic& d = s.dyn[i];
            mesh(d.mesh, dir + "/" + d.name + ".bin");
            o << (i ? "," : "") << "{\"name\":\"" << d.name << "\",\"file\":\"" << d.name << ".bin\",\"centre\":";
            vec(o, d.centre);
            o << ",\"axis\":";
            vec(o, d.axis);
            o << ",\"radius\":" << d.radius << ",\"blades\":" << d.blades << ",\"bakeTransmit\":" << d.bakeTransmit
              << ",\"triangles\":" << d.mesh.tris() << '}';
        }
        o << "],\"anchors\":[";
        for (size_t i = 0; i < s.anchors.size(); ++i) {
            const Anchor& a = s.anchors[i];
            o << (i ? "," : "") << "{\"name\":\"" << a.name << "\",\"type\":\"" << a.type << "\",\"atlas\":\"" << a.atlas
              << "\",\"size\":[" << a.size[0] << ',' << a.size[1] << "],\"material\":" << a.material << ",\"c\":";
            vec(o, a.box.c);
            o << ",\"x\":";
            vec(o, a.box.x);
            o << ",\"y\":";
            vec(o, a.box.y);
            o << ",\"z\":";
            vec(o, a.box.z);
            o << ",\"pivot\":";
            vec(o, a.pivot);
            o << ",\"axis\":";
            vec(o, a.axis);
            o << '}';
        }
        o << "],\"lights\":[";
        for (size_t i = 0; i < s.lights.size(); ++i) {
            const Emitter& e = s.lights[i];
            o << (i ? "," : "") << "{\"type\":" << e.type << ",\"group\":" << e.group << ",\"c\":";
            vec(o, e.c);
            o << ",\"u\":";
            vec(o, e.u);
            o << ",\"v\":";
            vec(o, e.v);
            o << ",\"n\":";
            vec(o, e.n);
            o << ",\"r\":" << e.r << ",\"L\":" << e.L << ",\"lobe\":" << e.lobe << '}';
        }
        o << "],\"volumes\":[";
        for (size_t i = 0; i < s.vols.size(); ++i) {
            const Volume& v = s.vols[i];
            o << (i ? "," : "") << "{\"name\":\"" << v.name << "\",\"lo\":";
            vec(o, v.lo);
            o << ",\"cell\":" << v.cell << ",\"dim\":[" << v.dim[0] << ',' << v.dim[1] << ',' << v.dim[2] << "]}";
        }
        o << "],\"views\":{\"fanlar\":";
        view(o, s.fanlar);
        o << ",\"rgb\":";
        view(o, s.rgb);
        o << "},\"path\":[";
        for (size_t i = 0; i < s.path.size(); ++i) {
            o << (i ? "," : "");
            vec(o, s.path[i]);
        }
        o << "]}\n";
        if (!o) throw std::runtime_error("cannot write dump.json");
        return true;
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
}

}   // namespace salon
