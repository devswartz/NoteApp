//! Stroke geometry: the curve fit through a stroke's points, the pressure-to-width outline,
//! and its tessellation into path commands (Canvas2D, SVG, PDF) and triangles (GPU).
//!
//! The shape of a stroke is defined exactly: fit a centripetal Catmull-Rom curve through the
//! stored points, sample it densely, give every sample a radius from its pressure, and take
//! the union of the discs swept along each sampled segment (the convex hull of the two end
//! discs: a "capsule" whose radius changes linearly). Rendering draws that union (one quad per
//! segment plus the discs at the ends and at bends), and hit testing (`hit.rs`) asks the same
//! question of the same samples, so the two can't disagree.
//!
//! Every quad and disc is wound the same way, so a nonzero fill of the whole path is the union:
//! overlaps are painted once, which keeps a translucent highlighter even.

use crate::blob::{tool, Point, Stroke};
use core::f32::consts::{PI, TAU};

/// The curve is sampled at least this often (page px).
pub const SAMPLE_STEP: f32 = 1.5;
/// At most this many samples per input segment (a very long jump).
pub const MAX_SUBDIV: usize = 32;
/// Joints whose gap would be narrower than this (page px) get no disc: invisible.
pub const JOINT_EPS: f32 = 0.05;
/// How far a polygonised disc (triangles) may fall inside the true circle (page px).
pub const DISC_TOLERANCE: f32 = 0.1;

/// A point on the fitted curve and the stroke's radius there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub x: f32,
    pub y: f32,
    pub r: f32,
}

/// The stroke's half-width at a pressure. A pen thins and thickens with pressure (pressure 0.5
/// is the base width); a highlighter is even.
pub fn radius(tool_id: u8, width: f32, pressure: f32) -> f32 {
    let w = width.max(0.1);
    if tool_id == tool::HIGHLIGHTER {
        return w / 2.0;
    }
    let p = if pressure.is_finite() {
        pressure.clamp(0.0, 1.0)
    } else {
        0.5
    };
    w / 2.0 * (0.35 + 1.3 * p)
}

/// The widest a stroke of this width can be (for culling boxes).
pub fn max_radius(tool_id: u8, width: f32) -> f32 {
    radius(tool_id, width, 1.0)
}

fn dist(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
}

/// Points with exact duplicates folded (keeping the harder pressure): the curve needs distinct points.
fn distinct(points: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(points.len());
    for p in points {
        if !p.x.is_finite() || !p.y.is_finite() {
            continue;
        }
        match out.last_mut() {
            Some(q) if dist(q.x, q.y, p.x, p.y) < 1e-3 => q.pressure = q.pressure.max(p.pressure),
            _ => out.push(*p),
        }
    }
    out
}

/// One coordinate of a centripetal Catmull-Rom segment (Barry-Goldman), between p1 (t1) and p2 (t2).
#[allow(clippy::too_many_arguments)]
fn cr(p0: f32, p1: f32, p2: f32, p3: f32, t0: f32, t1: f32, t2: f32, t3: f32, t: f32) -> f32 {
    let a1 = ((t1 - t) * p0 + (t - t0) * p1) / (t1 - t0);
    let a2 = ((t2 - t) * p1 + (t - t1) * p2) / (t2 - t1);
    let a3 = ((t3 - t) * p2 + (t - t2) * p3) / (t3 - t2);
    let b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
    let b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
    ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1)
}

/// The fitted curve of a stroke as dense samples with radii.
pub fn samples(s: &Stroke) -> Vec<Sample> {
    samples_of(s.tool, s.width, &s.points)
}

