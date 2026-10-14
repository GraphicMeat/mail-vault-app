// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/generators/utils/matrix.ts, src/generators/svg-filter.ts, src/utils/math.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::color::{clamp, js_round, js_to_fixed};
use super::Theme;

pub type Matrix5 = [[f64; 5]; 5];

const IDENTITY: Matrix5 = [
    [1.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 1.0],
];

fn multiply(a: &Matrix5, b: &Matrix5) -> Matrix5 {
    let mut out = [[0.0; 5]; 5];
    for i in 0..5 {
        for j in 0..5 {
            let mut sum = 0.0;
            for k in 0..5 {
                sum += a[i][k] * b[k][j];
            }
            out[i][j] = sum;
        }
    }
    out
}

fn invert_n_hue() -> Matrix5 {
    [
        [0.333, -0.667, -0.667, 0.0, 1.0],
        [-0.667, 0.333, -0.667, 0.0, 1.0],
        [-0.667, -0.667, 0.333, 0.0, 1.0],
        [0.0, 0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 1.0],
    ]
}

fn brightness(v: f64) -> Matrix5 {
    let mut m = IDENTITY;
    m[0][0] = v;
    m[1][1] = v;
    m[2][2] = v;
    m
}

fn contrast(v: f64) -> Matrix5 {
    let t = (1.0 - v) / 2.0;
    let mut m = brightness(v);
    m[0][4] = t;
    m[1][4] = t;
    m[2][4] = t;
    m
}

fn sepia(v: f64) -> Matrix5 {
    let w = 1.0 - v;
    [
        [0.393 + 0.607 * w, 0.769 - 0.769 * w, 0.189 - 0.189 * w, 0.0, 0.0],
        [0.349 - 0.349 * w, 0.686 + 0.314 * w, 0.168 - 0.168 * w, 0.0, 0.0],
        [0.272 - 0.272 * w, 0.534 - 0.534 * w, 0.131 + 0.869 * w, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 1.0],
    ]
}

fn grayscale(v: f64) -> Matrix5 {
    let w = 1.0 - v;
    [
        [0.2126 + 0.7874 * w, 0.7152 - 0.7152 * w, 0.0722 - 0.0722 * w, 0.0, 0.0],
        [0.2126 - 0.2126 * w, 0.7152 + 0.2848 * w, 0.0722 - 0.0722 * w, 0.0, 0.0],
        [0.2126 - 0.2126 * w, 0.7152 - 0.7152 * w, 0.0722 + 0.9278 * w, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 1.0],
    ]
}

/// `createFilterMatrix(config)`; `mode` is the theme's own (1 adds invert).
pub fn create_filter_matrix(t: &Theme) -> Matrix5 {
    let mut m = IDENTITY;
    if t.sepia != 0.0 {
        m = multiply(&m, &sepia(t.sepia / 100.0));
    }
    if t.grayscale != 0.0 {
        m = multiply(&m, &grayscale(t.grayscale / 100.0));
    }
    if t.contrast != 100.0 {
        m = multiply(&m, &contrast(t.contrast / 100.0));
    }
    if t.brightness != 100.0 {
        m = multiply(&m, &brightness(t.brightness / 100.0));
    }
    if t.mode == 1 {
        m = multiply(&m, &invert_n_hue());
    }
    m
}

pub fn apply_color_matrix([r, g, b]: [f64; 3], m: &Matrix5) -> [f64; 3] {
    let v = [r / 255.0, g / 255.0, b / 255.0, 1.0, 1.0];
    let mut out = [0.0; 3];
    for i in 0..3 {
        let sum: f64 = (0..5).map(|k| m[i][k] * v[k]).sum();
        out[i] = clamp(js_round(sum * 255.0), 0.0, 255.0);
    }
    out
}

/// `getSVGFilterMatrixValue`: the first four rows, `toFixed(3)`, space-joined.
pub fn svg_filter_matrix_value(t: &Theme) -> String {
    let m = create_filter_matrix(t);
    m[..4].iter().flat_map(|row| row.iter().map(|x| js_to_fixed(*x, 3))).collect::<Vec<_>>().join(" ")
}
