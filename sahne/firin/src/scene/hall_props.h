// Set dressing from Poly Haven models (CC0 1.0, https://polyhaven.com/license; fetched by sahne/varlik.py into
// sahne/varlik/model/<id>/): flanged pipe runs, hung air ducts, rusty bins, a ladder. Built by scene/hall_props.cpp
// at real measures, in the gallery for now; the run helpers take world measures so the hall's walls can use them too.
#pragma once
#include "scene/hall_kit.h"

#include <string>

namespace salon::hall {

// what the props need besides the builder: where the models are
struct Props {
    Hall& h;
    std::string assetDir;   // sahne/varlik
};

// a flanged pipe (modular_industrial_pipes_01, scaled to Ø 0.25 m, flanges Ø 0.37 m) from `start` (its axis, at
// kPipeAxisY over the floor) along the horizontal `dir`, `wheel` the side its valve's handwheel faces. `pieces`: L long (3.5 m), S short
// (1.5 m), V valve (0.7 m); the run ends in an elbow down to a flange flush with the floor (a floor penetration), with
// a floor plate round it. Stands with pipe clamps under every long piece. Returns where the elbow's floor flange is.
float3 pipeRun(Props& p, float3 start, float3 dir, float3 wheel, const std::string& pieces);
// the run's length along dir from its start to the elbow's floor flange (for laying a run out to an end point)
float pipeRunLength(const std::string& pieces);
constexpr float kPipeScale = 1.8f;
constexpr float kPipeR = 0.1036f * kPipeScale;           // the flanges' radius
constexpr float kPipeBodyR = 0.0686f * kPipeScale;       // the pipe's radius between its flanges
constexpr float kPipeAxisY = 0.3206f * kPipeScale;       // the axis' height when the elbow's flange is at the floor

// a hung air duct (modular_airduct_circular_01, scaled to Ø 0.74 m) from `start` (its axis, in a wall) along `dir`,
// `n` sections of 1.7 m, hangers from a ceiling at y = ceilingY under every other one, a fan outlet at its end
void ductRun(Props& p, float3 start, float3 dir, int n, float ceilingY);
constexpr float kDuctScale = 2.0f;
constexpr float kDuctR = 0.186f * kDuctScale;
constexpr float kDuctHang = 1.053f * kDuctScale;         // the hanger rods' top over the duct's axis

// a rusty bin, its lid leaning on it (metal_trash_can, the rust variant): standing at p on the floor, yaw in degrees
void trashCan(Props& p, float3 at, float yawDeg);
// an aluminium sectioned ladder (ladder_sectioned_01), collapsed (2.13 m), leaning on a wall: its feet centred at
// `foot` (its distance from the wall is set by the lean), `wallN` the wall's normal into the room, `wallPlane` =
// dot(wallN, a point on the wall), the lean from vertical in degrees; its top's back rests on the wall
void ladder(Props& p, float3 foot, float3 wallN, float wallPlane, float leanDeg);

// the gallery's dressing (called by build after the parts)
void buildProps(Hall& h, const std::string& assetDir);

}   // namespace salon::hall
