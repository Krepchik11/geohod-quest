//! §5/§12.7 — quest cover → home-screen icon.
//!
//! An installed per-quest PWA needs real 192/512 PNG icons whose pixel size
//! matches the manifest declaration (Chromium verifies). The cover is an
//! arbitrary photo, so we center-crop it to a square, scale it into the
//! maskable SAFE ZONE (80% of the canvas) and composite it on the brand navy —
//! the same output serves `purpose: any` and `purpose: maskable`.
//!
//! Pure functions: the axum handler stays a thin shell and tests run on bytes.

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage, imageops};

/// Brand navy (#122947) — the icon backdrop and the no-cover fallback base.
const NAVY: Rgba<u8> = Rgba([0x12, 0x29, 0x47, 0xFF]);

/// Fraction of the canvas the cover occupies — the maskable safe zone is a
/// centered circle of 80% diameter, so 0.8 keeps every pixel inside it.
const SAFE_ZONE: f32 = 0.8;

/// Compose a `size`×`size` PNG icon from raw cover bytes (jpeg/png/webp/gif).
pub fn compose_icon(cover_bytes: &[u8], size: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(cover_bytes).map_err(|e| format!("decode: {e}"))?;
    let square = center_crop_square(&img);
    let inner = (size as f32 * SAFE_ZONE) as u32;
    let scaled = square.resize_exact(inner, inner, imageops::FilterType::Lanczos3);

    let mut canvas = RgbaImage::from_pixel(size, size, NAVY);
    let offset = ((size - inner) / 2) as i64;
    imageops::overlay(&mut canvas, &scaled.to_rgba8(), offset, offset);
    encode_png(&canvas)
}

fn center_crop_square(img: &DynamicImage) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let side = w.min(h);
    let x = (w - side) / 2;
    let y = (h - side) / 2;
    img.crop_imm(x, y, side, side)
}

fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)
        .map_err(|e| format!("encode: {e}"))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = RgbaImage::from_fn(w, h, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        });
        let mut out = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .to_rgb8()
            .write_to(&mut out, ImageFormat::Jpeg)
            .expect("encode jpeg");
        out.into_inner()
    }

    #[test]
    fn compose_icon_emits_exact_size_png_on_navy() {
        for size in [192u32, 512] {
            let png = compose_icon(&sample_jpeg(640, 480), size).expect("icon");
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "png signature");
            let decoded = image::load_from_memory(&png).expect("decode back");
            assert_eq!((decoded.width(), decoded.height()), (size, size));
            // Corners lie outside the 80% safe zone → pure navy backdrop.
            let rgba = decoded.to_rgba8();
            assert_eq!(rgba.get_pixel(1, 1), &NAVY);
            assert_eq!(rgba.get_pixel(size - 2, size - 2), &NAVY);
        }
    }

    #[test]
    fn compose_icon_rejects_garbage() {
        assert!(compose_icon(b"not an image", 192).is_err());
    }
}
