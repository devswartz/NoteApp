// The C ABI of the ink engine (crates/nv-ink/src/ffi.rs, `ffi` feature), used by the iPad app
// through apps/mobile/ios/App/NvInk. Hand-written: keep it in step with ffi.rs.
// Blobs passed in are borrowed for the call; every NvBuf / NvFloats returned is freed with
// nv_ink_buf_free / nv_ink_floats_free. A builder is released by finish or free.
#ifndef NV_INK_H
#define NV_INK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct NvBuf { uint8_t *ptr; size_t len; size_t cap; } NvBuf;
typedef struct NvFloats { float *ptr; size_t len; size_t cap; } NvFloats;
typedef struct NvInkBuilder NvInkBuilder;

void nv_ink_buf_free(NvBuf b);
void nv_ink_floats_free(NvFloats f);
uint8_t nv_ink_format_version(void);

/// color is 0xRRGGBBAA; z a NUL-terminated z key; created ms since the epoch.
NvInkBuilder *nv_ink_builder_new(uint8_t tool, uint32_t color, float width, const char *z, uint8_t flags, double created);
/// Page px, pressure 0..1, altitude/azimuth radians, time ms.
void nv_ink_builder_push(NvInkBuilder *b, float x, float y, float pressure, float altitude, float azimuth, double t);
size_t nv_ink_builder_count(const NvInkBuilder *b);
/// Triangles (x, y per vertex) of the stroke so far plus n_pred predicted (x, y, pressure) samples.
NvFloats nv_ink_builder_preview_triangles(const NvInkBuilder *b, const float *predicted, size_t n_pred);
/// The blob (empty without points); releases the builder.
NvBuf nv_ink_builder_finish(NvInkBuilder *b);
void nv_ink_builder_free(NvInkBuilder *b);

/// 11 doubles: version, tool, rgba, width, flags, created, count, minX, minY, maxX, maxY.
bool nv_ink_info(const uint8_t *data, size_t len, double *out);
/// The z key's UTF-8 bytes (not NUL-terminated; empty when the header doesn't decode).
NvBuf nv_ink_z(const uint8_t *data, size_t len);
/// Path commands: 0 x y move, 1 x y line, 2 cx cy r circle, 3 close (fill nonzero).
NvFloats nv_ink_path(const uint8_t *data, size_t len);
NvFloats nv_ink_triangles(const uint8_t *data, size_t len);
bool nv_ink_hit_path(const uint8_t *data, size_t len, const float *track, size_t n, float r);
/// False when the eraser misses. Otherwise the pieces left, framed: u32 count, then u32 length + bytes each (LE).
bool nv_ink_erase(const uint8_t *data, size_t len, const float *track, size_t n, float r, NvBuf *out);
/// points: n x (x, y, pressure, altitude, azimuth, t).
NvBuf nv_ink_encode(uint8_t tool, uint32_t color, float width, const char *z, uint8_t flags, double created, const float *points, size_t n);

#endif
