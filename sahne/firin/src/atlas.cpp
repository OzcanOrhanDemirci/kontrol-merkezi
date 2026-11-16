// The light map atlas: every chart gets a rectangle at its own density (from its distance to the camera's journey),
// shelf-packed on pages; then the texels are rasterised back onto the surface. Ported from pc_graphics' Denizaltı
// (dz_atlas.cpp), extended with per-chart density and pages.
#include "atlas.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>

namespace salon {

namespace {

float pointSegment(float3 p, float3 a, float3 b) {
    const float3 d = b - a;
    const float t = std::clamp(dot(p - a, d) / std::max(dot(d, d), 1e-20f), 0.0f, 1.0f);
    return length(p - (a + d * t));
}

float pointTriangle(float3 p, float3 a, float3 b, float3 c) {
    const float3 n = cross(b - a, c - a);
    const float nn = dot(n, n);
    if (nn > 1e-20f) {
        const float3 q = p - n * (dot(p - a, n) / nn);   // p projected on the triangle's plane
        if (dot(cross(b - a, q - a), n) >= 0 && dot(cross(c - b, q - b), n) >= 0 && dot(cross(a - c, q - c), n) >= 0)
            return length(q - p);
    }
    return std::min({pointSegment(p, a, b), pointSegment(p, b, c), pointSegment(p, c, a)});
}

// the closest distance between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9)
float segmentSegment(float3 p1, float3 q1, float3 p2, float3 q2) {
    const float3 d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2;
    const float a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    float s = 0, t = 0;
    if (a <= 1e-20f && e <= 1e-20f) return length(r);
    if (a <= 1e-20f) {
        t = std::clamp(f / e, 0.0f, 1.0f);
    } else {
        const float c = dot(d1, r);
        if (e <= 1e-20f) {
            s = std::clamp(-c / a, 0.0f, 1.0f);
        } else {
            const float b = dot(d1, d2), den = a * e - b * b;
            s = den > 1e-20f ? std::clamp((b * f - c * e) / den, 0.0f, 1.0f) : 0.0f;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = std::clamp(-c / a, 0.0f, 1.0f); }
            else if (t > 1) { t = 1; s = std::clamp((b - c) / a, 0.0f, 1.0f); }
        }
    }
    return length((p1 + d1 * s) - (p2 + d2 * t));
}

float segmentTriangle(float3 p, float3 q, float3 a, float3 b, float3 c) {
    const float3 n = cross(b - a, c - a);
    const float den = dot(q - p, n);
    if (std::fabs(den) > 1e-20f) {   // the segment crosses the plane inside the triangle: distance 0
        const float t = dot(a - p, n) / den;
        if (t >= 0 && t <= 1 && pointTriangle(p + (q - p) * t, a, b, c) < 1e-6f) return 0.0f;
    }
    return std::min({pointTriangle(p, a, b, c), pointTriangle(q, a, b, c), segmentSegment(p, q, a, b),
                     segmentSegment(p, q, b, c), segmentSegment(p, q, c, a)});
}

}   // namespace

