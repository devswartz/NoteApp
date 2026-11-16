//! Input smoothing: a one-euro filter (Casiez, Roussel, Vogel 2012) on the pen's position, and
//! the builder that turns pen samples into a stroke. The filter smooths jitter when the pen
//! moves slowly and gets out of the way when it moves fast, so the line stays close to the tip.
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
    /// Tuned for a pen at 120-240 Hz: light smoothing when slow, almost none when fast.
    /// Feel is judged on the device (PLAN_INK quality bar); these are the knobs.
    fn default() -> Self {
        OneEuroConfig {
            min_cutoff: 4.0,
            beta: 0.04,
            d_cutoff: 1.0,
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
        let pressure = if self.stroke.flags & flags::PRESSURE != 0 {
            pressure
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

    /// The stroke so far plus `predicted` points (x, y, pressure), unfiltered, for drawing ahead of the pen.
    pub fn preview(&self, predicted: &[[f32; 3]]) -> Vec<Point> {
        let mut pts = self.stroke.points.clone();
        pts.extend(self.pending);
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

    /// The finished stroke (the last sample included even when it was close).
    pub fn finish(mut self) -> Stroke {
        if let Some(p) = self.pending.take() {
            self.stroke.points.push(p);
        }
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
    fn mouse_pressure_is_even() {
        let mut b = StrokeBuilder::new(0, [0; 4], 2.0, "a".into(), 0, 0, OneEuroConfig::default());
        b.push(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        b.push(10.0, 0.0, 1.0, 1.0, 0.0, 10.0);
        assert!(b.finish().points.iter().all(|p| p.pressure == 0.5));
    }
}
