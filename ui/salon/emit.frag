// A small emitter's footprint: its projected rectangle convolved with a Gaussian of sigma (target px). The value is
// the share of the rectangle a sample "sees" through the Gaussian, so its sum over the sample grid is the rectangle's
// area wherever the lens sits between samples: the lens keeps its energy and its shape at every sub-pixel phase
// (a box or the lens' own geometry is hit or missed by each sample and blinks as the camera moves). Added (ONE, ONE)
// to the pass' radiance, so haze, bloom and the tonemap treat it like the lens it replaces.
// Its visibility comes from emit.vert (points on the lens against the depth), one value for the whole footprint.
precision highp float;
in vec2 vPx;
flat in vec3 vL;
flat in vec3 vShape;
layout(location = 0) out vec4 outColor;
float erf1(float x) {          // Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7)
    float a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return x < 0.0 ? -y : y;
}
float boxGauss(float x, float h, float s) { float k = 0.70710678 / s; return 0.5 * (erf1((x + h) * k) - erf1((x - h) * k)); }
void main() {
    float h1 = vShape.x, h2 = vShape.y, s = vShape.z;
    // the rectangle's area per sample: a lens thinner than sigma keeps its area, spread (the sum stays h1 h2 4)
    float v = boxGauss(vPx.x, h1, s) * boxGauss(vPx.y, h2, s);
    outColor = vec4(vL * v, 0.0);
}