Atlas buildAtlas(Scene& s, const BakeOptions& o, std::vector<int>& chartPage) {
    if (o.atlasWidth < 64 || o.atlasWidth > 16384 || !(o.texelScale > 0))
        throw std::runtime_error("atlas: width must be 64..16384 and the texel scale positive");
    Atlas a;
    a.width = a.height = o.atlasWidth;
    Mesh& m = s.mesh;
    uint32_t nc = m.charts;
    for (const auto& v : m.v) nc = std::max(nc, v.chart + 1);
    a.charts.assign(nc, {});
    chartPage.assign(nc, -1);

    // every chart's extent in its own coordinates (metres, uv2 as the builder left it)
    struct Bounds { float2 lo{FLT_MAX, FLT_MAX}, hi{-FLT_MAX, -FLT_MAX}; float d = FLT_MAX; bool used = false; };
    std::vector<Bounds> b(nc);
    for (const auto& v : m.v) {
        Bounds& c = b[v.chart];
        c.used = true;
        c.lo = make_float2(std::min(c.lo.x, v.uv2.x), std::min(c.lo.y, v.uv2.y));
        c.hi = make_float2(std::max(c.hi.x, v.uv2.x), std::max(c.hi.y, v.uv2.y));
    }
    // its smallest distance to the journey (the polyline and the two eyes): per triangle in parallel, then per chart
    const int64_t nt = int64_t(m.tris());
    std::vector<float> triD(static_cast<size_t>(nt));
    // the density zones (Scene::zones): charts off the journey that take their distance from the walk lines
    std::vector<int> zoneOf(nc, -1);
    for (size_t z = 0; z < s.zones.size(); ++z)
        for (uint32_t c = s.zones[z].first; c < s.zones[z].end && c < nc; ++c) zoneOf[c] = int(z);
#pragma omp parallel for schedule(dynamic, 4096)
    for (int64_t k = 0; k < nt; ++k) {
        const float3 p0 = m.v[m.idx[3 * k]].p, p1 = m.v[m.idx[3 * k + 1]].p, p2 = m.v[m.idx[3 * k + 2]].p;
        const int zi = zoneOf[m.v[m.idx[3 * k]].chart];
        float d = FLT_MAX;
        if (zi < 0 || s.zones[size_t(zi)].journey) {
            d = std::min(pointTriangle(s.fanlar.eye, p0, p1, p2), pointTriangle(s.rgb.eye, p0, p1, p2));
            for (size_t j = 1; j < s.path.size(); ++j) d = std::min(d, segmentTriangle(s.path[j - 1], s.path[j], p0, p1, p2));
        }
        if (zi >= 0) {
            for (const auto& w : s.walk) {
                if (w.size() == 1) d = std::min(d, pointTriangle(w[0], p0, p1, p2));
                for (size_t j = 1; j < w.size(); ++j) d = std::min(d, segmentTriangle(w[j - 1], w[j], p0, p1, p2));
            }
            d = std::max(d, s.zones[size_t(zi)].dMin);
        }
        triD[size_t(k)] = d;
    }
    for (int64_t k = 0; k < nt; ++k) {
        const uint32_t c = m.v[m.idx[3 * k]].chart;
        if (m.v[m.idx[3 * k + 1]].chart != c || m.v[m.idx[3 * k + 2]].chart != c)
            throw std::runtime_error("atlas: triangle " + std::to_string(k) + " crosses light map charts");
        b[c].d = std::min(b[c].d, triD[size_t(k)]);
    }

    // rectangles at each chart's density; a chart too big for a page at its density is made coarser to fit
    std::vector<int> order;
    int coarsened = 0;
    for (uint32_t i = 0; i < nc; ++i) {
        if (!b[i].used) continue;
        Atlas::Chart& c = a.charts[i];
        const float sx = b[i].hi.x - b[i].lo.x, sy = b[i].hi.y - b[i].lo.y;
        c.texel = texelFor(s, b[i].d) * o.texelScale;
        if (zoneOf[i] >= 0) c.texel *= s.zones[size_t(zoneOf[i])].texelMul;
        const float fit = std::max(sx, sy) / float(a.width - 2 * a.pad - 2);
        if (c.texel < fit) {
            c.texel = fit;
            ++coarsened;
        }
        c.w = int(std::ceil(sx / c.texel)) + 1 + 2 * a.pad;
        c.h = int(std::ceil(sy / c.texel)) + 1 + 2 * a.pad;
        order.push_back(int(i));
    }
    if (coarsened) std::printf("atlas: %d charts larger than a page at their density were made coarser\n", coarsened);

    // shelves, tallest first, page after page
    std::sort(order.begin(), order.end(), [&](int i, int j) {
        const Atlas::Chart &p = a.charts[i], &q = a.charts[j];
        return p.h != q.h ? p.h > q.h : p.w != q.w ? p.w > q.w : i < j;
    });
    // first fit: a chart goes on the first shelf (of any page) with room left at its end, else on a new shelf. The
    // charts come tallest first, so every earlier shelf is tall enough; the small ones fill the shelves' ends (a shelf
    // opened only when the next chart did not fit left up to a quarter of the pages empty: the walk's surfaces then
    // overflowed the hall's three pages into a fourth)
    struct Shelf { int page, y, h, x; };
    std::vector<Shelf> shelves;
    int page = 0, top = 0;
    for (int i : order) {
        Atlas::Chart& c = a.charts[i];
        Shelf* at = nullptr;
        for (size_t k = 0; k < shelves.size() && !at; ++k)
            if (shelves[k].x + c.w <= a.width && shelves[k].h >= c.h) at = &shelves[k];
        if (!at) {
            if (top + c.h > a.height) {
                ++page;
                top = 0;
            }
            shelves.push_back({page, top, c.h, 0});
            top += c.h;
            at = &shelves.back();
        }
        c.page = at->page;
        c.x = at->x;
        c.y = at->y;
        chartPage[i] = at->page;
        at->x += c.w;
    }
    a.pages = order.empty() ? 0 : page + 1;
    // pages as tall as their tallest use (a texture array's layers share one size): an atlas that fills a fraction of a
    // page must not be stored, decompressed and uploaded as a whole page (8192 x 8192 x 3 groups was 2.4 GB)
    int usedH = 0;
    for (int i : order) usedH = std::max(usedH, a.charts[i].y + a.charts[i].h);
    a.height = std::max(4, (usedH + 3) / 4 * 4);
    if (o.pages > 0 && a.pages > o.pages)
        throw std::runtime_error("atlas: " + std::to_string(a.pages) + " pages, more than the " + std::to_string(o.pages) + " allowed");

    // uv2 into the page: the chart's lower corner on the centre of its first texel inside the padding
    for (auto& v : m.v) {
        const Atlas::Chart& c = a.charts[v.chart];
        const Bounds& cb = b[v.chart];
        v.uv2 = make_float2((c.x + a.pad + 0.5f + (v.uv2.x - cb.lo.x) / c.texel) / a.width,
                            (c.y + a.pad + 0.5f + (v.uv2.y - cb.lo.y) / c.texel) / a.height);
    }
    return a;
}

