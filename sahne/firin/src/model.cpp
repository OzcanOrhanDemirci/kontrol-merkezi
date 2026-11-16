// glTF import with cgltf (MIT, C:/dev/pc_graphics/third_party/cgltf), the albedo's mean with stb_image and the
// occlusion-less ARM's copy with stb_image_write (MIT / public domain, pc_graphics third_party/stb), light map charts
// with xatlas (MIT, third_party/xatlas).
#include "model.h"

#define CGLTF_IMPLEMENTATION
#include <cgltf.h>
#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>
#include <xatlas.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <memory>
#include <stdexcept>

namespace salon {

namespace fs = std::filesystem;

namespace {

float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }

// a texture's image file (external only: Poly Haven's glTF keeps them beside it)
fs::path imageOf(const cgltf_texture_view& view, const fs::path& dir) {
    if (!view.texture || !view.texture->image) return {};
    const cgltf_image* im = view.texture->image;
    if (!im->uri || std::strncmp(im->uri, "data:", 5) == 0) throw std::runtime_error("only external texture images are supported");
    std::string uri = im->uri;
    cgltf_decode_uri(uri.data());
    uri.resize(std::strlen(uri.c_str()));
    const fs::path p = (dir / fs::u8path(uri)).lexically_normal();
    if (!fs::exists(p)) throw std::runtime_error("missing texture " + p.string());
    return p;
}

float3 meanLinear(const fs::path& image) {
    static std::map<fs::path, float3> known;   // a kit placed piece by piece decodes each image once
    if (auto it = known.find(image); it != known.end()) return it->second;
    int w = 0, h = 0, c = 0;
    unsigned char* px = stbi_load(image.string().c_str(), &w, &h, &c, 3);
    if (!px) throw std::runtime_error("cannot decode " + image.string());
    float lut[256];
    for (int i = 0; i < 256; ++i) lut[i] = srgbToLinear(i / 255.0f);
    double sum[3] = {};
    const size_t n = size_t(w) * h;
    for (size_t k = 0; k < n; ++k)
        for (int j = 0; j < 3; ++j) sum[j] += lut[px[k * 3 + j]];
    stbi_image_free(px);
    return known[image] = make_float3(float(sum[0] / n), float(sum[1] / n), float(sum[2] / n));
}

// Poly Haven packs ambient occlusion in the ARM map's red channel, but some models carry none there (all but black:
// metal_trash_can, modular_airduct_circular_01), and the renderer multiplies the diffuse light by it. Such a map is
// replaced by a copy beside it with the red channel white (<stem>_ao1.png, made once, the same bytes every time).
fs::path occlusionFixed(const fs::path& arm) {
    const fs::path fixed = arm.parent_path() / (arm.stem().string() + "_ao1.png");
    if (fs::exists(fixed)) return fixed;
    int w = 0, h = 0, c = 0;
    unsigned char* px = stbi_load(arm.string().c_str(), &w, &h, &c, 3);
    if (!px) throw std::runtime_error("cannot decode " + arm.string());
    const size_t n = size_t(w) * h;
    double red = 0;
    for (size_t k = 0; k < n; ++k) red += px[k * 3];
    if (red / n > 0.05 * 255) {   // occlusion is there
        stbi_image_free(px);
        return arm;
    }
    for (size_t k = 0; k < n; ++k) px[k * 3] = 255;
    const fs::path tmp = fixed.string() + ".tmp";
    const bool ok = stbi_write_png(tmp.string().c_str(), w, h, 3, px, w * 3) != 0;
    stbi_image_free(px);
    if (!ok) throw std::runtime_error("cannot write " + tmp.string());
    fs::rename(tmp, fixed);
    std::printf("model: %s has no occlusion in red: %s (red = 1)\n", arm.filename().string().c_str(),
                fixed.filename().string().c_str());
    return fixed;
}

fs::path withOcclusion(const fs::path& arm) {
    if (arm.empty()) return arm;
    static std::map<fs::path, fs::path> known;   // decoded once per image
    if (auto it = known.find(arm); it != known.end()) return it->second;
    return known[arm] = occlusionFixed(arm);
}

}   // namespace

