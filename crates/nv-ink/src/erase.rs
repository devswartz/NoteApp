//! Erasing. The stroke eraser removes whole strokes it touches (`hit::hit_path`); the partial
//! eraser cuts a stroke where the eraser touched its ink and keeps the rest as new strokes
//! (PLAN_INK: strokes are immutable, so a cut stroke is deleted and its pieces added with new ids).
//!
//! A stroke's centre line is the polyline through its points; a point on it is erased when the
//! eraser's disc (radius `r`, dragged along its track) touches the ink there, i.e. it is within
//! `r` + the stroke's radius of the track. The pieces are exactly the parts of the centre line
//! that aren't erased (to within [`STEP`]), cut where the eraser's reach ends, so no ink is left
//! under the eraser and nothing outside its reach is lost.

use crate::blob::{BBox, Point, Stroke};
use crate::geom::{max_radius, radius};

/// The centre line is checked at least this often (page px, more where the width changes fast); a cut
/// is placed to within 1/64 of a step.
pub const STEP: f32 = 0.5;

fn seg_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 < 1e-12 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0)
    };
    ((p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)).sqrt()
}

/// Distance from a point to a polyline (a single point counts).
pub fn track_distance(track: &[[f32; 2]], x: f32, y: f32) -> f32 {
    match track {
        [] => f32::INFINITY,
        [a] => seg_distance([x, y], *a, *a),
        _ => track
            .windows(2)
            .map(|w| seg_distance([x, y], w[0], w[1]))
            .fold(f32::INFINITY, f32::min),
    }
}

fn lerp(a: &Point, b: &Point, f: f32) -> Point {
    let l = |u: f32, v: f32| u + (v - u) * f;
    Point {
        x: l(a.x, b.x),
        y: l(a.y, b.y),
        pressure: l(a.pressure, b.pressure),
        altitude: l(a.altitude, b.altitude),
        azimuth: a.azimuth, // an angle: interpolating across 0/2pi would be wrong, and a cut is tiny
        t: (a.t as f64 + (b.t as f64 - a.t as f64) * f as f64).round() as u32,
    }
}

/// Cut `stroke` with an eraser of radius `r` dragged along `track`. None when the eraser doesn't
/// touch it; otherwise the pieces left (empty when it is all erased), each with the stroke's style.
pub fn erase_split(stroke: &Stroke, track: &[[f32; 2]], r: f32) -> Option<Vec<Stroke>> {
    let pts = &stroke.points;
    if pts.is_empty() || track.is_empty() {
        return None;
    }
    let erased = |p: &Point| {
        track_distance(track, p.x, p.y) <= r + radius(stroke.tool, stroke.width, p.pressure)
    };
    let mut any = false;
    let mut pieces: Vec<Vec<Point>> = Vec::new();
    let mut cur: Vec<Point> = Vec::new();
    let mut prev_e = erased(&pts[0]);
    if prev_e {
        any = true;
    } else {
        cur.push(pts[0]);
    }
    // Segments nowhere near the eraser are kept whole without walking them.
    let mut reach_box = BBox::EMPTY;
    track.iter().for_each(|p| reach_box.add(p[0], p[1]));
    let reach_box = reach_box.inflate(r + max_radius(stroke.tool, stroke.width) + 1.0);
    for w in pts.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let seg = BBox {
            min_x: a.x.min(b.x),
            min_y: a.y.min(b.y),
            max_x: a.x.max(b.x),
            max_y: a.y.max(b.y),
        };
        if !prev_e && !seg.intersects(&reach_box) {
            cur.push(*b);
            continue;
        }
        // Steps of STEP in "distance minus reach", which changes with both the position and the width.
        let len = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt();
        let dr = (radius(stroke.tool, stroke.width, b.pressure)
            - radius(stroke.tool, stroke.width, a.pressure))
        .abs();
        let m = (((len + dr) / STEP).ceil() as usize).clamp(1, 1 << 16);
        let mut prev_f = 0.0f32;
        for k in 1..=m {
            let f = k as f32 / m as f32;
            let q = if k == m { *b } else { lerp(a, b, f) };
            let e = erased(&q);
            if e {
                any = true;
            }
            if e != prev_e {
                // The cut lies between prev_f and f: find it.
                let (mut lo, mut hi) = (prev_f, f);
                for _ in 0..6 {
                    let mid = (lo + hi) / 2.0;
                    if erased(&lerp(a, b, mid)) == prev_e {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                if prev_e {
                    cur.push(lerp(a, b, hi)); // ink starts again
                } else {
                    cur.push(lerp(a, b, lo)); // ink ends at the eraser
                    pieces.push(core::mem::take(&mut cur));
                }
            }
            if k == m && !e {
                cur.push(*b);
            }
            prev_e = e;
            prev_f = f;
        }
    }
    if !cur.is_empty() {
        pieces.push(cur);
    }
    if !any {
        return None;
    }
    Some(
        pieces
            .into_iter()
            .filter(|p| p.len() >= 2) // even a short stub is ink the eraser didn't reach (a wide stroke's dot)
            .map(|points| Stroke {
                points,
                ..stroke.clone()
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::tool;

    fn line() -> Stroke {
        Stroke {
            tool: tool::PEN,
            color: [0, 0, 0, 255],
            width: 2.0,
            z: "a".into(),
            flags: 0,
            created: 0,
            points: (0..=10)
                .map(|i| Point::new(i as f32 * 10.0, 0.0, 0.5))
                .collect(),
        }
    }

    #[test]
    fn cuts_in_two() {
        // Eraser radius 4 crossing at x = 50; stroke radius 1: ink within 5 of the track goes.
        let out = erase_split(&line(), &[[50.0, -20.0], [50.0, 20.0]], 4.0).unwrap();
        assert_eq!(out.len(), 2);
        let end = out[0].points.last().unwrap().x;
        let start = out[1].points[0].x;
        assert!(
            (end - 45.0).abs() < 0.05 && (start - 55.0).abs() < 0.05,
            "{end} {start}"
        );
        assert_eq!(out[0].points[0].x, 0.0);
        assert_eq!(out[1].points.last().unwrap().x, 100.0);
    }

    #[test]
    fn untouched_and_gone() {
        assert!(erase_split(&line(), &[[50.0, 30.0]], 4.0).is_none());
        assert_eq!(
            erase_split(&line(), &[[-10.0, 0.0], [110.0, 0.0]], 4.0),
            Some(vec![])
        );
    }

    #[test]
    fn trims_an_end() {
        let out = erase_split(&line(), &[[0.0, 0.0]], 4.0).unwrap();
        assert_eq!(out.len(), 1);
        assert!((out[0].points[0].x - 5.0).abs() < 0.05);
    }
}
