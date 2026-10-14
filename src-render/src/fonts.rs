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
        for face in faces {
            // register_fonts does not decode WOFF/WOFF2 itself.
            let blob = Blob::new(Arc::new(blitz_dom::decode_font_bytes(&face.data).into_owned()));
            let italic = face.style == "italic";
            let scan = scan(&blob);
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

#[derive(Clone, Copy)]
struct Scan {
    /// How many of A-Z, a-z and 0-9 the font maps: all of them in a latin
    /// subset, few or none in a latin-ext one.
    latin: usize,
    weight_axis: bool,
}

fn scan(blob: &Blob<u8>) -> Scan {
    let source = SourceInfo::new(SourceId::new(), SourceKind::Memory(blob.clone()));
    let Some(info) = FontInfo::from_source(source, 0) else { return Scan { latin: 0, weight_axis: false } };
    let latin = info
        .charmap_index()
        .charmap(blob.as_ref())
        .map_or(0, |map| ('A'..='Z').chain('a'..='z').chain('0'..='9').filter(|c| map.map(*c).is_some()).count());
    Scan { latin, weight_axis: info.has_weight_axis() }
}