Raster rasterise(const Scene& s, const Atlas& a, const std::vector<int>& chartPage, int page) {
    Raster r;
    size_t overlaps = 0;
    uint32_t firstOverlap = 0;
    const Mesh& m = s.mesh;
    r.index.assign(size_t(a.width) * a.height, -1);
    std::vector<float> slack(r.index.size(), FLT_MAX);   // how far outside its triangle a texel's centre was
    for (size_t k = 0; k + 2 < m.idx.size(); k += 3) {
        const dz::Vtx* v[3] = {&m.v[m.idx[k]], &m.v[m.idx[k + 1]], &m.v[m.idx[k + 2]]};
        if (chartPage[v[0]->chart] != page) continue;
        float px[3], py[3];
        for (int i = 0; i < 3; ++i) {
            px[i] = v[i]->uv2.x * a.width;
            py[i] = v[i]->uv2.y * a.height;
        }
        const float area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
        if (std::fabs(area) < 1e-12f) continue;   // degenerate in the chart (a pole, a fan's centre)
        // the texel's side on the surface: the triangle's area in the world over its area in texels
        const float footprint = std::sqrt(length(cross(v[1]->p - v[0]->p, v[2]->p - v[0]->p)) / std::fabs(area));
        const int x0 = std::max(0, int(std::floor(std::min({px[0], px[1], px[2]}) - 1.0f)));
        const int x1 = std::min(a.width - 1, int(std::ceil(std::max({px[0], px[1], px[2]}) + 1.0f)));
        const int y0 = std::max(0, int(std::floor(std::min({py[0], py[1], py[2]}) - 1.0f)));
        const int y1 = std::min(a.height - 1, int(std::ceil(std::max({py[0], py[1], py[2]}) + 1.0f)));
        float el[3];   // edge lengths (texels)
        for (int i = 0; i < 3; ++i) el[i] = std::hypot(px[(i + 1) % 3] - px[i], py[(i + 1) % 3] - py[i]);
        for (int ty = y0; ty <= y1; ++ty)
            for (int tx = x0; tx <= x1; ++tx) {
                const float cx = tx + 0.5f, cy = ty + 0.5f;
                float w[3];
                w[0] = ((px[1] - cx) * (py[2] - cy) - (px[2] - cx) * (py[1] - cy)) / area;
                w[1] = ((px[2] - cx) * (py[0] - cy) - (px[0] - cx) * (py[2] - cy)) / area;
                w[2] = 1.0f - w[0] - w[1];
                // how far outside (texels): a negative barycentric times the height over the opposite edge
                float out = 0.0f;
                for (int i = 0; i < 3; ++i)
                    if (w[i] < 0.0f) out = std::max(out, -w[i] * std::fabs(area) / std::max(el[(i + 1) % 3], 1e-6f));
                if (out > 0.5f) continue;
                const size_t ai = size_t(ty) * a.width + tx;
                if (out >= slack[ai]) continue;   // a triangle that holds it better already has it
                float sum = 0;
                for (float& x : w) { x = std::max(x, 0.0f); sum += x; }
                for (float& x : w) x /= sum;   // the nearest point of the triangle
                Texel t;
                t.p = v[0]->p * w[0] + v[1]->p * w[1] + v[2]->p * w[2];
                t.n = normalize(v[0]->n * w[0] + v[1]->n * w[1] + v[2]->n * w[2]);
                t.footprint = footprint;
                t.pixel = uint32_t(ai);
                t.chart = v[0]->chart;
                t.mat = v[0]->mat;
                if (r.index[ai] < 0) {
                    r.index[ai] = int32_t(r.texels.size());
                    r.texels.push_back(t);
                } else {
                    // two triangles of one chart both holding a texel's centre at different places in the world: the
                    // chart's coordinates overlap (one texel cannot hold two lights; review 1, B3, the floor)
                    const Texel& o = r.texels[size_t(r.index[ai])];
                    if (out <= 0.0f && slack[ai] <= 0.0f && o.chart == t.chart && length(o.p - t.p) > 4.0f * std::max(footprint, 1e-4f)) {
                        if (!overlaps++) firstOverlap = t.chart;
                    }
                    r.texels[size_t(r.index[ai])] = t;
                }
                slack[ai] = out;
            }
    }
    if (overlaps)
        std::fprintf(stderr, "atlas: WARNING page %d: %zu texels claimed by two places of one chart (first: chart %u); its "
                             "coordinates overlap\n", page, overlaps, firstOverlap);
    return r;
}