bool importModel(Scene& s, const std::string& path, const dz::Xform& t, float scale, std::string& err,
                 const std::vector<std::string>& only) {
    try {
        if (!(scale > 0)) throw std::runtime_error("the model's scale must be positive");
        cgltf_options opt{};
        cgltf_data* raw = nullptr;
        if (cgltf_parse_file(&opt, path.c_str(), &raw) != cgltf_result_success) throw std::runtime_error("cannot parse " + path);
        std::unique_ptr<cgltf_data, decltype(&cgltf_free)> data(raw, cgltf_free);
        if (cgltf_load_buffers(&opt, raw, path.c_str()) != cgltf_result_success || cgltf_validate(raw) != cgltf_result_success)
            throw std::runtime_error("invalid glTF or missing buffers: " + path);
        const fs::path dir = fs::absolute(fs::path(path)).parent_path();
        fs::path assets = dir;   // sahne/varlik: texture paths are relative to it
        while (assets.filename() != "varlik" && assets.has_parent_path() && assets != assets.parent_path()) assets = assets.parent_path();
        if (assets.filename() != "varlik") throw std::runtime_error("the model must lie below sahne/varlik: " + path);
        auto rel = [&](const fs::path& p) { return p.empty() ? std::string() : fs::relative(p, assets).generic_string(); };

        // ---- materials (index = glTF material; one more if a primitive has none)
        const uint32_t matBase = uint32_t(s.mats.size());
        std::vector<Material> mats;
        for (size_t i = 0; i < raw->materials_count; ++i) {
            const cgltf_material& g = raw->materials[i];
            const cgltf_pbr_metallic_roughness& pbr = g.pbr_metallic_roughness;
            Material m;
            m.name = g.name ? g.name : fs::path(path).stem().string() + "_" + std::to_string(i);
            m.tint = make_float3(pbr.base_color_factor[0], pbr.base_color_factor[1], pbr.base_color_factor[2]);
            const fs::path al = imageOf(pbr.base_color_texture, dir), arm = withOcclusion(imageOf(pbr.metallic_roughness_texture, dir));
            m.albedo = rel(al);
            m.normal = rel(imageOf(g.normal_texture, dir));
            m.arm = rel(arm);   // Poly Haven's ARM: occlusion, roughness, metal (glTF's G and B channels)
            m.emission = rel(imageOf(g.emissive_texture, dir));
            if (arm.empty()) {   // constants; with the texture -1 (from it) and the factors (1 in Poly Haven's) dropped
                m.rough = pbr.roughness_factor;
                m.metal = pbr.metallic_factor;
            } else if (pbr.roughness_factor != 1.0f || pbr.metallic_factor != 1.0f) {
                std::printf("model: material %s scales its ARM texture (roughness %g, metal %g); the factors are ignored\n",
                            m.name.c_str(), pbr.roughness_factor, pbr.metallic_factor);
            }
            if (g.double_sided) m.flags |= MF_TWO_SIDED;
            m.uvScale = 1.0f;
            m.meanAlbedo = al.empty() ? m.tint : meanLinear(al) * m.tint;
            mats.push_back(m);
        }
        bool needDefault = false;

        // ---- triangles of every mesh node of the scene, in world placement
        Mesh mesh;
        std::vector<const cgltf_node*> nodes;
        auto visit = [&](auto&& self, const cgltf_node* n) -> void {
            nodes.push_back(n);
            for (size_t j = 0; j < n->children_count; ++j) self(self, n->children[j]);
        };
        const cgltf_scene* scene = raw->scene ? raw->scene : raw->scenes_count ? raw->scenes : nullptr;
        if (scene) {
            for (size_t i = 0; i < scene->nodes_count; ++i) visit(visit, scene->nodes[i]);
        } else {
            for (size_t i = 0; i < raw->nodes_count; ++i)
                if (!raw->nodes[i].parent) visit(visit, &raw->nodes[i]);
        }
        for (const std::string& name : only)
            if (std::none_of(nodes.begin(), nodes.end(), [&](const cgltf_node* n) { return n->mesh && n->name && name == n->name; }))
                throw std::runtime_error("no mesh node " + name + " in " + path);
        for (const cgltf_node* node : nodes) {
            if (!node->mesh) continue;
            if (!only.empty() && (!node->name || std::find(only.begin(), only.end(), node->name) == only.end())) continue;
            float w[16];
            cgltf_node_transform_world(node, w);
            const float3 X = t.dir(make_float3(w[0], w[1], w[2])) * scale, Y = t.dir(make_float3(w[4], w[5], w[6])) * scale,
                         Z = t.dir(make_float3(w[8], w[9], w[10])) * scale;
            const float3 O = t.point(make_float3(w[12], w[13], w[14]) * scale);
            const float det = dot(X, cross(Y, Z));
            if (std::fabs(det) < 1e-15f) throw std::runtime_error("a singular node transform");
            const float3 NX = cross(Y, Z), NY = cross(Z, X), NZ = cross(X, Y);   // the normals' matrix (cofactors)
            for (size_t pi = 0; pi < node->mesh->primitives_count; ++pi) {
                const cgltf_primitive& p = node->mesh->primitives[pi];
                if (p.type != cgltf_primitive_type_triangles) throw std::runtime_error("a primitive that is not triangles");
                const cgltf_accessor *pos = nullptr, *nor = nullptr, *uv = nullptr;
                for (size_t j = 0; j < p.attributes_count; ++j) {
                    const cgltf_attribute& at = p.attributes[j];
                    if (at.type == cgltf_attribute_type_position) pos = at.data;
                    if (at.type == cgltf_attribute_type_normal) nor = at.data;
                    if (at.type == cgltf_attribute_type_texcoord && at.index == 0) uv = at.data;
                }
                if (!pos) throw std::runtime_error("a primitive without POSITION");
                uint32_t mat;
                if (p.material) {
                    mat = matBase + uint32_t(p.material - raw->materials);
                } else {
                    mat = matBase + uint32_t(raw->materials_count);
                    needDefault = true;
                }
                const uint32_t first = uint32_t(mesh.v.size());
                for (size_t j = 0; j < pos->count; ++j) {
                    float a[3] = {}, n[3] = {0, 1, 0}, u[2] = {};
                    cgltf_accessor_read_float(pos, j, a, 3);
                    if (nor) cgltf_accessor_read_float(nor, j, n, 3);
                    if (uv) cgltf_accessor_read_float(uv, j, u, 2);
                    dz::Vtx v{};
                    v.p = O + X * a[0] + Y * a[1] + Z * a[2];
                    v.n = normalize((NX * n[0] + NY * n[1] + NZ * n[2]) * (1.0f / det));
                    v.dn = v.n;
                    v.uv = make_float2(u[0], u[1]);
                    v.mat = mat;
                    mesh.v.push_back(v);
                }
                const size_t count = p.indices ? p.indices->count : pos->count;
                for (size_t j = 0; j + 2 < count; j += 3) {
                    uint32_t ix[3];
                    for (int k = 0; k < 3; ++k) ix[k] = first + uint32_t(p.indices ? cgltf_accessor_read_index(p.indices, j + k) : j + k);
                    if (det < 0) std::swap(ix[1], ix[2]);   // a mirroring transform keeps the winding outward
                    mesh.idx.insert(mesh.idx.end(), ix, ix + 3);
                    if (!nor) {   // no normals: the face's
                        const float3 fn = normalize(cross(mesh.v[ix[1]].p - mesh.v[ix[0]].p, mesh.v[ix[2]].p - mesh.v[ix[0]].p));
                        for (uint32_t q : ix) mesh.v[q].n = mesh.v[q].dn = fn;
                    }
                }
            }
        }
        // exporters leave unused vertices and zero-area triangles: no surface to light
        {
            Mesh clean;
            std::vector<int32_t> remap(mesh.v.size(), -1);
            for (size_t k = 0; k + 2 < mesh.idx.size(); k += 3) {
                const uint32_t a = mesh.idx[k], b = mesh.idx[k + 1], c = mesh.idx[k + 2];
                if (length(cross(mesh.v[b].p - mesh.v[a].p, mesh.v[c].p - mesh.v[a].p)) < 1e-10f) continue;
                for (uint32_t i : {a, b, c}) {
                    if (remap[i] < 0) {
                        remap[i] = int32_t(clean.v.size());
                        clean.v.push_back(mesh.v[i]);
                    }
                    clean.idx.push_back(uint32_t(remap[i]));
                }
            }
            mesh = std::move(clean);
        }
        if (mesh.idx.empty()) throw std::runtime_error("the model has no triangles: " + path);

        // ---- light map charts with xatlas (in world metres: the positions are placed already)
        std::unique_ptr<xatlas::Atlas, decltype(&xatlas::Destroy)> xa(xatlas::Create(), xatlas::Destroy);
        std::vector<uint32_t> faceMat;
        for (size_t k = 0; k < mesh.idx.size(); k += 3) faceMat.push_back(mesh.v[mesh.idx[k]].mat);
        xatlas::MeshDecl decl;
        decl.vertexCount = uint32_t(mesh.v.size());
        decl.vertexPositionData = &mesh.v[0].p;
        decl.vertexPositionStride = sizeof(dz::Vtx);
        decl.vertexNormalData = &mesh.v[0].n;
        decl.vertexNormalStride = sizeof(dz::Vtx);
        decl.indexData = mesh.idx.data();
        decl.indexCount = uint32_t(mesh.idx.size());
        decl.indexFormat = xatlas::IndexFormat::UInt32;
        decl.faceMaterialData = faceMat.data();   // a chart never spans two materials (draw ranges are per material)
        if (xatlas::AddMesh(xa.get(), decl) != xatlas::AddMeshError::Success) throw std::runtime_error("xatlas rejected the model");
        xatlas::PackOptions pack;
        pack.texelsPerUnit = 256.0f;   // only for the charts' coordinates: they are rescaled to metres below
        pack.padding = 1;
        xatlas::Generate(xa.get(), xatlas::ChartOptions(), pack);
        const xatlas::Mesh& am = xa->meshes[0];
        Mesh out;
        out.charts = am.chartCount;
        for (uint32_t i = 0; i < am.vertexCount; ++i) {
            const xatlas::Vertex& av = am.vertexArray[i];
            dz::Vtx v = mesh.v[av.xref];
            v.chart = av.chartIndex < 0 ? UINT32_MAX : uint32_t(av.chartIndex);
            v.uv2 = make_float2(av.uv[0], av.uv[1]);
            out.v.push_back(v);
        }
        // the faces xatlas found degenerate (its own area test) are in no chart: no surface to light, left out
        size_t dropped = 0;
        for (uint32_t k = 0; k + 2 < am.indexCount; k += 3) {
            const uint32_t* f = &am.indexArray[k];
            if (out.v[f[0]].chart == UINT32_MAX || out.v[f[1]].chart == UINT32_MAX || out.v[f[2]].chart == UINT32_MAX) {
                ++dropped;
                continue;
            }
            out.idx.insert(out.idx.end(), f, f + 3);
        }
        for (auto& v : out.v)
            if (v.chart == UINT32_MAX) v.chart = 0;   // unused now
        if (dropped) std::printf("model: %zu degenerate faces left out\n", dropped);
        // every chart's coordinates scaled so its area is its surface's area: metres, whatever xatlas' packing did
        std::vector<double> worldArea(am.chartCount, 0.0), chartArea(am.chartCount, 0.0);
        for (size_t k = 0; k + 2 < out.idx.size(); k += 3) {
            const dz::Vtx &a = out.v[out.idx[k]], &b = out.v[out.idx[k + 1]], &c = out.v[out.idx[k + 2]];
            worldArea[a.chart] += length(cross(b.p - a.p, c.p - a.p));
            chartArea[a.chart] += std::fabs((b.uv2.x - a.uv2.x) * (c.uv2.y - a.uv2.y) - (c.uv2.x - a.uv2.x) * (b.uv2.y - a.uv2.y));
        }
        for (auto& v : out.v) {
            const float f = chartArea[v.chart] > 0 ? float(std::sqrt(worldArea[v.chart] / chartArea[v.chart])) : 1.0f / pack.texelsPerUnit;
            v.uv2 = v.uv2 * f;
        }
        dz::finishMesh(out);   // displacement normals and tangents (along the model's uv)

        if (needDefault) {
            Material m;
            m.name = fs::path(path).stem().string() + "_varsayilan";
            m.meanAlbedo = make_float3(0.5f, 0.5f, 0.5f);
            mats.push_back(m);
        }
        // the model's materials: one row per distinct material, shared by every placement of the model (a draw range
        // and a texture layer per material, not per copy); only the ones its triangles use are added
        std::vector<uint32_t> matId(mats.size(), UINT32_MAX);
        std::vector<char> used(mats.size(), 0);
        for (const auto& v : out.v) used[v.mat - matBase] = 1;
        for (size_t i = 0; i < mats.size(); ++i) {
            if (!used[i]) continue;
            const Material& m = mats[i];
            for (size_t j = 0; j < s.mats.size() && matId[i] == UINT32_MAX; ++j) {
                const Material& o = s.mats[j];
                if (o.name == m.name && o.albedo == m.albedo && o.normal == m.normal && o.arm == m.arm && o.emission == m.emission &&
                    o.flags == m.flags && o.rough == m.rough && o.metal == m.metal && o.tint.x == m.tint.x && o.tint.y == m.tint.y &&
                    o.tint.z == m.tint.z)
                    matId[i] = uint32_t(j);
            }
            if (matId[i] == UINT32_MAX) {
                matId[i] = uint32_t(s.mats.size());
                s.mats.push_back(m);
            }
        }
        for (auto& v : out.v) v.mat = matId[v.mat - matBase];
        s.mesh.append(out, dz::Xform{});
        std::printf("model %s: %zu triangles, %u charts, %zu materials\n", fs::path(path).filename().string().c_str(), out.tris(),
                    out.charts, mats.size());
        return true;
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
}

}   // namespace salon
