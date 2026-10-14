//! The Rust port against Dark Reader 4.9.120's own output (Task 10 vectors).
use mailvault_render::dark::color::{dr_to_fixed, hsl_to_rgb, js_to_fixed, parse_color, rgb_to_hex_string, rgb_to_hsl, rgb_to_string, Hsla, Rgba};
use mailvault_render::dark::matrix::svg_filter_matrix_value;
use mailvault_render::dark::modify_colors::{modify_background_color, modify_border_color, modify_foreground_color};
use mailvault_render::dark::Theme;
use serde_json::Value;
use std::collections::HashMap;

fn vectors() -> Value {
    let p = format!("{}/tests/fixtures/dr/vectors.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn rgba(v: &Value) -> Rgba {
    Rgba { r: v["r"].as_f64().unwrap(), g: v["g"].as_f64().unwrap(), b: v["b"].as_f64().unwrap(), a: v["a"].as_f64().unwrap_or(1.0) }
}
fn themes(v: &Value) -> HashMap<String, Theme> {
    v["themes"].as_object().unwrap().iter().map(|(k, t)| (k.clone(), serde_json::from_value(t.clone()).unwrap())).collect()
}

#[test]
fn js_number_formatting() {
    assert_eq!(js_to_fixed(0.125, 2), "0.13");
    assert_eq!(js_to_fixed(0.005, 2), "0.01");
    assert_eq!(js_to_fixed(0.995, 2), "0.99");
    assert_eq!(js_to_fixed(2.5, 0), "3");
    assert_eq!(dr_to_fixed(0.5, 2), "0.5");
    assert_eq!(dr_to_fixed(1.0, 2), "1");
    assert_eq!(dr_to_fixed(100.0, 2), "100");
}

#[test]
fn parse_matches_dark_reader() {
    let v = vectors();
    let mut checked = 0;
    for case in v["parse"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let got = parse_color(input);
        match &case["out"] {
            Value::String(s) if s == "skipped:dom" => assert_eq!(got, None, "{input}: DOM-parsed colours are harness-only"),
            Value::Null => assert_eq!(got, None, "{input}"),
            out => assert_eq!(got, Some(rgba(out)), "{input}"),
        }
        checked += 1;
    }
    assert!(checked > 600, "only {checked} parse vectors");
}

#[test]
fn hsl_round_trips_match() {
    let v = vectors();
    for case in v["hsl"].as_array().unwrap() {
        let h = rgb_to_hsl(rgba(&case["rgb"]));
        let want = &case["hsl"];
        for (got, key) in [(h.h, "h"), (h.s, "s"), (h.l, "l"), (h.a, "a")] {
            assert!((got - want[key].as_f64().unwrap()).abs() < 1e-12, "{key} of {:?}", case["rgb"]);
        }
        let back = hsl_to_rgb(Hsla { h: want["h"].as_f64().unwrap(), s: want["s"].as_f64().unwrap(), l: want["l"].as_f64().unwrap(), a: want["a"].as_f64().unwrap_or(1.0) });
        assert_eq!(back, rgba(&case["back"]));
    }
}

#[test]
fn colour_strings_match() {
    let v = vectors();
    for case in v["strings"].as_array().unwrap() {
        let c = rgba(&case["rgb"]);
        assert_eq!(rgb_to_string(c), case["rgbString"].as_str().unwrap(), "{:?}", case["rgb"]);
        assert_eq!(rgb_to_hex_string(c), case["hexString"].as_str().unwrap(), "{:?}", case["rgb"]);
    }
}

#[test]
fn modify_colours_match_for_every_theme() {
    let v = vectors();
    let t = themes(&v);
    let mut n = 0;
    for case in v["modify"].as_array().unwrap() {
        let theme = &t[case["theme"].as_str().unwrap()];
        let input = case["input"].as_str().unwrap();
        let c = parse_color(input).unwrap();
        assert_eq!(modify_background_color(c, theme), case["bg"].as_str().unwrap(), "bg {input} {}", case["theme"]);
        assert_eq!(modify_foreground_color(c, theme), case["fg"].as_str().unwrap(), "fg {input} {}", case["theme"]);
        assert_eq!(modify_border_color(c, theme), case["border"].as_str().unwrap(), "border {input} {}", case["theme"]);
        n += 1;
    }
    assert!(n > 2000);
}

#[test]
fn image_filter_matrix_matches() {
    let v = vectors();
    let t = themes(&v);
    for case in v["matrix"].as_array().unwrap() {
        let theme = &t[case["theme"].as_str().unwrap()];
        assert_eq!(svg_filter_matrix_value(theme), case["svg"].as_str().unwrap());
        let sepia = Theme { sepia: (theme.sepia + 10.0).min(100.0), ..theme.clone() };
        assert_eq!(svg_filter_matrix_value(&sepia), case["svgSepia10"].as_str().unwrap());
    }
}

#[test]
fn known_values_from_the_feasibility_run() {
    let t = Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0);
    let c = |s: &str| parse_color(s).unwrap();
    assert_eq!(modify_background_color(c("#ffffff"), &t), "#0a0a12");
    assert_eq!(modify_foreground_color(c("#000000"), &t), "#e8e8ef");
    assert_eq!(modify_foreground_color(c("#e6375a"), &t), "#e84767");
    assert_eq!(modify_background_color(c("#0066cc"), &t), "#0052a3");
    assert_eq!(modify_border_color(c("#cccccc"), &t), "#2f2f55");
    assert_eq!(modify_background_color(c("rgba(0, 0, 0, 0.125)"), &t), "rgba(0, 0, 0, 0.13)");
    assert_eq!(parse_color("rgb(100%, 50%, 0%)"), Some(Rgba { r: 255.0, g: 127.0, b: 0.0, a: 1.0 }));
}

#[test]
fn palette_registers_the_variables_dark_reader_writes() {
    use mailvault_render::dark::modify_colors::{ColorType, Palette};
    let v = vectors();
    let t = themes(&v);
    let c = |s: &str| parse_color(s).unwrap();
    for case in v["static"].as_array().unwrap() {
        let theme = &t[case["theme"].as_str().unwrap()];
        let text = format!("{}{}", case["userAgent"].as_str().unwrap(), case["variables"].as_str().unwrap());
        let mut p = Palette::default();
        assert_eq!(p.get(ColorType::Text, c("#000")), None);
        // Selection colours come from DR's own selection path (Task 12), not from here.
        let got = [
            p.border(c("#4c4c4c"), theme),
            p.fg(c("#000000"), theme),
            p.fg(c("#0040ff"), theme),
            p.border(c("#808080"), theme),
            p.fg(c("#a9a9a9"), theme),
            p.bg(c("#faffbd"), theme),
            p.bg(c("#ffffff"), theme),
        ];
        for s in &got {
            assert!(text.contains(s.as_str()), "{} {s}", case["theme"]);
        }
        // A second ask answers from the registry; shadow and gradient are bg.
        assert_eq!(p.get(ColorType::Text, c("#000000")), Some(got[1].clone()));
        assert_eq!(p.bg(c("#ffffff"), theme), got[6]);
        assert_eq!(p.shadow(c("#ffffff"), theme), got[6]);
        assert_eq!(p.gradient(c("#ffffff"), theme), got[6]);
        let decls = p.root_declarations();
        assert_eq!(decls.len(), 7);
        // Per hex in insertion order, then background, text, border.
        assert_eq!(decls[0].0, "--darkreader-border-4c4c4c");
        assert_eq!(decls[1].0, "--darkreader-text-000000");
    }
}
