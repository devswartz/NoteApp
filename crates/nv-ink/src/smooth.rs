//! Input smoothing and the builder that turns pen samples into a stroke.
//!
//! - A one-euro filter (Casiez, Roussel, Vogel 2012) on the pen's position: it smooths jitter when
//!   the pen moves slowly and gets out of the way when it moves fast, so the line stays close to the tip.
//! - The same filter on pressure: a Pencil's pressure flickers from sample to sample, and since the
//!   width follows pressure, unfiltered pressure gives a wobbly edge (Devon's first iPad round).
//! - A light pass over the kept points (`relax`), like Notability's stroke smoothing: the same in the
//!   preview and in the stored stroke, so nothing moves when the pen lifts.
//!
//! What the builder keeps is what's stored; the curve fit (`geom.rs`) happens when drawing.

use crate::blob::{flags, Point, Stroke};

/// Points closer than this (page px) to the last kept one are dropped (the blob stores 1/8 px).
pub const MIN_STEP: f32 = 0.5;

/// One-euro filter settings. Cutoffs are in Hz, beta per (page px / s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OneEuroConfig {
    pub min_cutoff: f32,
    pub beta: f32,
    pub d_cutoff: f32,
}

impl Default for OneEuroConfig {
    /// Tuned for a pen at 120-240 Hz: firm smoothing when slow, little when fast.
    /// Feel is judged on the device (PLAN_INK quality bar); these are the knobs.
    fn default() -> Self {
        OneEuroConfig {
            min_cutoff: 1.5,
            beta: 0.03,
            d_cutoff: 1.0,
        }
    }
}

/// The pressure filter: pressure changes slowly in real writing, so a steady low cutoff.
pub const PRESSURE_FILTER: OneEuroConfig = OneEuroConfig {
    min_cutoff: 2.5,
    beta: 0.0,
    d_cutoff: 1.0,
};

/// Passes of `relax` over the kept points.
pub const RELAX_PASSES: usize = 2;

/// Smooths the interior points of a stroke in place: each pass moves every point a quarter of the
/// way towards the midpoint of its neighbours (x, y and pressure). The ends stay put, so a stroke
/// starts and finishes where the pen did.
pub fn relax(points: &mut [Point], passes: usize) {
    if points.len() < 3 {
        return;
    }
    for _ in 0..passes {
        let mut prev = points[0];
        for i in 1..points.len() - 1 {
            let (a, cur, b) = (prev, points[i], points[i + 1]);
            prev = cur;
            let p = &mut points[i];
            p.x = 0.25 * a.x + 0.5 * cur.x + 0.25 * b.x;
            p.y = 0.25 * a.y + 0.5 * cur.y + 0.25 * b.y;
            p.pressure = 0.25 * a.pressure + 0.5 * cur.pressure + 0.25 * b.pressure;
        }
    }
}

fn alpha(cutoff: f32, dt: f32) -> f32 {
    let tau = 1.0 / (core::f32::consts::TAU * cutoff);
    1.0 / (1.0 + tau / dt)
}

/// A one-euro filter for one value.
#[derive(Clone, Debug)]
pub struct OneEuro {
    cfg: OneEuroConfig,
    x: Option<f32>,
    dx: f32,
}

impl OneEuro {
    pub fn new(cfg: OneEuroConfig) -> Self {
        OneEuro {
            cfg,
            x: None,
            dx: 0.0,
        }
    }
    /// The filtered value of `v`, `dt` seconds after the previous one.
    pub fn filter(&mut self, v: f32, dt: f32) -> f32 {
        let Some(prev) = self.x else {
            self.x = Some(v);
            return v;
        };
        let dt = if dt.is_finite() && dt > 0.0 {
            dt
        } else {
            1.0 / 240.0
        };
        let d = (v - prev) / dt;
        self.dx += alpha(self.cfg.d_cutoff, dt) * (d - self.dx);
        let cutoff = self.cfg.min_cutoff + self.cfg.beta * self.dx.abs();
        let x = prev + alpha(cutoff, dt) * (v - prev);
        self.x = Some(x);
        x
    }
}