/// The fitted curve through `points` (see [`samples`]).
pub fn samples_of(tool_id: u8, width: f32, points: &[Point]) -> Vec<Sample> {
    let p = distinct(points);
    let rad = |q: &Point| radius(tool_id, width, q.pressure);
    match p.len() {
        0 => return vec![],
        1 => {
            return vec![Sample {
                x: p[0].x,
                y: p[0].y,
                r: rad(&p[0]),
            }]
        }
        _ => {}
    }
    let n = p.len();
    let mut out = Vec::with_capacity(n * 2);
    out.push(Sample {
        x: p[0].x,
        y: p[0].y,
        r: rad(&p[0]),
    });
    // Phantom end points continue the first and last segments straight on.
    let at = |i: isize| -> (f32, f32) {
        if i < 0 {
            (2.0 * p[0].x - p[1].x, 2.0 * p[0].y - p[1].y)
        } else if i as usize >= n {
            (2.0 * p[n - 1].x - p[n - 2].x, 2.0 * p[n - 1].y - p[n - 2].y)
        } else {
            (p[i as usize].x, p[i as usize].y)
        }
    };
    for i in 0..n - 1 {
        let (q0, q1, q2, q3) = (
            at(i as isize - 1),
            at(i as isize),
            at(i as isize + 1),
            at(i as isize + 2),
        );
        let len = dist(q1.0, q1.1, q2.0, q2.1);
        let m = ((len / SAMPLE_STEP).ceil() as usize).clamp(1, MAX_SUBDIV);
        let knot = |a: (f32, f32), b: (f32, f32)| dist(a.0, a.1, b.0, b.1).sqrt().max(1e-4);
        let t0 = 0.0;
        let t1 = t0 + knot(q0, q1);
        let t2 = t1 + knot(q1, q2);
        let t3 = t2 + knot(q2, q3);
        let (r1, r2) = (rad(&p[i]), rad(&p[i + 1]));
        for k in 1..=m {
            let f = k as f32 / m as f32;
            let (x, y) = if k == m {
                q2
            } else {
                let t = t1 + (t2 - t1) * f;
                (
                    cr(q0.0, q1.0, q2.0, q3.0, t0, t1, t2, t3, t),
                    cr(q0.1, q1.1, q2.1, q3.1, t0, t1, t2, t3, t),
                )
            };
            let (x, y) = if x.is_finite() && y.is_finite() {
                (x, y)
            } else {
                (q1.0 + (q2.0 - q1.0) * f, q1.1 + (q2.1 - q1.1) * f)
            };
            out.push(Sample {
                x,
                y,
                r: r1 + (r2 - r1) * f,
            });
        }
    }
    out
}

/// One piece of a stroke's shape: a disc, or the quad joining two discs along their outer tangents.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Piece {
    Disc {
        x: f32,
        y: f32,
        r: f32,
    },
    /// Four corners wound counter-clockwise in math orientation (positive area).
    Quad([[f32; 2]; 4]),
}

/// The tangent quad between two discs, or None when one disc holds the other (its disc covers it all).
pub fn tangent_quad(a: Sample, b: Sample) -> Option<[[f32; 2]; 4]> {
    let l = dist(a.x, a.y, b.x, b.y);
    if l <= (a.r - b.r).abs() || l < 1e-6 {
        return None;
    }
    let (dx, dy) = ((b.x - a.x) / l, (b.y - a.y) / l);
    let (nx, ny) = (-dy, dx);
    let s = (a.r - b.r) / l;
    let c = (1.0 - s * s).max(0.0).sqrt();
    // Unit directions from each centre to its tangent points (left and right of the segment).
    let (ux, uy) = (s * dx + c * nx, s * dy + c * ny);
    let (vx, vy) = (s * dx - c * nx, s * dy - c * ny);
    // Right side forward, left side back: counter-clockwise in math orientation.
    Some([
        [a.x + vx * a.r, a.y + vy * a.r],
        [b.x + vx * b.r, b.y + vy * b.r],
        [b.x + ux * b.r, b.y + uy * b.r],
        [a.x + ux * a.r, a.y + uy * a.r],
    ])
}

/// The pieces whose union is the stroke (see the module comment).
pub fn pieces(samples: &[Sample]) -> Vec<Piece> {
    let mut out = Vec::with_capacity(samples.len() + 4);
    let n = samples.len();
    for (i, s) in samples.iter().enumerate() {
        // The ends always get a disc (round caps); a bend gets one when the quads beside it leave a visible gap.
        let joint = if i == 0 || i == n - 1 {
            true
        } else {
            let (a, b) = (samples[i - 1], samples[i + 1]);
            let (d1x, d1y, d2x, d2y) = (s.x - a.x, s.y - a.y, b.x - s.x, b.y - s.y);
            let (l1, l2) = (dist(0.0, 0.0, d1x, d1y), dist(0.0, 0.0, d2x, d2y));
            if l1 < 1e-6 || l2 < 1e-6 {
                true
            } else {
                // Between two quads the disc shows through a thin wedge on the outside of a bend
                // (r * turn wide at the rim), and where the width changes unevenly the quads' ends
                // lean apart by the change in slope (r * |s1 - s2|).
                let turn = ((d1x * d2x + d1y * d2y) / (l1 * l2))
                    .clamp(-1.0, 1.0)
                    .acos();
                let slope = ((a.r - s.r) / l1 - (s.r - b.r) / l2).abs();
                s.r * (turn + slope) >= JOINT_EPS
            }
        };
        if joint {
            out.push(Piece::Disc {
                x: s.x,
                y: s.y,
                r: s.r,
            });
        }
        if i + 1 < n {
            if let Some(q) = tangent_quad(*s, samples[i + 1]) {
                out.push(Piece::Quad(q));
            }
        }
    }
    out
}

