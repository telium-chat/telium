//! Normalizes emoji/sticker uploads: decode, bound, re-encode deterministically (PNG still, GIF animation).

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;

use color_quant::NeuQuant;
use image::codecs::gif::GifDecoder;
use image::codecs::jpeg::JpegDecoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngDecoder, PngEncoder};
use image::codecs::webp::WebPDecoder;
use image::imageops::FilterType;
use image::{
    AnimationDecoder, DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat,
    Rgba, RgbaImage,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Emoji,
    Sticker,
}

impl Kind {
    pub fn noun(self) -> &'static str {
        match self {
            Kind::Emoji => "emoji",
            Kind::Sticker => "sticker",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Gif,
    WebP,
    Jpeg,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Png => "PNG",
            Format::Gif => "GIF",
            Format::WebP => "WebP",
            Format::Jpeg => "JPEG",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Box side for an emoji; larger inputs scale down, smaller are left alone.
    pub emoji_box: u32,
    pub sticker_box: u32,
    /// Max pixels of one source frame, checked from the header before decoding.
    pub max_source_pixels: u64,
    /// Max source pixels across all animation frames; also lowers the frame cap on large canvases.
    pub max_total_pixels: u64,
    pub max_frames: usize,
    pub max_duration_ms: u32,
    /// Past the caps: drop the tail (true) or refuse.
    pub drop_excess_frames: bool,
}

impl Limits {
    pub fn from_config(cfg: &crate::config::Limits) -> Self {
        Self {
            emoji_box: cfg.emoji_max_dimension.max(1),
            sticker_box: cfg.sticker_max_dimension.max(1),
            max_source_pixels: cfg.expression_max_source_pixels.max(1),
            max_total_pixels: cfg.expression_max_total_pixels.max(1),
            max_frames: cfg.expression_max_frames.max(1),
            max_duration_ms: cfg.expression_max_duration_ms,
            drop_excess_frames: cfg.expression_drop_excess_frames,
        }
    }

    pub fn box_for(&self, kind: Kind) -> (u32, u32) {
        let side = match kind {
            Kind::Emoji => self.emoji_box,
            Kind::Sticker => self.sticker_box,
        };
        (side, side)
    }

