//! The worker's fonts. One master `FontContext` (system fonts, blitz's bullet
//! font, plus every Google Font family the daemon sent) that every document
//! gets a clone of. blitz keeps a document's context private
//! (`BaseDocument.font_ctx` is pub(crate)), so a family that arrives later is
//! applied by rebuilding the documents that name it (worker.rs).
use blitz_dom::FontContext;
use parley::fontique::{
    Blob, Collection, CollectionOptions, FontInfo, FontInfoOverride, FontStyle, FontWeight, SourceCache, SourceId, SourceInfo, SourceKind,
};
use std::collections::BTreeSet;
use std::sync::Arc;

pub struct FaceData {
    pub data: Vec<u8>,
    pub weight: u16,
    pub style: String,
}

pub struct FontLibrary {
    ctx: FontContext,
    families: BTreeSet<String>, // lowercased
}

impl FontLibrary {
    /// Mirrors blitz's default construction (document.rs:399-410): the same
    /// collection options and the bullet font, or list markers draw nothing.
    pub fn new(system_fonts: bool) -> Self {
        let mut ctx = FontContext {
            source_cache: SourceCache::new_shared(),
            collection: Collection::new(CollectionOptions { shared: false, system_fonts }),
        };
        ctx.collection.register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT)), None);
        Self { ctx, families: BTreeSet::new() }
    }

    pub fn has(&self, family: &str) -> bool {
        self.families.contains(&family.to_lowercase())
    }

    /// Registers `faces` as `family`. True when the family was not known yet.
    pub fn register(&mut self, family: &str, faces: Vec<FaceData>) -> bool {
        let new = self.families.insert(family.to_lowercase());
        if !new {
            return false;
        }
        // fontique gives a family one font per weight and style: the first one
        // registered for an exact weight, the last of a tie for a near one. A
        // css2 family comes as several subset files per weight (latin-ext is
        // listed before latin), so only the subset that draws the most Basic
        // Latin is kept; the other subsets' letters go to the next family in
        // the stack.
        let mut kept: Vec<(u16, bool, Blob<u8>, Scan)> = Vec::new();
        // The same file arrives once per weight for a variable family (Lora: two
        // files, eight faces): decoded and scanned once, matched on the raw bytes.
        let mut seen: Vec<(Vec<u8>, Blob<u8>, Scan)> = Vec::new();
        for face in faces {
            let (blob, scan) = match seen.iter().find(|(raw, ..)| *raw == face.data) {
                Some((_, blob, scan)) => (blob.clone(), *scan),
                None => {
                    // register_fonts does not decode WOFF/WOFF2 itself.
                    let blob = decode(&face.data);
                    let scan = scan(&blob);
                    seen.push((face.data, blob.clone(), scan));
                    (blob, scan)
                }
            };
            let italic = face.style == "italic";
            match kept.iter().position(|(w, i, ..)| *w == face.weight && *i == italic) {
                None => kept.push((face.weight, italic, blob, scan)),
                Some(at) if scan.latin > kept[at].3.latin => kept[at] = (face.weight, italic, blob, scan),
                Some(_) => {}
            }
        }
        // A variable file listed once per weight is registered once, at its
        // own weight: fontique then sets `wght` for every other weight asked
        // for. Registered as each weight, each would be an exact match drawn
        // at the file's default instance, so 700 would draw as 400.
        let mut variable: Vec<(bool, Blob<u8>)> = Vec::new();
        for (weight, italic, blob, scan) in kept {
            if scan.weight_axis {
                if variable.iter().any(|(i, b)| *i == italic && b.as_ref() == blob.as_ref()) {
                    continue;
                }
                variable.push((italic, blob.clone()));
            }
            self.ctx.collection.register_fonts(
                blob,
                Some(FontInfoOverride {
                    family_name: Some(family),
                    weight: (!scan.weight_axis).then(|| FontWeight::new(weight as f32)),
                    style: Some(if italic { FontStyle::Italic } else { FontStyle::Normal }),
                    ..Default::default()
                }),
            );
        }
        true
    }

    /// An independent clone: families registered later do not reach it.
    pub fn context(&self) -> FontContext {
        self.ctx.clone()
    }
}

#[cfg(test)]
thread_local! {
    static DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn decode(data: &[u8]) -> Blob<u8> {
    #[cfg(test)]
    DECODES.with(|c| c.set(c.get() + 1));
    Blob::new(Arc::new(blitz_dom::decode_font_bytes(data).into_owned()))
}

#[derive(Clone, Copy)]
struct Scan {
    /// How many of U+0020..=U+00FF (Basic Latin and Latin-1) the font maps:
    /// nearly all of them in a latin subset, few or none in a latin-ext one.
    /// Digits, punctuation and accents count, not just the letters.
    latin: usize,
    weight_axis: bool,
}

fn scan(blob: &Blob<u8>) -> Scan {
    let source = SourceInfo::new(SourceId::new(), SourceKind::Memory(blob.clone()));
    let Some(info) = FontInfo::from_source(source, 0) else { return Scan { latin: 0, weight_axis: false } };
    let latin = info
        .charmap_index()
        .charmap(blob.as_ref())
        .map_or(0, |map| (0x20u32..=0xFF).filter_map(char::from_u32).filter(|c| map.map(*c).is_some()).count());
    Scan { latin, weight_axis: info.has_weight_axis() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/../src/assets/fonts/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }
    fn scan_of(name: &str) -> Scan {
        scan(&decode(&asset(name)))
    }

    #[test]
    fn coverage_counts_punctuation_and_accents_not_just_alphanumerics() {
        let latin = scan_of("ibm-plex-mono-latin-400.woff2").latin;
        let ext = scan_of("ibm-plex-mono-latin-ext-400.woff2").latin;
        assert!(latin > 62, "more than the 62 alphanumerics: {latin}");
        assert!(latin > ext + 100, "latin {latin} vs latin-ext {ext}");
    }

    #[test]
    fn a_variable_file_sent_once_per_weight_is_decoded_once() {
        let faces = |name: &str| [400, 500, 600, 700].map(|w| FaceData { data: asset(name), weight: w, style: "normal".into() });
        let mut lib = FontLibrary::new(false);
        let before = DECODES.with(|c| c.get());
        let mut all: Vec<FaceData> = faces("source-sans-3-latin.woff2").into();
        all.extend(faces("source-sans-3-latin-ext.woff2"));
        lib.register("MV Var", all);
        assert_eq!(DECODES.with(|c| c.get()) - before, 2, "one decode per distinct file");
    }
}
