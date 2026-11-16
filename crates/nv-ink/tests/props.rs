//! Property tests (docs/PLAN_INK.md, I1 exit): encode/decode is the identity up to quantisation,
//! erase-split leaves exactly the original minus the eraser, and hit tests agree with what is drawn.

use nv_ink::blob::{self, flags, tool, Point, Stroke, COORD_SCALE};
use nv_ink::erase::{erase_split, track_distance};
use nv_ink::geom::{self, path_contains, pieces, radius, samples};
use nv_ink::hit::{self, stroke_distance};
use proptest::prelude::*;
use std::f32::consts::{FRAC_PI_2, TAU};

fn point() -> impl Strategy<Value = Point> {
    (
        -2000f32..2000.0,
        -2000f32..2000.0,
        0f32..=1.0,
        0f32..=FRAC_PI_2,
        0f32..TAU,
        0u32..50,
    )
        .prop_map(|(x, y, pressure, altitude, azimuth, t)| Point {
            x,
            y,
            pressure,
            altitude,
            azimuth,
            t,
        })
}

fn stroke() -> impl Strategy<Value = Stroke> {
    (
        prop_oneof![Just(tool::PEN), Just(tool::HIGHLIGHTER), any::<u8>()],
        any::<[u8; 4]>(),
        0.1f32..60.0,
        "[a-zA-Z0-9]{0,12}",
        any::<u8>(),
        0u64..4_000_000_000_000,
        prop::collection::vec(point(), 0..120),
    )
        .prop_map(|(tool, color, width, z, flags, created, mut points)| {
            // Time only runs forwards: make t cumulative.
            let mut t = 0u32;
            for p in &mut points {
                t += p.t;
                p.t = t;
            }
            Stroke {
                tool,
                color,
                width,
                z,
                flags,
                created,
                points,
            }
        })
}

/// A hand-like stroke: a short random walk, so neighbouring points are close as they are when writing.
fn written() -> impl Strategy<Value = Stroke> {
    (
        prop_oneof![Just(tool::PEN), Just(tool::HIGHLIGHTER)],
        0.5f32..16.0,
        -50f32..50.0,
        -50f32..50.0,
        prop::collection::vec((-6f32..6.0, -6f32..6.0, 0f32..=1.0), 1..60),
    )
        .prop_map(|(tool, width, x0, y0, steps)| {
            let (mut x, mut y) = (x0, y0);
            let points = steps
                .into_iter()
                .enumerate()
                .map(|(i, (dx, dy, p))| {
                    x += dx;
                    y += dy;
                    Point {
                        t: i as u32 * 4,
                        ..Point::new(x, y, p)
                    }
                })
                .collect();
            Stroke {
                tool,
                color: [0, 0, 0, 255],
                width,
                z: "a0".into(),
                flags: flags::PRESSURE,
                created: 0,
                points,
            }
        })
}

