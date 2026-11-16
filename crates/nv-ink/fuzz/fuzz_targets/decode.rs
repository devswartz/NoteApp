//! Ink blobs arrive from other clients (page docs sync over the network), so decoding them must
//! never panic, hang or allocate wildly, and whatever decodes must survive the whole pipeline.
#![no_main]

use libfuzzer_sys::fuzz_target;
use nv_ink::{blob, erase, geom, hit};

fuzz_target!(|data: &[u8]| {
    let _ = blob::decode_header(data);
    let Ok(s) = blob::decode(data) else { return };
    // Stores and reads back unchanged.
    assert_eq!(blob::decode(&blob::encode(&s)).as_ref(), Ok(&s));
    let sm = geom::samples(&s);
    let p = geom::pieces(&sm);
    let _ = geom::path_ops(&p);
    let _ = geom::svg_path(&p);
    let _ = hit::hit_point(&sm, 0.0, 0.0, 4.0);
    let _ = erase::erase_split(&s, &[[0.0, 0.0], [50.0, 50.0]], 4.0);
});