/// Builds a stroke from pen samples as they arrive.
#[derive(Clone, Debug)]
pub struct StrokeBuilder {
    pub stroke: Stroke,
    fx: OneEuro,
    fy: OneEuro,
    fp: OneEuro,
    start: Option<f64>,
    last_t: f64,
    /// The newest filtered sample when it was too close to keep: it ends the stroke if nothing follows.
    pending: Option<Point>,
}

impl StrokeBuilder {
    /// A new stroke. `flags` says whether the device gives pressure and tilt.
    pub fn new(
        tool: u8,
        color: [u8; 4],
        width: f32,
        z: String,
        flags: u8,
        created: u64,
        cfg: OneEuroConfig,
    ) -> Self {
        StrokeBuilder {
            stroke: Stroke {
                tool,
                color,
                width,
                z,
                flags,
                created,
                points: Vec::new(),
            },
            fx: OneEuro::new(cfg),
            fy: OneEuro::new(cfg),
            fp: OneEuro::new(PRESSURE_FILTER),
            start: None,
            last_t: 0.0,
            pending: None,
        }
    }

    /// A pen sample: page px, pressure 0..=1, tilt in radians, time in ms (any clock that only runs forwards).
    pub fn push(&mut self, x: f32, y: f32, pressure: f32, altitude: f32, azimuth: f32, t_ms: f64) {
        if !x.is_finite()
            || !y.is_finite()
            || self.stroke.points.len() >= crate::blob::MAX_POINTS - 1
        {
            return;
        }
        let t_ms = if t_ms.is_finite() { t_ms } else { self.last_t };
        let start = *self.start.get_or_insert(t_ms);
        let dt = ((t_ms - self.last_t).max(0.0) / 1000.0) as f32;
        let first = self.stroke.points.is_empty() && self.pending.is_none();
        self.last_t = self.last_t.max(t_ms);
        let (fx, fy) = (self.fx.filter(x, dt), self.fy.filter(y, dt));
        let pressure = if self.stroke.flags & flags::PRESSURE != 0 && pressure.is_finite() {
            self.fp.filter(pressure.clamp(0.0, 1.0), dt)
        } else {
            0.5
        };
        let t = (self.last_t - start).clamp(0.0, u32::MAX as f64) as u32;
        let p = Point {
            x: fx,
            y: fy,
            pressure,
            altitude,
            azimuth,
            t,
        };
        if first {
            self.stroke.points.push(p);
            return;
        }
        let last = *self.stroke.points.last().unwrap_or(&p);
        let far = ((p.x - last.x).powi(2) + (p.y - last.y).powi(2)).sqrt() >= MIN_STEP;
        if far || (p.pressure - last.pressure).abs() > 0.1 {
            self.stroke.points.push(p);
            self.pending = None;
        } else {
            self.pending = Some(p);
        }
    }

    /// The stroke so far (relaxed, as it will be stored) plus `predicted` points (x, y, pressure),
    /// unfiltered, for drawing ahead of the pen.
    pub fn preview(&self, predicted: &[[f32; 3]]) -> Vec<Point> {
        let mut pts = self.stroke.points.clone();
        pts.extend(self.pending);
        relax(&mut pts, RELAX_PASSES);
        let t = pts.last().map_or(0, |p| p.t);
        pts.extend(
            predicted
                .iter()
                .filter(|p| p[0].is_finite() && p[1].is_finite())
                .map(|p| Point {
                    t,
                    ..Point::new(p[0], p[1], p[2])
                }),
        );
        pts
    }