    /// Allocation bound for the decoder: the canvases an animation decoder keeps, in RGBA8.
    fn decoder_limits(&self) -> image::Limits {
        let mut limits = image::Limits::no_limits();
        limits.max_alloc = Some(self.max_source_pixels.saturating_mul(4).saturating_mul(4));
        limits
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub animated: bool,
    pub frames: usize,
}

impl Normalized {
    pub fn format(&self) -> &'static str {
        if self.animated { "gif" } else { "png" }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Rejected {
    #[error("not a PNG, APNG, GIF, WebP or JPEG image (SVG and other formats are not accepted)")]
    Unsupported,
    #[error("the image could not be decoded: {0}")]
    Undecodable(String),
    #[error("{width}x{height} is over the {budget}-pixel limit for a source image")]
    TooManyPixels { width: u32, height: u32, budget: u64 },
    #[error("the animation has more than {cap} frames, which is the most a {width}x{height} animation may have here")]
    TooManyFrames { cap: usize, width: u32, height: u32 },
    #[error("the animation runs longer than {cap_ms} ms")]
    TooLong { cap_ms: u32 },
}

/// Shorter frames are shown at 100 ms by every browser; match that.
const BROWSER_ZERO_DELAY_MS: u32 = 10;
const BROWSER_ZERO_DELAY_REPLACEMENT_MS: u32 = 100;
/// Delay clamp: two GIF ticks to ten seconds.
const MIN_DELAY_MS: u32 = 20;
const MAX_DELAY_MS: u32 = 10_000;
/// Palette sample cap, taken at a fixed stride so quantization is deterministic.
const PALETTE_SAMPLE_PIXELS: usize = 1 << 18;
/// The GIF palette entry reserved for transparency; the other 255 are colours.
const TRANSPARENT_INDEX: u8 = 255;
/// Pixels at or above this alpha are opaque in the GIF; below it, transparent.
const ALPHA_CUTOFF: u8 = 128;

/// Container from magic number alone; the migration import uses it to flag assets this server would reject.
pub fn sniff(bytes: &[u8]) -> Result<Format, Rejected> {
    match image::guess_format(bytes) {
        Ok(ImageFormat::Png) => Ok(Format::Png),
        Ok(ImageFormat::Gif) => Ok(Format::Gif),
        Ok(ImageFormat::WebP) => Ok(Format::WebP),
        Ok(ImageFormat::Jpeg) => Ok(Format::Jpeg),
        _ => Err(Rejected::Unsupported),
    }
}

/// Decode, bound and re-encode an expression upload; `kind` picks the box, `limits` the budgets.
pub fn normalize(bytes: &[u8], kind: Kind, limits: &Limits) -> Result<Normalized, Rejected> {
    let format = sniff(bytes)?;
    let cursor = Cursor::new(bytes);
    let fit = Fit { limits, kind };
    let frames = match format {
        Format::Gif => {
            let mut decoder = GifDecoder::new(cursor).map_err(undecodable)?;
            let (width, height) = admit(&mut decoder, limits)?;
            animation(decoder.into_frames(), width, height, fit)?
        }
        Format::Png => {
            let mut decoder =
                PngDecoder::with_limits(cursor, limits.decoder_limits()).map_err(undecodable)?;
            let (width, height) = admit(&mut decoder, limits)?;
            if decoder.is_apng().map_err(undecodable)? {
                let frames = decoder.apng().map_err(undecodable)?.into_frames();
                animation(frames, width, height, fit)?
            } else {
                still(decoder, fit)?
            }
        }
        Format::WebP => {
            let mut decoder = WebPDecoder::new(cursor).map_err(undecodable)?;
            let (width, height) = admit(&mut decoder, limits)?;
            if decoder.has_animation() {
                animation(decoder.into_frames(), width, height, fit)?
            } else {
                still(decoder, fit)?
            }
        }
        Format::Jpeg => {
            let mut decoder = JpegDecoder::new(cursor).map_err(undecodable)?;
            admit(&mut decoder, limits)?;
            still(decoder, fit)?
        }
    };
    encode(frames)
}

#[derive(Clone, Copy)]
struct Fit<'a> {
    limits: &'a Limits,
    kind: Kind,
}

/// One fitted frame and its delay in GIF ticks (10 ms).
struct Frame {
    image: RgbaImage,
    ticks: u16,
}

fn undecodable(e: image::ImageError) -> Rejected {
    Rejected::Undecodable(e.to_string())
}

/// Header check before any pixel decode: declared dimensions against the source budget, then the decoder's own limits.
fn admit(decoder: &mut impl ImageDecoder, limits: &Limits) -> Result<(u32, u32), Rejected> {
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err(Rejected::Undecodable("the image has no pixels".into()));
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > limits.max_source_pixels {
        return Err(Rejected::TooManyPixels { width, height, budget: limits.max_source_pixels });
    }
    let mut decoder_limits = limits.decoder_limits();
    decoder_limits.max_image_width = Some(width);
    decoder_limits.max_image_height = Some(height);
    decoder.set_limits(decoder_limits).map_err(undecodable)?;
    Ok((width, height))
}

fn still(decoder: impl ImageDecoder, fit: Fit<'_>) -> Result<Vec<Frame>, Rejected> {
    let image = DynamicImage::from_decoder(decoder).map_err(undecodable)?.into_rgba8();
    Ok(vec![Frame { image: fit.apply(image), ticks: 0 }])
}

fn animation(
    mut frames: image::Frames<'_>,
    width: u32,
    height: u32,
    fit: Fit<'_>,
) -> Result<Vec<Frame>, Rejected> {
    let limits = fit.limits;
    let per_frame = u64::from(width) * u64::from(height);
    // Frame cap for this canvas: fewer than configured if the total pixel budget demands.
    let by_work = usize::try_from(limits.max_total_pixels / per_frame).unwrap_or(usize::MAX);
    let cap = limits.max_frames.min(by_work).max(1);

    let mut kept: Vec<Frame> = Vec::new();
    let mut total_ms: u32 = 0;
    loop {
        if kept.len() >= cap {
            if limits.drop_excess_frames {
                // Not even decoded: the tail is dropped without being paid for.
                break;
            }
            match frames.next() {
                None => break,
                Some(Err(e)) => return Err(undecodable(e)),
                Some(Ok(_)) => return Err(Rejected::TooManyFrames { cap, width, height }),
            }
        }
        let Some(next) = frames.next() else { break };
        let frame = next.map_err(undecodable)?;
        let ticks = ticks(frame.delay());
        let ms = u32::from(ticks) * 10;
        if !kept.is_empty() && total_ms.saturating_add(ms) > limits.max_duration_ms {
            if limits.drop_excess_frames {
                break;
            }
            return Err(Rejected::TooLong { cap_ms: limits.max_duration_ms });
        }
        total_ms = total_ms.saturating_add(ms);
        let (left, top) = (frame.left(), frame.top());
        let mut image = frame.into_buffer();
        // Guard for a decoder that hands out a sub-rectangle; the GIF encoder needs one size.
        if image.dimensions() != (width, height) {
            let mut canvas = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
            image::imageops::overlay(&mut canvas, &image, i64::from(left), i64::from(top));
            image = canvas;
        }
        kept.push(Frame { image: fit.apply(image), ticks });
    }
    if kept.is_empty() {
        return Err(Rejected::Undecodable("the animation has no frames".into()));
    }
    Ok(kept)
}

fn ticks(delay: image::Delay) -> u16 {
    let (numer, denom) = delay.numer_denom_ms();
    let ms = if denom == 0 { 0 } else { numer / denom };
    let ms = if ms < BROWSER_ZERO_DELAY_MS { BROWSER_ZERO_DELAY_REPLACEMENT_MS } else { ms };
    let ms = ms.clamp(MIN_DELAY_MS, MAX_DELAY_MS);
    // Rounded to the tick, never below the floor: 25 ms is 3 ticks, not 2.
    u16::try_from((ms + 5) / 10).unwrap_or(u16::MAX).max(2)
}

pub fn fitted(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    if width <= max_width && height <= max_height {
        return (width, height);
    }
    // Integer arithmetic, so the answer does not depend on float rounding.
    let by_width = (u64::from(max_width), u64::from(height) * u64::from(max_width) / u64::from(width));
    let by_height = (u64::from(width) * u64::from(max_height) / u64::from(height), u64::from(max_height));
    let (w, h) = if by_width.1 <= u64::from(max_height) { by_width } else { by_height };
    (w.max(1) as u32, h.max(1) as u32)
}

impl Fit<'_> {
    /// Scale down into the box, never up, on premultiplied alpha (straight alpha fringes dark around transparent edges).
    fn apply(self, image: RgbaImage) -> RgbaImage {
        let (width, height) = image.dimensions();
        let (max_width, max_height) = self.limits.box_for(self.kind);
        let (w, h) = fitted(width, height, max_width, max_height);
        if (w, h) == (width, height) {
            return image;
        }
        let mut premultiplied = image;
        for p in premultiplied.pixels_mut() {
            let a = u16::from(p[3]);
            for c in &mut p.0[..3] {
                *c = ((u16::from(*c) * a + 127) / 255) as u8;
            }
        }
        let mut resized = image::imageops::resize(&premultiplied, w, h, FilterType::Lanczos3);
        for p in resized.pixels_mut() {
            let a = u16::from(p[3]);
            if a == 0 {
                p.0 = [0, 0, 0, 0];
                continue;
            }
            for c in &mut p.0[..3] {
                *c = ((u16::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
        resized
    }
}

fn encode(frames: Vec<Frame>) -> Result<Normalized, Rejected> {
    let (width, height) = frames[0].image.dimensions();
    let count = frames.len();
    if count == 1 {
        let bytes = encode_png(&frames[0].image)?;
        return Ok(Normalized { bytes, mime: "image/png", width, height, animated: false, frames: 1 });
    }
    let bytes = encode_gif(&frames, width, height)?;
    Ok(Normalized { bytes, mime: "image/gif", width, height, animated: true, frames: count })
}

fn internal(what: &str, e: impl std::fmt::Display) -> Rejected {
    // An encoder failure on our own pixels is a bug here, but still a showable error.
    Rejected::Undecodable(format!("re-encoding as {what} failed: {e}"))
}

/// Still image as a PNG with fixed settings and only IHDR, IDAT and IEND chunks.
fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, Rejected> {
    let (width, height) = image.dimensions();
    let mut out = Vec::new();
    let encoder = PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::Adaptive);
    let opaque = image.pixels().all(|p| p[3] == 255);
    if opaque {
        let rgb = DynamicImage::ImageRgba8(image.clone()).into_rgb8();
        encoder
            .write_image(rgb.as_raw(), width, height, ExtendedColorType::Rgb8)
            .map_err(|e| internal("PNG", e))?;
    } else {
        encoder
            .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
            .map_err(|e| internal("PNG", e))?;
    }
    Ok(out)
}

/// Animation as a GIF: one global palette, whole disposed frames, infinite loop.
fn encode_gif(frames: &[Frame], width: u32, height: u32) -> Result<Vec<u8>, Rejected> {
    let (w, h) = match (u16::try_from(width), u16::try_from(height)) {
        (Ok(w), Ok(h)) => (w, h),
        _ => return Err(internal("GIF", "the canvas is wider than a GIF can be")),
    };
    let quantizer = palette(frames);
    let mut palette = quantizer.color_map_rgb();
    palette.resize(usize::from(TRANSPARENT_INDEX) * 3, 0);
    palette.extend_from_slice(&[0, 0, 0]);

    let mut out = Vec::new();
    {
        let mut encoder =
            gif::Encoder::new(&mut out, w, h, &palette).map_err(|e| internal("GIF", e))?;
        encoder.set_repeat(gif::Repeat::Infinite).map_err(|e| internal("GIF", e))?;
        // Nearest-palette lookup is pure, so memoizing it cannot change output.
        let mut nearest: HashMap<[u8; 3], u8> = HashMap::new();
        for frame in frames {
            let indices: Vec<u8> = frame
                .image
                .pixels()
                .map(|p| {
                    if p[3] < ALPHA_CUTOFF {
                        return TRANSPARENT_INDEX;
                    }
                    let key = [p[0], p[1], p[2]];
                    *nearest.entry(key).or_insert_with(|| {
                        quantizer.index_of(&[key[0], key[1], key[2], 255]) as u8
                    })
                })
                .collect();
            let gif_frame = gif::Frame {
                delay: frame.ticks,
                dispose: gif::DisposalMethod::Background,
                transparent: Some(TRANSPARENT_INDEX),
                width: w,
                height: h,
                buffer: Cow::Owned(indices),
                ..gif::Frame::default()
            };
            encoder.write_frame(&gif_frame).map_err(|e| internal("GIF", e))?;
        }
    }
    Ok(out)
}

/// 255-colour NeuQuant palette from a fixed-stride sample of opaque pixels; deterministic.
fn palette(frames: &[Frame]) -> NeuQuant {
    let opaque: usize = frames
        .iter()
        .map(|f| f.image.pixels().filter(|p| p[3] >= ALPHA_CUTOFF).count())
        .sum();
    let stride = (opaque / PALETTE_SAMPLE_PIXELS).max(1);
    let mut sample = Vec::with_capacity(4 * (opaque / stride + 1));
    let mut seen = 0usize;
    for frame in frames {
        for p in frame.image.pixels().filter(|p| p[3] >= ALPHA_CUTOFF) {
            if seen % stride == 0 {
                sample.extend_from_slice(&[p[0], p[1], p[2], 255]);
            }
            seen += 1;
        }
    }
    if sample.is_empty() {
        // A fully transparent animation still needs a palette to be written.
        sample.extend_from_slice(&[0, 0, 0, 255]);
    }
    NeuQuant::new(1, usize::from(TRANSPARENT_INDEX), &sample)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::gif::GifEncoder;
    use image::{Delay, ImageBuffer, Rgb};
    use std::time::Duration;

    fn limits() -> Limits {
        Limits {
            emoji_box: 128,
            sticker_box: 320,
            max_source_pixels: 4096 * 4096,
            max_total_pixels: 256 * 1024 * 1024,
            max_frames: 250,
            max_duration_ms: 30_000,
            drop_excess_frames: true,
        }
    }

    fn picture(width: u32, height: u32) -> RgbaImage {
        ImageBuffer::from_fn(width, height, |x, y| {
            let a = if x < width / 4 && y < height / 4 { 90 } else { 255 };
            Rgba([(x * 255 / width.max(1)) as u8, (y * 255 / height.max(1)) as u8, 128, a])
        })
    }

    fn png_bytes(image: &RgbaImage) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image.clone()).write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn jpeg_bytes(width: u32, height: u32) -> Vec<u8> {
        let rgb: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(width, height, |x, y| Rgb([x as u8, y as u8, 200]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(rgb).write_to(&mut out, ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }

    fn gif_bytes(width: u32, height: u32, frames: usize, delay_ms: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        {
            let mut encoder = GifEncoder::new(&mut out);
            encoder.set_repeat(image::codecs::gif::Repeat::Infinite).unwrap();
            for i in 0..frames {
                let shade = (i * 40 % 256) as u8;
                let image = RgbaImage::from_pixel(width, height, Rgba([shade, 255 - shade, 60, 255]));
                let delay = Delay::from_saturating_duration(Duration::from_millis(u64::from(delay_ms)));
                encoder.encode_frame(image::Frame::from_parts(image, 0, 0, delay)).unwrap();
            }
        }
        out.into_inner()
    }

    fn png_chunks(bytes: &[u8]) -> Vec<String> {
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let mut chunks = Vec::new();
        let mut at = 8;
        while at + 8 <= bytes.len() {
            let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            chunks.push(String::from_utf8_lossy(&bytes[at + 4..at + 8]).into_owned());
            at += 12 + len;
        }
        chunks
    }

    fn decode(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory(bytes).unwrap()
    }

    #[test]
    fn a_small_png_comes_back_as_a_png_of_the_same_size_and_pixels() {
        let source = picture(48, 32);
        let out = normalize(&png_bytes(&source), Kind::Emoji, &limits()).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (48, 32), "a small image is not upscaled");
        assert!(!out.animated);
        assert_eq!(out.frames, 1);
        assert_eq!(out.format(), "png");
        assert_eq!(decode(&out.bytes).into_rgba8(), source, "a lossless input is re-encoded losslessly");
    }

    #[test]
    fn an_oversized_png_is_downscaled_into_the_box_keeping_its_shape() {
        let out = normalize(&png_bytes(&picture(640, 320)), Kind::Emoji, &limits()).unwrap();
        assert_eq!((out.width, out.height), (128, 64));
        assert_eq!(decode(&out.bytes).into_rgba8().dimensions(), (128, 64));

        let tall = normalize(&png_bytes(&picture(100, 400)), Kind::Emoji, &limits()).unwrap();
        assert_eq!((tall.width, tall.height), (32, 128));

        let out = normalize(&png_bytes(&picture(640, 320)), Kind::Sticker, &limits()).unwrap();
        assert_eq!((out.width, out.height), (320, 160));
    }

    #[test]
    fn a_jpeg_becomes_an_opaque_png() {
        let out = normalize(&jpeg_bytes(64, 40), Kind::Sticker, &limits()).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (64, 40));
        assert!(!out.animated);
        let decoded = decode(&out.bytes);
        assert!(!decoded.color().has_alpha(), "no translucent pixel, so no alpha channel");
    }

    #[test]
    fn what_is_not_an_image_is_refused_with_the_reason() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";
        assert_eq!(normalize(svg, Kind::Emoji, &limits()), Err(Rejected::Unsupported));
        assert_eq!(normalize(b"just some text", Kind::Emoji, &limits()), Err(Rejected::Unsupported));
        assert_eq!(normalize(b"", Kind::Emoji, &limits()), Err(Rejected::Unsupported));
        let noise: Vec<u8> = (0..4096u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        assert_eq!(normalize(&noise, Kind::Emoji, &limits()), Err(Rejected::Unsupported));
        assert!(Rejected::Unsupported.to_string().contains("SVG"));

        let mut truncated = png_bytes(&picture(64, 64));
        truncated.truncate(40);
        assert!(matches!(normalize(&truncated, Kind::Emoji, &limits()), Err(Rejected::Undecodable(_))));
    }

    #[test]
    fn a_header_claiming_a_huge_canvas_is_refused_before_anything_is_decoded() {
        // 40000x40000 RGBA header with a one-byte IDAT: the error must name the size check.
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&40000u32.to_be_bytes());
        ihdr.extend_from_slice(&40000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        for (kind, data) in [(&b"IHDR"[..], &ihdr[..]), (b"IDAT", &[0u8][..]), (b"IEND", &[][..])] {
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(data);
            bytes.extend_from_slice(&crc32(kind, data).to_be_bytes());
        }
        let err = normalize(&bytes, Kind::Emoji, &limits()).unwrap_err();
        assert_eq!(
            err,
            Rejected::TooManyPixels { width: 40000, height: 40000, budget: 4096 * 4096 }
        );

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&40000u16.to_le_bytes());
        gif.extend_from_slice(&40000u16.to_le_bytes());
        gif.extend_from_slice(&[0x00, 0, 0]);
        gif.push(0x2C);
        gif.extend_from_slice(&[0, 0, 0, 0]);
        gif.extend_from_slice(&40000u16.to_le_bytes());
        gif.extend_from_slice(&40000u16.to_le_bytes());
        gif.extend_from_slice(&[0x00, 0x02, 0x01, 0x44, 0x00, 0x3B]);
        let err = normalize(&gif, Kind::Emoji, &limits()).unwrap_err();
        assert!(matches!(err, Rejected::TooManyPixels { width: 40000, height: 40000, .. }), "{err}");
    }

    #[test]
    fn an_animated_gif_stays_animated_with_normalized_delays() {
        let out = normalize(&gif_bytes(40, 30, 4, 0), Kind::Emoji, &limits()).unwrap();
        assert_eq!(out.mime, "image/gif");
        assert!(out.animated);
        assert_eq!(out.frames, 4);
        assert_eq!(out.format(), "gif");
        assert_eq!((out.width, out.height), (40, 30));
        assert_eq!(delays_ticks(&out.bytes), vec![10, 10, 10, 10]);

        let out = normalize(&gif_bytes(40, 30, 3, 30), Kind::Emoji, &limits()).unwrap();
        assert_eq!(delays_ticks(&out.bytes), vec![3, 3, 3]);

        let out = normalize(&gif_bytes(40, 30, 2, 60_000), Kind::Emoji, &limits()).unwrap();
        assert_eq!(delays_ticks(&out.bytes), vec![1000, 1000], "delays are clamped to ten seconds");

        let decoder = GifDecoder::new(Cursor::new(&out.bytes[..])).unwrap();
        let frames: Vec<_> = decoder.into_frames().collect::<Result<_, _>>().unwrap();
        assert_eq!(frames.len(), 2);
        for (frame, want) in frames.iter().zip([[0u8, 255, 60, 255], [40, 215, 60, 255]]) {
            let got = frame.buffer().get_pixel(0, 0).0;
            for c in 0..4 {
                assert!(got[c].abs_diff(want[c]) <= 2, "got {got:?}, want {want:?}");
            }
        }
    }

    #[test]
    fn delays_are_normalized_the_way_a_browser_shows_them() {
        let ms = |n: u32| ticks(Delay::from_numer_denom_ms(n, 1));
        assert_eq!(ms(0), 10, "zero is the browser's 100 ms");
        assert_eq!(ms(9), 10, "so is anything under 10 ms");
        assert_eq!(ms(10), 2, "10 ms is real, and floored to 20 ms");
        assert_eq!(ms(20), 2);
        assert_eq!(ms(25), 3, "rounded to the tick, never truncated below the floor");
        assert_eq!(ms(34), 3);
        assert_eq!(ms(35), 4);
        assert_eq!(ms(10_000), 1000);
        assert_eq!(ms(60_000), 1000, "clamped to ten seconds");
        assert_eq!(ticks(Delay::from_numer_denom_ms(1000, 20)), 5, "an APNG's 1/20 s");
    }

    #[test]
    fn a_one_frame_gif_is_a_still_png() {
        let out = normalize(&gif_bytes(20, 20, 1, 100), Kind::Emoji, &limits()).unwrap();
        assert_eq!(out.mime, "image/png");
        assert!(!out.animated);
    }

    #[test]
    fn an_oversized_animation_is_downscaled_frame_by_frame() {
        let out = normalize(&gif_bytes(512, 256, 3, 50), Kind::Emoji, &limits()).unwrap();
        assert!(out.animated);
        assert_eq!((out.width, out.height), (128, 64));
        let decoder = GifDecoder::new(Cursor::new(&out.bytes[..])).unwrap();
        assert_eq!(decoder.dimensions(), (128, 64));
    }

    #[test]
    fn the_frame_cap_drops_the_tail_or_refuses_as_configured() {
        let bytes = gif_bytes(16, 16, 12, 50);
        let capped = Limits { max_frames: 5, ..limits() };
        let out = normalize(&bytes, Kind::Emoji, &capped).unwrap();
        assert_eq!(out.frames, 5);
        assert_eq!(delays_ticks(&out.bytes).len(), 5);

        let strict = Limits { drop_excess_frames: false, ..capped };
        assert_eq!(
            normalize(&bytes, Kind::Emoji, &strict),
            Err(Rejected::TooManyFrames { cap: 5, width: 16, height: 16 })
        );
        assert_eq!(normalize(&gif_bytes(16, 16, 5, 50), Kind::Emoji, &strict).unwrap().frames, 5);
    }

    #[test]
    fn the_duration_cap_drops_the_tail_or_refuses_as_configured() {
        let bytes = gif_bytes(16, 16, 10, 100);
        let capped = Limits { max_duration_ms: 350, ..limits() };
        let out = normalize(&bytes, Kind::Emoji, &capped).unwrap();
        assert_eq!(out.frames, 3, "three 100 ms frames fit in 350 ms");

        let strict = Limits { drop_excess_frames: false, ..capped };
        assert_eq!(normalize(&bytes, Kind::Emoji, &strict), Err(Rejected::TooLong { cap_ms: 350 }));
    }

    #[test]
    fn the_work_budget_lowers_the_frame_cap_for_a_big_canvas() {
        let bytes = gif_bytes(256, 256, 8, 50);
        let tight = Limits { max_total_pixels: 65536 * 4, ..limits() };
        assert_eq!(normalize(&bytes, Kind::Emoji, &tight).unwrap().frames, 4);
        let strict = Limits { drop_excess_frames: false, ..tight };
        assert_eq!(
            normalize(&bytes, Kind::Emoji, &strict),
            Err(Rejected::TooManyFrames { cap: 4, width: 256, height: 256 })
        );
    }

    #[test]
    fn the_same_input_always_produces_the_same_bytes() {
        let still = png_bytes(&picture(300, 200));
        let a = normalize(&still, Kind::Emoji, &limits()).unwrap();
        let b = normalize(&still, Kind::Emoji, &limits()).unwrap();
        assert_eq!(a, b);

        let moving = gif_bytes(200, 150, 6, 40);
        let a = normalize(&moving, Kind::Sticker, &limits()).unwrap();
        let b = normalize(&moving, Kind::Sticker, &limits()).unwrap();
        assert_eq!(a, b);

        let photo = jpeg_bytes(300, 300);
        assert_eq!(
            normalize(&photo, Kind::Emoji, &limits()).unwrap(),
            normalize(&photo, Kind::Emoji, &limits()).unwrap()
        );
    }

    #[test]
    fn metadata_does_not_survive() {
        let source = picture(32, 32);
        let mut with_text = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut with_text, 32, 32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.add_text_chunk("Comment".into(), "made by a person".into()).unwrap();
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(source.as_raw()).unwrap();
        }
        let mut with_profile = Vec::new();
        {
            let mut info = png::Info::with_size(32, 32);
            info.icc_profile = Some(Cow::Owned(vec![0u8; 64]));
            info.exif_metadata = Some(Cow::Owned(b"MM\x00\x2a\x00\x00\x00\x08".to_vec()));
            let mut encoder = png::Encoder::with_info(&mut with_profile, info).unwrap();
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(source.as_raw()).unwrap();
        }
        assert!(png_chunks(&with_text).contains(&"tEXt".to_string()), "the fixture carries text");
        let chunks = png_chunks(&with_profile);
        assert!(chunks.contains(&"iCCP".to_string()) && chunks.contains(&"eXIf".to_string()), "{chunks:?}");

        let plain = normalize(&png_bytes(&source), Kind::Emoji, &limits()).unwrap();
        assert_eq!(png_chunks(&plain.bytes), vec!["IHDR", "IDAT", "IEND"]);
        for bytes in [with_text, with_profile] {
            let normalized = normalize(&bytes, Kind::Emoji, &limits()).unwrap();
            assert_eq!(png_chunks(&normalized.bytes), vec!["IHDR", "IDAT", "IEND"]);
            assert_eq!(decode(&normalized.bytes).into_rgba8(), source);
            assert_eq!(normalized.bytes, plain.bytes);
        }
    }

    #[test]
    fn a_still_webp_and_an_apng_are_read_by_their_bytes() {
        let source = picture(50, 50);
        let mut webp = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(source.clone()).write_to(&mut webp, ImageFormat::WebP).unwrap();
        let out = normalize(webp.get_ref(), Kind::Emoji, &limits()).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!(decode(&out.bytes).into_rgba8(), source, "the image crate's WebP is lossless");

        let mut apng = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut apng, 24, 24);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_animated(3, 0).unwrap();
            encoder.set_frame_delay(1, 20).unwrap();
            let mut writer = encoder.write_header().unwrap();
            for i in 0..3u8 {
                let frame = RgbaImage::from_pixel(24, 24, Rgba([i * 80, 20, 200, 255]));
                writer.write_image_data(frame.as_raw()).unwrap();
            }
        }
        let out = normalize(&apng, Kind::Emoji, &limits()).unwrap();
        assert_eq!(out.mime, "image/gif", "an APNG is an animation and is stored as one");
        assert!(out.animated);
        assert_eq!(out.frames, 3);
        assert_eq!(delays_ticks(&out.bytes), vec![5, 5, 5]);
    }

    #[test]
    fn fitted_keeps_the_shape_and_never_grows() {
        assert_eq!(fitted(100, 50, 128, 128), (100, 50));
        assert_eq!(fitted(256, 128, 128, 128), (128, 64));
        assert_eq!(fitted(128, 256, 128, 128), (64, 128));
        assert_eq!(fitted(1000, 1, 128, 128), (128, 1));
        assert_eq!(fitted(1, 1000, 128, 128), (1, 128));
        assert_eq!(fitted(4096, 4096, 320, 320), (320, 320));
    }

    fn delays_ticks(bytes: &[u8]) -> Vec<u16> {
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::Indexed);
        let mut reader = options.read_info(Cursor::new(bytes)).unwrap();
        let mut delays = Vec::new();
        while let Some(frame) = reader.read_next_frame().unwrap() {
            delays.push(frame.delay);
        }
        delays
    }

    fn crc32(kind: &[u8], data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in kind.iter().chain(data) {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }
}