const Q: f32 = 0.5 / COORD_SCALE + 1e-3;

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn decode_encode_is_identity_up_to_quantisation(s in stroke()) {
        let bytes = blob::encode(&s);
        let d = blob::decode(&bytes).unwrap();
        // Quantising is idempotent: the decoded stroke encodes to the same bytes.
        prop_assert_eq!(&blob::encode(&d), &bytes);
        prop_assert_eq!(d.tool, s.tool);
        prop_assert_eq!(d.color, s.color);
        prop_assert_eq!(d.flags, s.flags);
        prop_assert_eq!(d.created, s.created);
        prop_assert_eq!(&d.z, &s.z);
        prop_assert!((d.width - s.width).abs() <= 0.5 / 16.0 + 1e-4 || s.width < 1.0 / 16.0);
        prop_assert_eq!(d.points.len(), s.points.len());
        for (a, b) in s.points.iter().zip(&d.points) {
            prop_assert!((a.x - b.x).abs() <= Q && (a.y - b.y).abs() <= Q, "{:?} {:?}", a, b);
            prop_assert!((a.pressure - b.pressure).abs() <= 0.5 / 255.0 + 1e-6);
            prop_assert_eq!(a.t, b.t);
            if s.flags & flags::TILT != 0 {
                prop_assert!((a.altitude - b.altitude).abs() <= 0.5 / 255.0 * FRAC_PI_2 + 1e-4);
                let da = (a.azimuth - b.azimuth).rem_euclid(TAU);
                prop_assert!(da.min(TAU - da) <= 0.5 / 256.0 * TAU + 1e-4);
            }
        }
        // The header's box holds every point.
        let h = blob::decode_header(&bytes).unwrap();
        for p in &d.points {
            prop_assert!(p.x >= h.bbox.min_x && p.x <= h.bbox.max_x && p.y >= h.bbox.min_y && p.y <= h.bbox.max_y);
        }
    }

    #[test]
    fn decode_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..400)) {
        let _ = blob::decode(&bytes);
        let _ = blob::decode_header(&bytes);
    }

    #[test]
    fn decode_survives_corruption(s in written(), at in any::<prop::sample::Index>(), v in any::<u8>()) {
        let mut bytes = blob::encode(&s);
        let i = at.index(bytes.len());
        bytes[i] = v;
        if let Ok(d) = blob::decode(&bytes) {
            // Whatever decodes is a stroke that stores and reads back unchanged.
            prop_assert_eq!(blob::decode(&blob::encode(&d)), Ok(d));
        }
    }

    #[test]
    fn hit_tests_agree_with_the_drawn_shape(s in written(), qx in -100f32..100.0, qy in -100f32..100.0) {
        let sm = samples(&s);
        let p = pieces(&sm);
        let d = stroke_distance(&sm, qx, qy);
        let drawn = path_contains(&p, qx, qy);
        // Drawn ink is always a hit, and the ink is drawn wherever it hits.
        if drawn {
            prop_assert!(d <= 1e-3, "drawn but {} away", d);
        }
        if d < -geom::JOINT_EPS - 1e-3 && !drawn {
            // Only a joint too slight to draw a disc for leaves a gap, narrower than JOINT_EPS: ink is right beside it.
            let e = geom::JOINT_EPS * 1.01;
            let near = (0..16).any(|k| {
                let a = k as f32 * std::f32::consts::TAU / 16.0;
                path_contains(&p, qx + e * a.cos(), qy + e * a.sin())
            });
            prop_assert!(near, "{} inside but not drawn", d);
        }
        prop_assert_eq!(hit::hit_point(&sm, qx, qy, 0.0), d <= 0.0);
        // The bounds cover all the ink, and the header's ink bounds cover the samples' bounds.
        if d <= 0.0 {
            let b = hit::bounds(&sm);
            prop_assert!(qx >= b.min_x && qx <= b.max_x && qy >= b.min_y && qy <= b.max_y);
        }
        let h = blob::decode_header(&blob::encode(&s)).unwrap();
        let ib = nv_ink::ink_bounds(&h);
        let qs = samples(&blob::quantised(&s));
        let b = hit::bounds(&qs);
        prop_assert!(b.min_x >= ib.min_x - 1e-3 && b.max_x <= ib.max_x + 1e-3 && b.min_y >= ib.min_y - 1e-3 && b.max_y <= ib.max_y + 1e-3);
    }

    #[test]
    fn a_hit_path_touches_the_ink(s in written(), track in prop::collection::vec((-80f32..80.0, -80f32..80.0), 1..5), r in 0.5f32..10.0) {
        let sm = samples(&s);
        let track: Vec<[f32; 2]> = track.into_iter().map(|(x, y)| [x, y]).collect();
        let hit = hit::hit_path(&sm, &track, r);
        // Exact answer, approximated finely: the nearest the track comes to the ink.
        let near = hit::walk(&track, 0.05).iter().map(|q| stroke_distance(&sm, q[0], q[1])).fold(f32::INFINITY, f32::min);
        if near <= r - 0.01 { prop_assert!(hit, "missed at {}", near); }
        if near > r + 0.2 { prop_assert!(!hit, "hit at {}", near); }
    }

    #[test]
    fn erase_split_is_original_minus_eraser(s in written(), track in prop::collection::vec((-80f32..80.0, -80f32..80.0), 1..4), r in 0.5f32..12.0) {
        let track: Vec<[f32; 2]> = track.into_iter().map(|(x, y)| [x, y]).collect();
        let reach = |p: &Point| r + radius(s.tool, s.width, p.pressure);
        let tol = 0.05;
        // The original centre line, finely.
        let mut line: Vec<Point> = vec![];
        for w in s.points.windows(2) {
            let n = 40;
            for k in 0..n {
                let f = k as f32 / n as f32;
                line.push(Point { x: w[0].x + (w[1].x - w[0].x) * f, y: w[0].y + (w[1].y - w[0].y) * f, pressure: w[0].pressure + (w[1].pressure - w[0].pressure) * f, ..w[0] });
            }
        }
        line.extend(s.points.last());
        let out = erase_split(&s, &track, r);
        let Some(pieces) = out else {
            // Untouched: no point of the line is within reach (checked at the stored points and finely).
            for p in &line { prop_assert!(track_distance(&track, p.x, p.y) > reach(p) - 0.05); }
            return Ok(());
        };
        let on_piece = |p: &Point| pieces.iter().any(|pc| pc.points.windows(2).any(|w| {
            let (a, b) = (w[0], w[1]);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let l2 = dx * dx + dy * dy;
            let t = if l2 < 1e-12 { 0.0 } else { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) };
            ((p.x - a.x - t * dx).powi(2) + (p.y - a.y - t * dy).powi(2)).sqrt() <= tol
        }));
        for p in &line {
            let d = track_distance(&track, p.x, p.y);
            // Outside the eraser's reach: kept.
            if d > reach(p) + 0.3 { prop_assert!(on_piece(p), "lost {:?} at {}", p, d - reach(p)); }
        }
        for pc in &pieces {
            prop_assert_eq!(pc.tool, s.tool);
            prop_assert_eq!(&pc.z, &s.z);
            prop_assert!(pc.points.len() >= 2);
            for w in pc.points.windows(2) {
                for k in 0..=10 {
                    let f = k as f32 / 10.0;
                    let q = Point { x: w[0].x + (w[1].x - w[0].x) * f, y: w[0].y + (w[1].y - w[0].y) * f, pressure: w[0].pressure + (w[1].pressure - w[0].pressure) * f, ..w[0] };
                    // Nothing left within the eraser's reach...
                    prop_assert!(track_distance(&track, q.x, q.y) >= reach(&q) - 0.05, "kept ink under the eraser");
                    // ...and every piece lies on the original line.
                    let on_line = line.windows(2).any(|lw| {
                        let (a, b) = (lw[0], lw[1]);
                        let (dx, dy) = (b.x - a.x, b.y - a.y);
                        let l2 = dx * dx + dy * dy;
                        let t = if l2 < 1e-12 { 0.0 } else { (((q.x - a.x) * dx + (q.y - a.y) * dy) / l2).clamp(0.0, 1.0) };
                        ((q.x - a.x - t * dx).powi(2) + (q.y - a.y - t * dy).powi(2)).sqrt() <= tol
                    }) || line.len() == 1;
                    prop_assert!(on_line, "piece off the original line");
                }
            }
            // Pieces store and read back like any stroke.
            prop_assert!(blob::decode(&blob::encode(pc)).is_ok());
        }
    }
}
