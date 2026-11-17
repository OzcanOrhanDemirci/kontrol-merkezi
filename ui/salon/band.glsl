// The void's cloud band (pasted at "// BAND" into the shaders that see the fog: post.frag, fener.vert, direk.vert).
// Every period uBand.z in y a band of extinction uBand.w x (1 - u^2)^2, u = (y - centre) / half thickness in -1..1:
// the columns end inside it, the fall passes through it. Periodic in y and nothing else (the wrap keeps the picture).
// Its optical depth along a straight ray is closed form: the extinction integrated over y (bandG, monotonic) divided
// by the ray's rise per metre; a ray nearly level takes the extinction at its height times its length instead.
float bandP(float u) { return u - (2.0 / 3.0) * u * u * u + 0.2 * u * u * u * u * u; }   // integral of (1 - u^2)^2
float bandG(float y) {         // the integral of the band's profile from its period's bottom, in metres of full density
    float hw = uBand.y, D = uBand.z;
    float q = y - uBand.x + 0.5 * D;
    float n = floor(q / D), t = q - n * D - 0.5 * D;           // t: from the centre, -D/2 .. D/2
    return n * hw * (16.0 / 15.0) + hw * (bandP(clamp(t / hw, -1.0, 1.0)) + 8.0 / 15.0);
}
float bandRho(float y) {
    float D = uBand.z, t = y - uBand.x - D * floor((y - uBand.x) / D + 0.5);
    float u = clamp(t / uBand.y, -1.0, 1.0), v = 1.0 - u * u;
    return v * v;
}
// optical depth of the band from height y0 along a ray rising ry per metre over dist metres
float bandTau(float y0, float ry, float dist) {
    if (uBand.w <= 0.0) return 0.0;
    float dy = ry * dist;
    if (abs(dy) < 0.5) return uBand.w * dist * bandRho(y0 + 0.5 * dy);
    return uBand.w * dist * (bandG(y0 + dy) - bandG(y0)) / dy;
}
