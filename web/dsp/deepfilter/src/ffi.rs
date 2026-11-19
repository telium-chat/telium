//! The whole interface Telium's audio worklet sees: a handful of `extern "C"` functions over linear memory. No wasm-bindgen glue, because an AudioWorkletGlobalScope has no TextDecoder and the glue assumes one.
//!
//! Every pointer is into this module's own memory. The worklet allocates with `df_alloc`, writes into it, and reads results back out of it; nothing crosses the boundary by reference to the JS heap.

use std::slice;

use ndarray::prelude::*;

use crate::tract::{DfParams, DfTract, RuntimeParams};

/// A buffer the caller fills or reads. Capacity is the length, and it is returned with `df_free`.
#[no_mangle]
pub extern "C" fn df_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` and `len` must be exactly what `df_alloc` returned and was asked for.
#[no_mangle]
pub unsafe extern "C" fn df_free(pointer: *mut u8, len: usize) {
    if !pointer.is_null() {
        drop(Vec::from_raw_parts(pointer, 0, len.max(1)));
    }
}

/// Builds a mono model from the bytes of an upstream `DeepFilterNet3_onnx.tar.gz`. `atten_lim_db` caps how far noise is pushed down (100 is "no cap"). Null when the model cannot be read or started.
///
/// # Safety
/// `model` must point at `model_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn df_create(model: *const u8, model_len: usize, atten_lim_db: f32) -> *mut DfTract {
    let bytes = slice::from_raw_parts(model, model_len);
    let Ok(params) = DfParams::from_bytes(bytes) else { return std::ptr::null_mut() };
    let runtime = RuntimeParams::default_with_ch(1).with_atten_lim(atten_lim_db);
    match DfTract::new(params, &runtime) {
        Ok(state) => Box::into_raw(Box::new(state)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Samples per call to `df_process` (480 at 48 kHz, which is 10 ms).
///
/// # Safety
/// `state` must come from `df_create`.
#[no_mangle]
pub unsafe extern "C" fn df_frame_len(state: *const DfTract) -> usize {
    (*state).hop_size
}

/// Cleans one frame. `input` and `output` are each `df_frame_len` floats and may not overlap. Returns the frame's estimated local SNR in dB, or NaN when processing failed (the output is then a copy of the input).
///
/// # Safety
/// `state` must come from `df_create`; both pointers must cover a frame.
#[no_mangle]
pub unsafe extern "C" fn df_process(state: *mut DfTract, input: *const f32, output: *mut f32) -> f32 {
    let state = &mut *state;
    let hop = state.hop_size;
    let noisy = slice::from_raw_parts(input, hop);
    let out = slice::from_raw_parts_mut(output, hop);
    let Ok(view) = ArrayView2::from_shape((1, hop), noisy) else {
        out.copy_from_slice(noisy);
        return f32::NAN;
    };
    let mut enhanced = Array2::<f32>::zeros((1, hop));
    match state.process(view, enhanced.view_mut()) {
        Ok(lsnr) => {
            out.copy_from_slice(enhanced.as_slice().unwrap_or(noisy));
            lsnr
        }
        Err(_) => {
            out.copy_from_slice(noisy);
            f32::NAN
        }
    }
}

/// # Safety
/// `state` must come from `df_create` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn df_destroy(state: *mut DfTract) {
    if !state.is_null() {
        drop(Box::from_raw(state));
    }
}

/// Hash-table seeding inside tract is the only thing that asks for randomness, and nothing here depends on it being unpredictable: the model is fixed, trusted input and the process never faces a hostile key. A fixed xorshift stream keeps the module free of any JavaScript import.
#[cfg(target_arch = "wasm32")]
fn fill_random(buffer: &mut [u8]) -> Result<(), getrandom::Error> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static STATE: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);
    for byte in buffer {
        let mut x = STATE.load(Ordering::Relaxed);
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        STATE.store(x, Ordering::Relaxed);
        *byte = (x >> 32) as u8;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), getrandom::Error> {
    // The buffer may be uninitialised: zero it before taking a slice.
    core::ptr::write_bytes(dest, 0, len);
    fill_random(core::slice::from_raw_parts_mut(dest, len))
}