/// Path commands, flat: [MOVE x y], [LINE x y], [CIRCLE cx cy r], [CLOSE]. Fill with the nonzero rule.
pub mod op {
    pub const MOVE: f32 = 0.0;
    pub const LINE: f32 = 1.0;
    /// A whole circle, drawn with increasing angle (canvas `arc(cx, cy, r, 0, 2pi)`).
    pub const CIRCLE: f32 = 2.0;
    pub const CLOSE: f32 = 3.0;
}

/// The stroke as path commands (see [`op`]).
pub fn path_ops(pieces: &[Piece]) -> Vec<f32> {
    let mut out = Vec::with_capacity(pieces.len() * 14);
    for p in pieces {
        match *p {
            Piece::Disc { x, y, r } => out.extend_from_slice(&[op::CIRCLE, x, y, r]),
            Piece::Quad(q) => {
                out.extend_from_slice(&[op::MOVE, q[0][0], q[0][1]]);
                for c in &q[1..] {
                    out.extend_from_slice(&[op::LINE, c[0], c[1]]);
                }
                out.push(op::CLOSE);
            }
        }
    }
    out
}

fn num(out: &mut String, v: f32) {
    // Two decimals is 1/100 px: plenty for print, and short.
    let r = (v * 100.0).round() / 100.0;
    let r = if r == 0.0 { 0.0 } else { r }; // no "-0"
    out.push_str(&format!("{r}"));
}

/// The stroke as an SVG path `d` (fill-rule nonzero). Discs are two arcs with sweep 1 (increasing
/// angle), the same winding as the quads.
pub fn svg_path(pieces: &[Piece]) -> String {
    let mut s = String::with_capacity(pieces.len() * 40);
    let pt = |s: &mut String, cmd: &str, x: f32, y: f32| {
        s.push_str(cmd);
        num(s, x);
        s.push(' ');
        num(s, y);
    };
    for p in pieces {
        match *p {
            Piece::Disc { x, y, r } => {
                pt(&mut s, "M", x + r, y);
                for (ex, ey) in [(x - r, y), (x + r, y)] {
                    s.push('A');
                    num(&mut s, r);
                    s.push(' ');
                    num(&mut s, r);
                    s.push_str(" 0 0 1 ");
                    num(&mut s, ex);
                    s.push(' ');
                    num(&mut s, ey);
                }
                s.push('Z');
            }
            Piece::Quad(q) => {
                pt(&mut s, "M", q[0][0], q[0][1]);
                for c in &q[1..] {
                    pt(&mut s, "L", c[0], c[1]);
                }
                s.push('Z');
            }
        }
    }
    s
}

/// How many sides a disc of radius r needs so its polygon stays within DISC_TOLERANCE of the circle.
pub fn disc_sides(r: f32) -> usize {
    if r <= DISC_TOLERANCE {
        return 6;
    }
    let step = 2.0 * (1.0 - DISC_TOLERANCE / r).clamp(-1.0, 1.0).acos();
    ((TAU / step).ceil() as usize).clamp(6, 128)
}

/// The stroke as triangles for the GPU: x, y per vertex, three vertices per triangle. Pieces
/// overlap, so draw it opaque or with a stencil (a translucent highlighter would darken overlaps).
/// Discs are circumscribed polygons, so the triangles cover the whole circle.
pub fn triangles(pieces: &[Piece]) -> Vec<f32> {
    let mut out = Vec::new();
    for p in pieces {
        match *p {
            Piece::Disc { x, y, r } => {
                let n = disc_sides(r);
                let rr = r / (PI / n as f32).cos(); // circumscribed
                let at = |k: usize| {
                    let a = TAU * k as f32 / n as f32;
                    (x + rr * a.cos(), y + rr * a.sin())
                };
                for k in 0..n {
                    let (a, b) = (at(k), at(k + 1));
                    out.extend_from_slice(&[x, y, a.0, a.1, b.0, b.1]);
                }
            }
            Piece::Quad(q) => {
                out.extend_from_slice(&[q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1]]);
                out.extend_from_slice(&[q[0][0], q[0][1], q[2][0], q[2][1], q[3][0], q[3][1]]);
            }
        }
    }
    out
}