    /// The finished stroke (the last sample included even when it was close), relaxed.
    pub fn finish(mut self) -> Stroke {
        if let Some(p) = self.pending.take() {
            self.stroke.points.push(p);
        }
        relax(&mut self.stroke.points, RELAX_PASSES);
        self.stroke
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_input_passes_through() {
        let mut f = OneEuro::new(OneEuroConfig::default());
        for _ in 0..100 {
            f.filter(5.0, 1.0 / 240.0);
        }
        assert!((f.filter(5.0, 1.0 / 240.0) - 5.0).abs() < 1e-4);
    }

    #[test]
    fn jitter_is_damped_when_slow() {
        let mut f = OneEuro::new(OneEuroConfig::default());
        let mut max: f32 = 0.0;
        for i in 0..240 {
            let v = if i % 2 == 0 { 0.5 } else { -0.5 };
            max = max.max(f.filter(v, 1.0 / 240.0).abs());
        }
        assert!(max <= 0.5);
        let late = f.filter(0.5, 1.0 / 240.0).abs();
        assert!(late < 0.25, "{late}");
    }

    #[test]
    fn fast_moves_lag_little() {
        let mut f = OneEuro::new(OneEuroConfig::default());
        let mut y = 0.0;
        for i in 0..120 {
            y = f.filter(i as f32 * 10.0, 1.0 / 240.0); // 2400 px/s
        }
        assert!(1190.0 - y < 25.0, "lag {}", 1190.0 - y);
    }

    #[test]
    fn builder_thins_and_keeps_the_end() {
        let mut b = StrokeBuilder::new(
            0,
            [0, 0, 0, 255],
            2.0,
            "a".into(),
            flags::PRESSURE,
            0,
            OneEuroConfig::default(),
        );
        for i in 0..50 {
            b.push(i as f32 * 0.05, 0.0, 0.5, 1.0, 0.0, i as f64 * 4.0);
        }
        let n = b.stroke.points.len();
        let s = b.finish();
        assert!(n < 10);
        assert_eq!(s.points.len(), n + 1);
        assert_eq!(s.points.last().unwrap().t, 196);
    }

    #[test]
    fn pressure_flicker_is_smoothed() {
        let mut b = StrokeBuilder::new(
            0,
            [0; 4],
            2.0,
            "a".into(),
            flags::PRESSURE,
            0,
            OneEuroConfig::default(),
        );
        // A steady line with pressure flickering 0.4 / 0.6 every sample (a Pencil at 240 Hz).
        for i in 0..240 {
            let p = if i % 2 == 0 { 0.4 } else { 0.6 };
            b.push(i as f32 * 2.0, 0.0, p, 1.0, 0.0, i as f64 * 1000.0 / 240.0);
        }
        let s = b.finish();
        let late: Vec<f32> = s.points[60..].iter().map(|p| p.pressure).collect();
        let (lo, hi) = late
            .iter()
            .fold((1.0f32, 0.0f32), |(l, h), &p| (l.min(p), h.max(p)));
        assert!(hi - lo < 0.05, "pressure still flickers: {lo}..{hi}");
    }

    #[test]
    fn position_jitter_is_smoothed_and_ends_stay() {
        let mut b = StrokeBuilder::new(0, [0; 4], 2.0, "a".into(), 0, 0, OneEuroConfig::default());
        // A slow horizontal line with 0.6 px up/down jitter.
        for i in 0..240 {
            let y = if i % 2 == 0 { 0.6 } else { -0.6 };
            b.push(i as f32 * 0.8, y, 0.5, 1.0, 0.0, i as f64 * 1000.0 / 240.0);
        }
        let s = b.finish();
        let mid = &s.points[80..s.points.len() - 10]; // after the filter settles from the first sample
        let worst = mid.iter().map(|p| p.y.abs()).fold(0.0f32, f32::max);
        assert!(worst < 0.15, "jitter left: {worst}");
        assert_eq!(
            s.points.first().unwrap().x,
            0.0,
            "the start stays where the pen went down"
        );
    }

    #[test]
    fn preview_matches_the_stored_stroke() {
        let mut b = StrokeBuilder::new(
            0,
            [0; 4],
            2.0,
            "a".into(),
            flags::PRESSURE,
            0,
            OneEuroConfig::default(),
        );
        for i in 0..60 {
            let f = i as f32;
            b.push(
                f * 3.0,
                (f * 0.2).sin() * 20.0,
                0.5,
                1.0,
                0.0,
                i as f64 * 8.0,
            );
        }
        let preview = b.preview(&[]);
        let stored = b.finish().points;
        assert_eq!(preview.len(), stored.len());
        for (a, s) in preview.iter().zip(&stored) {
            assert!(
                (a.x - s.x).abs() < 1e-4 && (a.y - s.y).abs() < 1e-4,
                "the line moves when the pen lifts"
            );
        }
    }

    #[test]
    fn mouse_pressure_is_even() {
        let mut b = StrokeBuilder::new(0, [0; 4], 2.0, "a".into(), 0, 0, OneEuroConfig::default());
        b.push(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        b.push(10.0, 0.0, 1.0, 1.0, 0.0, 10.0);
        assert!(b.finish().points.iter().all(|p| p.pressure == 0.5));
    }
}
