//! Hit testing against a stroke's exact shape (`geom.rs`): a point (tap, hover), a path (the
//! stroke eraser's track), and a lasso polygon (selection, PLAN_INK phase I5).

use crate::blob::{BBox, Point};
use crate::geom::Sample;

fn dist(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
}

/// Signed distance from (qx, qy) to the capsule from `a` to `b` (the union of the discs between
/// them, the convex hull of the two end discs): negative inside, exact outside.
pub fn capsule_distance(a: Sample, b: Sample, qx: f32, qy: f32) -> f32 {
    let l = dist(a.x, a.y, b.x, b.y);
    let disc = |s: Sample| dist(s.x, s.y, qx, qy) - s.r;
    if l < 1e-6 {
        return disc(a).min(disc(b));
    }
    let dr = (b.r - a.r) / l;
    if dr.abs() >= 1.0 {
        return disc(a).min(disc(b)); // one disc holds the other
    }
    let (dx, dy) = ((b.x - a.x) / l, (b.y - a.y) / l);
    let (ux, uy) = (qx - a.x, qy - a.y);
    let along = ux * dx + uy * dy;
    let perp = (ux * dy - uy * dx).abs();
    // The disc along the segment nearest to q: where d/ds (|q - c(s)| - r(s)) = 0, kept on the segment.
    let s = (along + dr * perp / (1.0 - dr * dr).sqrt()).clamp(0.0, l);
    ((along - s).powi(2) + perp * perp).sqrt() - (a.r + dr * s)
}

/// Signed distance from (x, y) to the stroke (negative inside). Infinity for an empty stroke.
pub fn stroke_distance(samples: &[Sample], x: f32, y: f32) -> f32 {
    match samples {
        [] => f32::INFINITY,
        [s] => dist(s.x, s.y, x, y) - s.r,
        _ => samples
            .windows(2)
            .map(|w| capsule_distance(w[0], w[1], x, y))
            .fold(f32::INFINITY, f32::min),
    }
}

/// The stroke's ink bounds (points plus radii).
pub fn bounds(samples: &[Sample]) -> BBox {
    let mut b = BBox::EMPTY;
    for s in samples {
        b.add(s.x - s.r, s.y - s.r);
        b.add(s.x + s.r, s.y + s.r);
    }
    b
}

/// Whether a disc of radius `r` at (x, y) touches the stroke.
pub fn hit_point(samples: &[Sample], x: f32, y: f32, r: f32) -> bool {
    if !bounds(samples).inflate(r).intersects(&BBox {
        min_x: x,
        min_y: y,
        max_x: x,
        max_y: y,
    }) {
        return false;
    }
    stroke_distance(samples, x, y) <= r
}

/// Points along a polyline no more than `step` apart (the polyline's own points included).
pub fn walk(path: &[[f32; 2]], step: f32) -> Vec<[f32; 2]> {
    let mut out = Vec::with_capacity(path.len() * 2);
    if let Some(first) = path.first() {
        out.push(*first);
    }
    for w in path.windows(2) {
        let (a, b) = (w[0], w[1]);
        let n = ((dist(a[0], a[1], b[0], b[1]) / step).ceil() as usize).clamp(1, 4096);
        for k in 1..=n {
            let f = k as f32 / n as f32;
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        }
    }
    out
}

/// Whether a disc of radius `r` dragged along `path` (an eraser's track) touches the stroke.
pub fn hit_path(samples: &[Sample], path: &[[f32; 2]], r: f32) -> bool {
    let mut pb = BBox::EMPTY;
    path.iter().for_each(|p| pb.add(p[0], p[1]));
    if !bounds(samples).inflate(r).intersects(&pb) {
        return false;
    }
    // A quarter pixel apart: the disc's own radius covers what lies between.
    walk(path, 0.25)
        .iter()
        .any(|p| stroke_distance(samples, p[0], p[1]) <= r + 0.125)
}

/// Whether (x, y) is inside a polygon (even-odd rule).
pub fn in_polygon(poly: &[[f32; 2]], x: f32, y: f32) -> bool {
    let mut inside = false;
    let n = poly.len();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + n - 1) % n]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
    }
    inside
}

/// The share of a stroke's points inside a lasso polygon (0 for an empty stroke).
pub fn lasso_fraction(points: &[Point], poly: &[[f32; 2]]) -> f32 {
    if points.is_empty() || poly.len() < 3 {
        return 0.0;
    }
    points.iter().filter(|p| in_polygon(poly, p.x, p.y)).count() as f32 / points.len() as f32
}

/// Whether a lasso selects the stroke: at least `min_fraction` of its points are inside (and at least one).
pub fn hit_lasso(points: &[Point], poly: &[[f32; 2]], min_fraction: f32) -> bool {
    let f = lasso_fraction(points, poly);
    f > 0.0 && f >= min_fraction
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Sample = Sample {
        x: 0.0,
        y: 0.0,
        r: 1.0,
    };
    const B: Sample = Sample {
        x: 10.0,
        y: 0.0,
        r: 3.0,
    };

    #[test]
    fn capsule() {
        assert!(capsule_distance(A, B, 5.0, 0.0) < 0.0);
        assert!((capsule_distance(A, B, -2.0, 0.0) - 1.0).abs() < 1e-5);
        assert!((capsule_distance(A, B, 14.0, 0.0) - 1.0).abs() < 1e-5);
        // Beside the middle: the hull's edge is at about 2 (the radius there), slightly more as it tilts.
        let d = capsule_distance(A, B, 5.0, 4.0);
        assert!(d > 1.9 && d < 2.1, "{d}");
    }

    #[test]
    fn lasso() {
        let square = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let pts: Vec<Point> = (0..10)
            .map(|i| Point::new(i as f32 * 2.0, 5.0, 0.5))
            .collect();
        assert_eq!(lasso_fraction(&pts, &square), 0.5);
        assert!(hit_lasso(&pts, &square, 0.5));
        assert!(!hit_lasso(&pts, &square, 0.6));
    }

    #[test]
    fn path() {
        let s = [A, B];
        assert!(hit_path(&s, &[[5.0, -20.0], [5.0, 20.0]], 0.5));
        assert!(!hit_path(&s, &[[-5.0, -20.0], [-5.0, 20.0]], 0.5));
    }
}