/// Whether (x, y) is inside the filled path (nonzero rule): the exact shape [`path_ops`] draws.
pub fn path_contains(pieces: &[Piece], x: f32, y: f32) -> bool {
    pieces.iter().any(|p| match *p {
        Piece::Disc { x: cx, y: cy, r } => dist(cx, cy, x, y) <= r,
        Piece::Quad(q) => (0..4).all(|i| {
            let (a, b) = (q[i], q[(i + 1) % 4]);
            (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0.0
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::Point;

    fn line(n: usize) -> Vec<Point> {
        (0..n)
            .map(|i| Point::new(i as f32 * 5.0, 0.0, 0.5))
            .collect()
    }

    #[test]
    fn samples_pass_through_points() {
        let pts = line(4);
        let s = samples_of(tool::PEN, 2.0, &pts);
        assert_eq!(s.first().map(|s| (s.x, s.y)), Some((0.0, 0.0)));
        assert_eq!(s.last().map(|s| (s.x, s.y)), Some((15.0, 0.0)));
        assert!(s
            .iter()
            .all(|q| q.y.abs() < 1e-4 && (q.r - 1.0).abs() < 1e-4));
        // A straight line has no bends: discs only at the ends.
        let disc_count = pieces(&s)
            .iter()
            .filter(|p| matches!(p, Piece::Disc { .. }))
            .count();
        assert_eq!(disc_count, 2);
    }

    #[test]
    fn quads_are_counter_clockwise() {
        let q = tangent_quad(
            Sample {
                x: 0.0,
                y: 0.0,
                r: 1.0,
            },
            Sample {
                x: 10.0,
                y: 3.0,
                r: 2.0,
            },
        )
        .unwrap();
        let area: f32 = (0..4)
            .map(|i| q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1])
            .sum();
        assert!(area > 0.0);
    }

    #[test]
    fn pressure_shapes_the_width() {
        assert!(radius(tool::PEN, 2.0, 1.0) > radius(tool::PEN, 2.0, 0.5));
        assert_eq!(radius(tool::PEN, 2.0, 0.5), 1.0);
        assert_eq!(radius(tool::HIGHLIGHTER, 12.0, 0.1), 6.0);
    }

    #[test]
    fn a_dot_is_a_disc() {
        let s = samples_of(tool::PEN, 4.0, &[Point::new(3.0, 4.0, 0.5)]);
        assert_eq!(
            pieces(&s),
            vec![Piece::Disc {
                x: 3.0,
                y: 4.0,
                r: 2.0
            }]
        );
        assert!(svg_path(&pieces(&s)).starts_with("M5 4A2 2 0 0 1 1 4"));
    }

    #[test]
    fn triangles_cover_the_path() {
        let s = samples_of(
            tool::PEN,
            6.0,
            &[
                Point::new(0.0, 0.0, 0.2),
                Point::new(20.0, 10.0, 0.9),
                Point::new(5.0, 30.0, 0.5),
            ],
        );
        let p = pieces(&s);
        let tri = triangles(&p);
        assert_eq!(tri.len() % 6, 0);
        let inside_tri = |x: f32, y: f32| {
            tri.chunks(6).any(|t| {
                let s = |ax: f32, ay: f32, bx: f32, by: f32| {
                    (bx - ax) * (y - ay) - (by - ay) * (x - ax)
                };
                let (a, b, c) = (
                    s(t[0], t[1], t[2], t[3]),
                    s(t[2], t[3], t[4], t[5]),
                    s(t[4], t[5], t[0], t[1]),
                );
                (a >= -1e-3 && b >= -1e-3 && c >= -1e-3) || (a <= 1e-3 && b <= 1e-3 && c <= 1e-3)
            })
        };
        for gx in -10..40 {
            for gy in -10..40 {
                let (x, y) = (gx as f32 + 0.37, gy as f32 + 0.61);
                if path_contains(&p, x, y) {
                    assert!(inside_tri(x, y), "{x},{y}");
                }
            }
        }
    }
}