void dilate(const Atlas& a, int page, Raster& r, std::vector<float>& values, int channels) {
    std::vector<std::pair<uint32_t, int32_t>> add;   // pixel, the chart it joins
    std::vector<float> mean(static_cast<size_t>(channels));
    for (int pass = 0; pass < a.pad; ++pass) {
        add.clear();
        const size_t before = values.size();
        for (size_t ci = 0; ci < a.charts.size(); ++ci) {
            const Atlas::Chart& c = a.charts[ci];
            if (c.page != page) continue;
            for (int y = c.y; y < c.y + c.h; ++y)
                for (int x = c.x; x < c.x + c.w; ++x) {
                    const size_t px = size_t(y) * a.width + x;
                    if (r.index[px] >= 0) continue;
                    std::fill(mean.begin(), mean.end(), 0.0f);
                    int n = 0;
                    for (int dy = -1; dy <= 1; ++dy)
                        for (int dx = -1; dx <= 1; ++dx) {
                            const int xx = x + dx, yy = y + dy;
                            if (xx < c.x || yy < c.y || xx >= c.x + c.w || yy >= c.y + c.h) continue;
                            const int32_t j = r.index[size_t(yy) * a.width + xx];
                            // only texels filled before this pass, of this chart
                            if (j < 0 || size_t(j) * channels >= before || r.texels[size_t(j)].chart != ci) continue;
                            for (int q = 0; q < channels; ++q) mean[q] += values[size_t(j) * channels + q];
                            ++n;
                        }
                    if (!n) continue;
                    for (int q = 0; q < channels; ++q) values.push_back(mean[q] / float(n));
                    add.push_back({uint32_t(px), int32_t(ci)});
                }
        }
        // the new pixels join after the pass (a pass reads only what the one before left)
        for (const auto& [px, ci] : add) {
            Texel t{};
            t.pixel = px;
            t.chart = uint32_t(ci);
            r.index[px] = int32_t(r.texels.size());
            r.texels.push_back(t);
        }
    }
}

}   // namespace salon
